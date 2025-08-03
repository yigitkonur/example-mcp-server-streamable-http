/**
 * @file src/types.ts
 * @description This file contains all core data structures, interfaces, and Zod schemas
 * for the Stateful MCP Calculator Server. It serves as the single source of truth for the
 * shapes of data used throughout the application, ensuring consistency and type safety.
 *
 * This separation follows the principle of separating data contracts from business logic,
 * making the codebase more maintainable and providing a clear overview of the system's
 * data architecture.
 *
 * Key Error Handling Ideas:
 * - Defines a hierarchy of custom `CalculatorServerError` types that extend `McpError`.
 * - Centralizes all Zod schemas, which are the first line of defense for validating
 *   incoming data and preventing type-related errors.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// =================================================================
// CORE INTERFACES AND DATA STRUCTURES
// =================================================================

/**
 * @interface ISessionStore
 * @description Defines the contract for a session storage mechanism. This is a key part
 * of the **Strategy Pattern**, allowing us to swap storage backends (e.g., in-memory vs. Redis)
 * without changing the core application logic that uses it.
 *
 * The Strategy Pattern is fundamental to this architecture:
 * - The client code (server logic) depends only on this interface
 * - Concrete implementations (InMemorySessionStore, RedisSessionStore) provide the actual storage
 * - This enables runtime switching between storage modes without code changes
 * - Critical for supporting both development (no Redis) and production (Redis cluster) environments
 */
export interface ISessionStore {
  /**
   * Retrieve session data by session ID
   * @param sessionId - Unique identifier for the session
   * @returns Session data if found and not expired, null otherwise
   */
  get(sessionId: string): Promise<SessionData | null>;

  /**
   * Store or update session data
   * @param sessionId - Unique identifier for the session
   * @param data - Complete session data to store
   */
  set(sessionId: string, data: SessionData): Promise<void>;

  /**
   * Remove session data permanently
   * @param sessionId - Unique identifier for the session to delete
   */
  delete(sessionId: string): Promise<void>;

  /**
   * Update the last activity timestamp and increment request counter
   * @param sessionId - Unique identifier for the session
   */
  updateActivity(sessionId: string): Promise<void>;
}

/**
 * @interface Calculation
 * @description Represents a single, completed calculation event within a session.
 * This is part of the event sourcing pattern - each calculation is an immutable event
 * that gets appended to the session's history. This enables:
 * - Complete audit trail of all calculations
 * - Ability to replay/reconstruct session state
 * - Historical analytics and debugging capabilities
 */
export interface Calculation {
  /** Unique identifier for this specific calculation */
  id: string;

  /** Session ID this calculation belongs to */
  sessionId: string;

  /** Unix timestamp when calculation was performed */
  timestamp: number;

  /** Type of operation performed (add, subtract, multiply, etc.) */
  operation: string;

  /** Array of input values used in the calculation */
  inputs: number[];

  /** Final result of the calculation */
  result: number;
}

/**
 * @interface SessionData
 * @description Represents the complete, stateful data for a single user session.
 * This object is what gets persisted in our storage backend (memory or Redis).
 *
 * CRITICAL ARCHITECTURAL NOTE: The `transport` and `server` instances are transient
 * and NOT serialized to storage. They are reconstructed on-demand when a session
 * is accessed by a server node that doesn't have them cached locally. This is the
 * foundation of the "Just-in-Time Instance Reconstruction" pattern that enables
 * horizontal scaling without sticky sessions.
 *
 * The calculations array implements a ring buffer pattern (max 50 entries) to
 * prevent unbounded memory growth while maintaining recent history.
 */
export interface SessionData {
  /** Unique session identifier */
  sessionId: string;

  /** Transient: MCP transport instance (not persisted) */
  transport: StreamableHTTPServerTransport;

  /** Transient: MCP server instance (not persisted) */
  server: McpServer;

  /** Unix timestamp when session was created */
  startTime: number;

  /** Unix timestamp of last activity (used for timeout/cleanup) */
  lastActivity: number;

  /** Total number of requests processed in this session */
  requestCount: number;

  /** Calculation history (ring buffer, max 50 entries) */
  calculations: Calculation[];
}

/**
 * @interface TransportWithSessionId
 * @description Extension of StreamableHTTPServerTransport that includes session ID.
 * This is used internally for type safety when we manually set the sessionId property
 * during just-in-time reconstruction. The sessionId property is not part of the
 * official SDK interface but is required for our session management logic.
 */
export interface TransportWithSessionId extends StreamableHTTPServerTransport {
  sessionId: string;
}

// =================================================================
// ZOD VALIDATION SCHEMAS FOR TOOLS
// =================================================================

/**
 * These schemas serve dual purposes:
 * 1. Runtime validation of incoming tool arguments from MCP clients
 * 2. TypeScript type inference for compile-time safety
 *
 * Each schema is exported as a constant so it can be imported by the server
 * logic and referenced in tool registrations. This centralization ensures
 * consistency between validation and type definitions.
 */

/**
 * Zod schema for the 'calculate' tool arguments.
 * Validates basic arithmetic operations with optional streaming support.
 */
export const calculateArgsSchema = z.object({
  a: z.number().describe('First operand'),
  b: z.number().describe('Second operand'),
  op: z.enum(['add', 'subtract', 'multiply', 'divide']).describe('Operation to perform'),
  stream: z.boolean().optional().describe('Stream intermediate results'),
});

/**
 * Zod schema for the 'batch_calculate' tool arguments.
 * Validates arrays of calculations for batch processing.
 */
export const batchCalculateArgsSchema = z.object({
  calculations: z
    .array(
      z.object({
        a: z.number(),
        b: z.number(),
        op: z.enum(['add', 'subtract', 'multiply', 'divide']),
      }),
    )
    .describe('Array of calculations to perform'),
  reportProgress: z.boolean().optional().describe('Report progress during batch processing'),
});

/**
 * Zod schema for the 'advanced_calculate' tool arguments.
 * Validates scientific and mathematical operations.
 */
export const advancedCalculateArgsSchema = z.object({
  operation: z
    .enum(['factorial', 'power', 'sqrt', 'log', 'sin', 'cos', 'tan'])
    .describe('Advanced operation'),
  value: z.number().describe('Input value'),
  base: z.number().optional().describe('Base for power or logarithm operations'),
});

/**
 * Zod schema for the 'demo_progress' tool arguments.
 * Validates parameters for the progress notification demonstration.
 */
export const demoProgressArgsSchema = z.object({
  steps: z.number().default(5).describe('Number of progress steps'),
});

/**
 * Zod schema for the sample educational tool.
 * This is used when SAMPLE_TOOL_NAME environment variable is set.
 */
export const sampleToolArgsSchema = z.object({
  message: z.string().describe('Message to echo back'),
});

// =================================================================
// ZOD VALIDATION SCHEMAS FOR PROMPTS
// =================================================================

/**
 * These schemas validate arguments passed to registered prompts.
 * Prompts are templates that help clients generate appropriate requests
 * to the MCP server's tools and resources.
 */

/**
 * Zod schema for the 'explain-calculation' prompt arguments.
 * Validates parameters for step-by-step calculation explanations.
 */
export const explainCalculationArgsSchema = z.object({
  operation: z.string().describe('The calculation to explain'),
  level: z.string().optional().describe('Explanation level: basic, intermediate, advanced'),
});

/**
 * Zod schema for the 'generate-problems' prompt arguments.
 * Validates parameters for generating practice math problems.
 */
export const generateProblemsArgsSchema = z.object({
  topic: z.string().describe('Math topic (e.g., "fractions", "algebra", "geometry")'),
  difficulty: z.string().describe('Difficulty level: easy, medium, hard'),
  count: z.string().describe('Number of problems to generate'),
});

/**
 * Zod schema for the 'solve_math_problem' prompt arguments.
 * Validates parameters for step-by-step problem solving.
 */
export const solveMathProblemArgsSchema = z.object({
  problem: z.string().describe('The problem to solve'),
  showWork: z.string().describe('Show detailed work'),
});

/**
 * Zod schema for the 'explain_formula' prompt arguments.
 * Validates parameters for detailed formula explanations.
 */
export const explainFormulaArgsSchema = z.object({
  formula: z.string().describe('The formula to explain'),
  context: z.string().optional().describe('Application context'),
});

/**
 * Zod schema for the 'calculator_assistant' prompt arguments.
 * Validates parameters for general calculation assistance.
 */
export const calculatorAssistantArgsSchema = z.object({
  query: z.string().describe('What you need help calculating'),
});

// =================================================================
// TYPE INFERENCE FROM ZOD SCHEMAS
// =================================================================

/**
 * TypeScript types inferred from Zod schemas.
 * These provide compile-time type safety while reusing the runtime validation logic.
 * This pattern ensures that types and validation stay in sync automatically.
 */

export type CalculateArgs = z.infer<typeof calculateArgsSchema>;
export type BatchCalculateArgs = z.infer<typeof batchCalculateArgsSchema>;
export type AdvancedCalculateArgs = z.infer<typeof advancedCalculateArgsSchema>;
export type DemoProgressArgs = z.infer<typeof demoProgressArgsSchema>;
export type SampleToolArgs = z.infer<typeof sampleToolArgsSchema>;

export type ExplainCalculationArgs = z.infer<typeof explainCalculationArgsSchema>;
export type GenerateProblemsArgs = z.infer<typeof generateProblemsArgsSchema>;
export type SolveMathProblemArgs = z.infer<typeof solveMathProblemArgsSchema>;
export type ExplainFormulaArgs = z.infer<typeof explainFormulaArgsSchema>;
export type CalculatorAssistantArgs = z.infer<typeof calculatorAssistantArgsSchema>;

// =================================================================
// CONFIGURATION TYPES
// =================================================================

/**
 * @interface ServerConfig
 * @description Configuration object for the entire application.
 * Centralizes all environment-based configuration in a type-safe structure.
 * This makes configuration management explicit and easier to validate.
 */
export interface ServerConfig {
  /** HTTP server port */
  port: number;

  /** CORS allowed origin */
  corsOrigin: string;

  /** Session timeout in milliseconds */
  sessionTimeout: number;

  /** Whether to use Redis for distributed storage */
  useRedis: boolean;

  /** Redis connection URL */
  redisUrl: string;

  /** Logging level */
  logLevel: string;

  /** Rate limiting configuration */
  rateLimit: {
    windowMs: number;
    max: number;
  };
}

// =================================================================
// CUSTOM APPLICATION-SPECIFIC ERRORS
// =================================================================

/**
 * @summary Base class for all custom errors within this application.
 * @remarks Extending McpError ensures that our custom errors are compatible with
 * the MCP protocol's error-handling mechanisms. This allows us to catch
 * and handle application-specific failures with more granularity.
 */
export class CalculatorServerError extends McpError {
  constructor(
    code: number,
    message: string,
    public readonly context?: unknown,
  ) {
    super(code, message, context);
    this.name = this.constructor.name;
  }
}

/**
 * @summary Thrown when a requested session does not exist, has expired, or is invalid.
 * @remarks This error is critical for the HTTP layer to distinguish between a
 * generic bad request and a specific session lifecycle failure. It typically
 * results in the client being instructed to re-initialize.
 */
export class SessionNotFoundError extends CalculatorServerError {
  constructor(message: string, context?: { sessionId?: string }) {
    super(ErrorCode.InvalidRequest, message, context);
  }
}

/**
 * @summary Thrown when a persistent storage operation (e.g., Redis read/write) fails.
 * @remarks This error wraps the underlying database or network error, preventing
 * implementation details from leaking to the client. The original error
 * should be logged on the server for debugging. This typically results
 * in a generic `InternalError` being sent to the client.
 */
export class StorageOperationFailedError extends CalculatorServerError {
  constructor(
    message: string,
    public readonly originalError: Error,
    context?: unknown,
  ) {
    super(ErrorCode.InternalError, message, context);
  }
}
