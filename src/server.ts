/**
 * @file src/server.ts
 * @description Main application file for the Stateful MCP Calculator Server.
 * This file includes storage implementations, the Express web server setup,
 * the MCP server factory, and the application's entry point.
 *
 * This refactored structure separates concerns while maintaining the complete
 * functionality of the hybrid storage architecture. Every piece of code is
 * documented to explain not just WHAT it does, but WHY it exists and how it
 * fits into the larger architectural patterns.
 *
 * Key Error Handling Ideas:
 * - **Boundary Control:** Uses a global Express error handler as a final catch-all to prevent
 *   leaking stack traces and to ensure all responses are valid JSON-RPC errors.
 * - **Error Specificity:** Throws specific custom errors (e.g., `SessionNotFoundError`) for
 *   predictable failure modes. Generic errors are wrapped in `StorageOperationFailedError`.
 * - **Fail-Fast Validation:** Tool and resource handlers aggressively validate inputs and session
 *   state, throwing errors early in the request lifecycle.
 * - **TSDoc `@throws` Annotations:** Every function that can fail is documented with the
 *   specific error types it can throw, creating a clear contract for consumers.
 */

import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import IORedis from 'ioredis';
import type { Redis, RedisOptions } from 'ioredis';
import { register as prometheusRegister, Counter, Gauge } from 'prom-client';

// MCP SDK imports
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type {
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
  JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import type { EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Import all types and schemas from our data contract layer
import {
  calculateArgsSchema,
  batchCalculateArgsSchema,
  advancedCalculateArgsSchema,
  demoProgressArgsSchema,
  sampleToolArgsSchema,
  explainCalculationArgsSchema,
  generateProblemsArgsSchema,
  solveMathProblemArgsSchema,
  explainFormulaArgsSchema,
  CalculatorServerError,
  SessionNotFoundError,
  StorageOperationFailedError,
  calculatorAssistantArgsSchema,
} from './types.js';
import type {
  ISessionStore,
  SessionData,
  Calculation,
  TransportWithSessionId,
  ServerConfig,
  CalculateArgs,
  BatchCalculateArgs,
  AdvancedCalculateArgs,
  DemoProgressArgs,
  SampleToolArgs,
  ExplainCalculationArgs,
  GenerateProblemsArgs,
  SolveMathProblemArgs,
  ExplainFormulaArgs,
  CalculatorAssistantArgs,
} from './types.js';

// =================================================================
// SECTION 1: GLOBAL STATE AND CONFIGURATION
// =================================================================

/**
 * Application configuration derived from environment variables.
 * This centralizes all configuration in a single, type-safe object.
 *
 * WHY: Having configuration scattered throughout the code makes it
 * hard to understand what can be configured and leads to inconsistencies.
 * This pattern makes configuration explicit and easily validated.
 */
const config: ServerConfig = {
  port: parseInt(process.env['PORT'] || '1453'),
  corsOrigin: process.env['CORS_ORIGIN'] || '*',
  sessionTimeout: parseInt(process.env['SESSION_TIMEOUT'] || '1800000'), // 30 minutes
  useRedis: process.env['USE_REDIS'] === 'true',
  redisUrl: process.env['REDIS_URL'] || 'redis://localhost:6379',
  logLevel: process.env['LOG_LEVEL'] || 'info',
  rateLimit: {
    windowMs: parseInt(process.env['RATE_LIMIT_WINDOW'] || '900000'), // 15 minutes
    max: parseInt(process.env['RATE_LIMIT_MAX'] || '1000'),
  },
};

/**
 * Global Redis client instance.
 * WHY: We need a single, shared Redis connection for the entire application.
 * This is initialized during startup and shared across all storage operations.
 */
let redisClient: Redis | null = null;

/**
 * Global session store instance.
 * WHY: This is the Strategy Pattern in action - we don't know at compile time
 * whether this will be an InMemorySessionStore or RedisSessionStore.
 * The concrete implementation is selected at runtime based on configuration.
 */
let sessionStore: ISessionStore;

/**
 * Global event store instance for MCP event sourcing.
 * WHY: Similar to sessionStore, this implements the Strategy Pattern for
 * event storage, allowing us to switch between in-memory and Redis-backed
 * event stores without changing the core application logic.
 */
let eventStore: EventStore;

/**
 * Prometheus metrics for observability.
 * WHY: These counters and gauges provide crucial insights into system behavior:
 * - calculationCounter: Tracks how many operations of each type we're processing
 * - activeSessionsGauge: Shows current load and helps with capacity planning
 */
const calculationCounter = new Counter({
  name: 'mcp_calculations_total',
  help: 'Total number of calculations performed',
  labelNames: ['operation'],
});

const activeSessionsGauge = new Gauge({
  name: 'mcp_active_sessions',
  help: 'Number of active sessions',
});

/**
 * In-memory cache for active MCP server and transport instances, keyed by session ID.
 *
 * CRITICAL ARCHITECTURAL NOTE: This is a LOCAL cache on each server node, NOT the
 * authoritative session store. The authoritative state lives in Redis (or in-memory
 * store for single-node). This cache exists purely for performance - reconstructing
 * MCP instances on every request would be expensive.
 *
 * WHY: This is the foundation of "Just-in-Time Instance Reconstruction". When a
 * request comes in for a session that exists in Redis but not in this local cache,
 * we reconstruct the instances and cache them here. This enables horizontal scaling
 * without sticky sessions.
 */
const sessionInstances = new Map<
  string,
  {
    transport: StreamableHTTPServerTransport;
    server: McpServer;
  }
>();

// =================================================================
// SECTION 2: STORAGE IMPLEMENTATIONS (THE STRATEGY PATTERN)
// =================================================================

/**
 * These classes are the concrete implementations of our storage abstractions.
 * They implement the Strategy Pattern, allowing us to swap storage backends
 * without changing the core application logic.
 *
 * The pattern: Application code → ISessionStore interface → Concrete implementation
 * This decoupling is what enables our hybrid architecture.
 */

/**
 * In-memory session store for single-node deployments.
 *
 * WHY: Perfect for development and small deployments where external dependencies
 * should be minimized. This implementation is simpler and faster for single-node
 * scenarios but doesn't support horizontal scaling.
 *
 * DESIGN PATTERNS:
 * - Strategy Pattern: Implements ISessionStore interface
 * - Ring Buffer: Automatic cleanup prevents memory leaks
 */
class InMemorySessionStore implements ISessionStore {
  private sessions = new Map<string, SessionData>();
  private sessionTimeout: number;

  constructor(sessionTimeoutMs: number) {
    this.sessionTimeout = sessionTimeoutMs;
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const session = this.sessions.get(sessionId);

    // Automatic expiration check - critical for preventing memory leaks
    if (session && Date.now() - session.lastActivity > this.sessionTimeout) {
      this.sessions.delete(sessionId);
      return null;
    }

    return session || null;
  }

  async set(sessionId: string, data: SessionData): Promise<void> {
    /**
     * CRITICAL: We create a clean copy without non-serializable parts.
     * The transport and server instances are NOT stored here - they're
     * transient and cached separately in sessionInstances.
     *
     * WHY: This separation is key to the just-in-time reconstruction pattern.
     * We store only the data that defines the session state, not the runtime
     * objects that can be recreated from that state.
     */
    const storable = {
      sessionId: data.sessionId,
      startTime: data.startTime,
      lastActivity: data.lastActivity,
      requestCount: data.requestCount,
      calculations: data.calculations,
    };
    this.sessions.set(sessionId, storable as SessionData);
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async updateActivity(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
      session.requestCount++;
    }
  }

  /**
   * Manual cleanup method for in-memory store.
   * WHY: Redis handles expiration automatically, but in-memory storage
   * requires manual cleanup to prevent unbounded memory growth.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActivity > this.sessionTimeout) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

/**
 * In-memory event store for single-node deployments.
 *
 * WHY: Events enable resumability - when a client reconnects after a network
 * issue, they can replay missed events using the Last-Event-Id header.
 * This is crucial for the stateful HTTP transport pattern.
 *
 * DESIGN PATTERNS:
 * - Event Sourcing: Complete audit trail of all interactions
 * - Ring Buffer: Bounded memory usage with configurable limits
 */
class InMemoryEventStore implements EventStore {
  private events: Map<
    string,
    {
      streamId: string;
      message: JSONRPCMessage;
      timestamp: number;
    }
  > = new Map();

  private readonly maxAge: number = 24 * 60 * 60 * 1000; // 24 hours
  private readonly maxEvents: number = 10000;

  private generateEventId(streamId: string): string {
    return `${streamId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }

  private getStreamIdFromEventId(eventId: string): string {
    const match = eventId.match(/^([a-f0-9-]{36})_(\d+)_([a-z0-9]+)$/i);
    if (!match || !match[1]) {
      console.error(`Invalid event ID format: ${eventId}`);
      return '';
    }
    return match[1];
  }

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = this.generateEventId(streamId);
    const timestamp = Date.now();

    this.events.set(eventId, {
      streamId,
      message,
      timestamp,
    });

    /**
     * Ring buffer implementation: When we exceed maxEvents, remove the oldest.
     * WHY: This prevents unbounded memory growth while maintaining recent history.
     * The trade-off: Very old events become unreplayable, but the system stays stable.
     */
    if (this.events.size > this.maxEvents) {
      const sortedEvents = [...this.events.entries()].sort(
        ([, a], [, b]) => a.timestamp - b.timestamp,
      );

      const eventsToDelete = this.events.size - this.maxEvents;
      for (let i = 0; i < eventsToDelete; i++) {
        const eventEntry = sortedEvents[i];
        if (eventEntry) {
          this.events.delete(eventEntry[0]);
        }
      }
    }

    return eventId;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    if (!lastEventId || !this.events.has(lastEventId)) {
      return '';
    }

    const streamId = this.getStreamIdFromEventId(lastEventId);
    if (!streamId) {
      return '';
    }

    /**
     * Event replay logic: Find the last event ID in our store, then send
     * all subsequent events for the same stream.
     * WHY: This enables client reconnection after network interruptions.
     */
    let foundLastEvent = false;
    const sortedEvents = [...this.events.entries()]
      .filter(([_, { streamId: sid }]) => sid === streamId)
      .sort(([a], [b]) => a.localeCompare(b));

    for (const [eventId, { message }] of sortedEvents) {
      if (eventId === lastEventId) {
        foundLastEvent = true;
        continue;
      }

      if (foundLastEvent) {
        await send(eventId, message);
      }
    }

    return streamId;
  }

  async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [eventId, { timestamp }] of this.events) {
      if (now - timestamp > this.maxAge) {
        this.events.delete(eventId);
      }
    }
  }
}

/**
 * Redis-based session store for distributed deployments.
 *
 * WHY: Redis provides the shared state necessary for horizontal scaling.
 * Multiple server nodes can all access the same session data, enabling
 * load balancing without sticky sessions.
 *
 * DESIGN PATTERNS:
 * - Strategy Pattern: Drop-in replacement for InMemorySessionStore
 * - Fail-Safe Operations: Reads fail gracefully, writes fail loudly
 */
class RedisSessionStore implements ISessionStore {
  private redis: Redis;
  private sessionTimeoutSeconds: number;

  constructor(redis: Redis, sessionTimeoutMs: number) {
    this.redis = redis;
    this.sessionTimeoutSeconds = Math.floor(sessionTimeoutMs / 1000);
  }

  async get(sessionId: string): Promise<SessionData | null> {
    try {
      const data = await this.redis.get(`mcp_session:${sessionId}`);
      if (!data) {
        return null;
      }

      const parsed = JSON.parse(data);

      /**
       * CRITICAL: Reconstruct non-serializable objects as null.
       * The transport and server instances will be set by the caller
       * during just-in-time reconstruction.
       */
      parsed.transport = null;
      parsed.server = null;
      return parsed;
    } catch (error) {
      // NOTE: On a read failure, we adopt a fail-safe philosophy. We log the
      // error but return `null` as if the session simply wasn't found. This
      // prevents a single Redis read blip from crashing the entire request.
      console.error(`Redis error getting session ${sessionId}:`, error);
      return null;
    }
  }

  async set(sessionId: string, data: SessionData): Promise<void> {
    try {
      /**
       * Create a serializable copy of the session data.
       * WHY: transport and server instances contain circular references
       * and native objects that can't be JSON.stringify'd.
       */
      const serializable = {
        sessionId: data.sessionId,
        startTime: data.startTime,
        lastActivity: data.lastActivity,
        requestCount: data.requestCount,
        calculations: data.calculations,
      };

      /**
       * Use Redis EX command for automatic expiration.
       * WHY: This is more reliable than manual cleanup and ensures
       * that abandoned sessions don't accumulate indefinitely.
       */
      await this.redis.set(
        `mcp_session:${sessionId}`,
        JSON.stringify(serializable),
        'EX',
        this.sessionTimeoutSeconds,
      );
    } catch (error) {
      /**
       * Fail-loud philosophy: If we can't write to Redis, throw an error.
       * Session state is critical - we'd rather fail fast than continue
       * with inconsistent state.
       *
       * NOTE: We wrap the raw Redis error in our custom StorageOperationFailedError.
       * This abstracts the implementation detail (that we're using Redis) from the
       * calling code and prevents leaking raw error messages. The original error is
       * passed along for detailed server-side logging.
       */
      throw new StorageOperationFailedError('Failed to save session state', error as Error, {
        sessionId,
      });
    }
  }

  async delete(sessionId: string): Promise<void> {
    try {
      await this.redis.del(`mcp_session:${sessionId}`);
    } catch (error) {
      // Deletion failures are logged but not thrown - cleanup is best-effort
      console.error(`Redis error deleting session ${sessionId}:`, error);
    }
  }

  async updateActivity(sessionId: string): Promise<void> {
    try {
      const session = await this.get(sessionId);
      if (session) {
        session.lastActivity = Date.now();
        session.requestCount++;
        await this.set(sessionId, session);
      }
    } catch (error) {
      console.error(`Redis error updating activity for session ${sessionId}:`, error);
    }
  }
}

/**
 * Redis-based Event Store implementation using Redis Streams.
 *
 * WHY: Redis Streams are purpose-built for event sourcing patterns.
 * They provide automatic ordering, efficient range queries, and
 * built-in expiration - perfect for our resumability requirements.
 *
 * DESIGN PATTERNS:
 * - Event Sourcing: Immutable event log with replay capabilities
 * - Stream Processing: Redis Streams provide ordering and efficient access
 */
class RedisEventStore implements EventStore {
  private redis: Redis;
  private readonly maxAge: number = 24 * 60 * 60 * 1000; // 24 hours
  private readonly maxEvents: number = 10000;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const streamKey = `mcp_events:${streamId}`;
    const messageData = JSON.stringify(message);

    /**
     * Use Redis XADD with MAXLEN to maintain bounded streams.
     * WHY: The '~' makes MAXLEN approximate for better performance.
     * Redis will trim the stream close to the limit when convenient.
     */
    const eventId = await this.redis.xadd(
      streamKey,
      'MAXLEN',
      '~',
      this.maxEvents.toString(),
      '*', // Auto-generate ID with timestamp ordering
      'data',
      messageData,
    );

    // Set TTL on the entire stream for automatic cleanup
    await this.redis.expire(streamKey, Math.floor(this.maxAge / 1000));

    return eventId || '';
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    /**
     * Extract stream ID from Redis Stream event ID.
     * Redis generates IDs like: 1643723400000-0, 1643723400001-0, etc.
     * We need to map this back to the original session/stream ID.
     */
    const streamIdMatch = lastEventId.match(/^(.+)-\d+-\d+$/);
    if (!streamIdMatch) {
      return '';
    }

    const streamId = streamIdMatch[1];
    const streamKey = `mcp_events:${streamId}`;

    /**
     * Use Redis XREAD to efficiently read all events after lastEventId.
     * WHY: This is much more efficient than scanning and filtering manually.
     */
    const events = await this.redis.xread('STREAMS', streamKey, lastEventId);

    if (!events || events.length === 0) {
      return streamId || '';
    }

    // Process and send events in order
    const stream = events[0];
    if (stream && stream[1]) {
      for (const [eventId, fields] of stream[1]) {
        const messageData = fields[1]; // 'data' field value
        if (messageData) {
          const message = JSON.parse(messageData) as JSONRPCMessage;
          await send(eventId, message);
        }
      }
    }

    return streamId || '';
  }

  async cleanup(): Promise<void> {
    /**
     * Redis handles expiration automatically via TTL.
     * This method is kept for interface compatibility with InMemoryEventStore.
     */
  }
}

// =================================================================
// SECTION 3: CORE FACTORIES
// =================================================================

/**
 * Factory function that initializes storage backends based on configuration.
 * This is the heart of the Strategy Pattern implementation.
 *
 * WHY: This function encapsulates all the complexity of choosing and configuring
 * storage backends. The rest of the application doesn't need to know whether
 * it's talking to Redis or in-memory storage.
 *
 * DESIGN PATTERNS:
 * - Factory Pattern: Creates appropriate storage implementations
 * - Strategy Pattern: Returns implementations of common interfaces
 */
async function initializeStores(): Promise<{
  sessionStore: ISessionStore;
  eventStore: EventStore;
}> {
  if (config.useRedis) {
    console.log('✅ Using Redis for distributed state management.');

    /**
     * Redis configuration with production-ready settings.
     * WHY: These settings handle common production scenarios:
     * - retryStrategy: Exponential backoff for reconnection
     * - reconnectOnError: Automatic recovery from READONLY errors
     * - lazyConnect: false ensures we fail fast if Redis is unavailable
     */
    const redisOptions: RedisOptions = {
      host: process.env['REDIS_HOST'] || 'localhost',
      port: parseInt(process.env['REDIS_PORT'] || '6379'),
      db: parseInt(process.env['REDIS_DB'] || '0'),
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      reconnectOnError: (err: Error) => {
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
          return true;
        }
        return false;
      },
      lazyConnect: false,
    };

    if (process.env['REDIS_PASSWORD']) {
      redisOptions.password = process.env['REDIS_PASSWORD'];
    }

    redisClient = new IORedis.default(redisOptions);

    /**
     * Redis event handlers for observability.
     * WHY: These logs are crucial for diagnosing connection issues
     * in production environments.
     */
    redisClient.on('error', (err: Error) => {
      console.error('Redis Client Error:', err);
    });

    redisClient.on('connect', () => {
      console.log('Redis Client Connected');
    });

    redisClient.on('reconnecting', () => {
      console.log('Redis Client Reconnecting...');
    });

    redisClient.on('close', () => {
      console.log('Redis Client Connection Closed');
    });

    return {
      sessionStore: new RedisSessionStore(redisClient, config.sessionTimeout),
      eventStore: new RedisEventStore(redisClient),
    };
  } else {
    console.log('✅ Using In-Memory for single-node state management.');
    return {
      sessionStore: new InMemorySessionStore(config.sessionTimeout),
      eventStore: new InMemoryEventStore(),
    };
  }
}

/**
 * Factory function that creates and configures an MCP server instance.
 * This function contains all the tool, resource, and prompt registrations.
 *
 * WHY: This factory encapsulates the complex server setup logic and makes
 * it reusable for both initial setup and just-in-time reconstruction.
 *
 * ARCHITECTURE: This function demonstrates the complete MCP server capabilities:
 * - Tools: Stateful operations that modify session data
 * - Resources: Read-only data exposure with dynamic URIs
 * - Prompts: Templates for guiding client interactions
 */
async function createMCPServer(sessionId: string): Promise<McpServer> {
  const server = new McpServer(
    {
      name: 'calculator-learning-demo-streamable-http',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {
          listChanged: true,
        },
        resources: {
          subscribe: true,
          listChanged: true,
        },
        prompts: {
          listChanged: true,
        },
      },
    },
  );

  /**
   * @summary Safely retrieves the data for the current session.
   * @remarks A helper function that encapsulates the logic for fetching session data
   * from the configured store and handling the case where the session does not exist.
   * This pattern is used throughout - fetch session data at the start of each operation,
   * with graceful failure if the session doesn't exist.
   * @throws {SessionNotFoundError} If the session data cannot be found for the given `sessionId`.
   */
  const getSessionData = async (): Promise<SessionData> => {
    const sessionData = await sessionStore.get(sessionId);
    if (!sessionData) {
      throw new SessionNotFoundError('Session could not be found or has expired.', { sessionId });
    }
    return sessionData;
  };

  /**
   * Educational tool registration based on environment variable.
   * WHY: This demonstrates how to make tool registration dynamic based on
   * configuration, useful for educational or demo scenarios.
   */
  const sampleToolName = process.env['SAMPLE_TOOL_NAME']?.trim();
  if (sampleToolName) {
    // --- Tool: Dynamic Sample Tool ---
    // Demonstrates environment-based tool registration for educational purposes
    server.tool(
      sampleToolName,
      'Sample educational tool for learning MCP concepts',
      sampleToolArgsSchema.shape,
      /**
       * @summary Sample educational tool that demonstrates basic MCP tool patterns.
       * @remarks This tool is registered dynamically based on the SAMPLE_TOOL_NAME environment
       * variable. It's purely educational and doesn't interact with session state or storage.
       * @param args The validated tool arguments, matching `SampleToolArgs`.
       * @throws {SessionNotFoundError} If the session ID associated with the request is invalid.
       */
      async ({ message }: SampleToolArgs): Promise<CallToolResult> => {
        return {
          content: [
            {
              type: 'text',
              text: `Sample tool "${sampleToolName}" received: ${message}`,
            },
          ],
        };
      },
    );
  }

  // ==========================================
  // CORE TOOLS
  // ==========================================

  // --- Tool: calculate ---
  // Demonstrates a core stateful tool. It performs a calculation,
  // modifies the session's history array, and persists the change.
  // KEY PATTERN: State modification + persistence in every stateful operation
  server.tool(
    'calculate',
    'Performs arithmetic calculations',
    calculateArgsSchema.shape,
    /**
     * @summary Executes a stateful arithmetic calculation.
     * @remarks This is a core stateful tool. It performs a calculation,
     * modifies the session's history array, persists the change to the session store,
     * and increments a Prometheus metric. It also demonstrates progress streaming.
     * @param args The validated tool arguments, matching `CalculateArgs`.
     * @param extra An object containing callbacks like `sendNotification`.
     * @throws {SessionNotFoundError} If the session ID associated with the request is invalid.
     * @throws {McpError} with code `InvalidParams` if a division by zero is attempted.
     * @throws {StorageOperationFailedError} If persisting the updated session state fails.
     */
    async ({ a, b, op, stream }: CalculateArgs, { sendNotification }): Promise<CallToolResult> => {
      const requestId = randomUUID();
      const sessionData = await getSessionData();

      if (stream) {
        /**
         * Streaming demonstration: Send progress notifications during calculation.
         * WHY: This shows how to use MCP's streaming capabilities for long-running
         * operations or to provide user feedback during processing.
         */
        await sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken: requestId,
            progress: 0.2,
            data: `Starting ${op} calculation...`,
          },
        });

        await new Promise((resolve) => setTimeout(resolve, 100));

        await sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken: requestId,
            progress: 0.5,
            data: `Processing: ${a} ${op} ${b}`,
          },
        });

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      let result: number;
      switch (op) {
        case 'add':
          result = a + b;
          break;
        case 'subtract':
          result = a - b;
          break;
        case 'multiply':
          result = a * b;
          break;
        case 'divide':
          if (b === 0) {
            // CAVEAT: It is critical to validate business logic rules like this and
            // throw a specific, protocol-compliant error. Simply letting this proceed
            // would result in `Infinity`, which might be an unexpected or unhandled
            // result for the client. Failing fast is safer.
            throw new McpError(ErrorCode.InvalidParams, 'Division by zero is not allowed');
          }
          result = a / b;
          break;
      }

      /**
       * Event sourcing pattern: Create an immutable calculation record.
       * WHY: This provides complete audit trail and enables session reconstruction.
       */
      const calculation: Calculation = {
        id: requestId,
        sessionId,
        timestamp: Date.now(),
        operation: op,
        inputs: [a, b],
        result,
      };

      sessionData.calculations.push(calculation);

      /**
       * Ring buffer implementation: Maintain bounded history.
       * WHY: Prevents unbounded memory growth while keeping recent history.
       */
      if (sessionData.calculations.length > 50) {
        sessionData.calculations.shift();
      }

      // Persist the updated session state
      await sessionStore.set(sessionId, sessionData);

      // Update Prometheus metrics for observability
      calculationCounter.inc({ operation: op });

      if (stream) {
        await sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken: requestId,
            progress: 1.0,
            data: `Calculation complete: ${result}`,
          },
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: `${a} ${op} ${b} = ${result}`,
          },
        ],
        isError: false,
      };
    },
  );

  // --- Tool: batch_calculate ---
  // Demonstrates batch processing with progress reporting.
  // KEY PATTERN: Iterative processing with optional progress updates
  server.tool(
    'batch_calculate',
    'Perform multiple calculations in batch',
    batchCalculateArgsSchema.shape,
    /**
     * @summary Executes multiple arithmetic calculations in batch with optional progress reporting.
     * @remarks This tool demonstrates batch processing patterns, iterating through multiple
     * calculations while optionally providing real-time progress updates to the client.
     * Each calculation is stored individually in the session history.
     * @param args The validated tool arguments, matching `BatchCalculateArgs`.
     * @param extra An object containing callbacks like `sendNotification`.
     * @throws {SessionNotFoundError} If the session ID associated with the request is invalid.
     * @throws {McpError} with code `InvalidParams` if any calculation involves division by zero.
     * @throws {StorageOperationFailedError} If persisting the updated session state fails.
     */
    async (
      { calculations, reportProgress }: BatchCalculateArgs,
      { sendNotification },
    ): Promise<CallToolResult> => {
      const sessionData = await getSessionData();
      const results = [];
      const batchId = randomUUID();

      for (let i = 0; i < calculations.length; i++) {
        const calc = calculations[i];
        if (!calc) {
          continue; // Skip if undefined (should never happen)
        }

        if (reportProgress) {
          const progress = (i + 1) / calculations.length;
          await sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken: batchId,
              progress,
              data: `Processing calculation ${i + 1}/${calculations.length}: ${calc.a} ${calc.op} ${calc.b}`,
            },
          });
        }

        let result: number;
        switch (calc.op) {
          case 'add':
            result = calc.a + calc.b;
            break;
          case 'subtract':
            result = calc.a - calc.b;
            break;
          case 'multiply':
            result = calc.a * calc.b;
            break;
          case 'divide':
            if (calc.b === 0) {
              results.push({ error: 'Division by zero', input: calc });
              continue;
            }
            result = calc.a / calc.b;
            break;
        }

        results.push({
          input: calc,
          result,
          expression: `${calc.a} ${calc.op} ${calc.b} = ${result}`,
        });

        // Store each calculation in history
        const calculation: Calculation = {
          id: randomUUID(),
          sessionId,
          timestamp: Date.now(),
          operation: calc.op,
          inputs: [calc.a, calc.b],
          result,
        };

        sessionData.calculations.push(calculation);
        calculationCounter.inc({ operation: calc.op });
      }

      // Ring buffer maintenance
      while (sessionData.calculations.length > 50) {
        sessionData.calculations.shift();
      }

      await sessionStore.set(sessionId, sessionData);

      return {
        content: [
          {
            type: 'text',
            text: `Batch calculation completed. Results:\n${results
              .map((r) => ('error' in r ? `Error: ${r.error}` : r.expression))
              .join('\n')}`,
          },
        ],
        isError: false,
      };
    },
  );

  // --- Tool: advanced_calculate ---
  // Demonstrates scientific and mathematical operations.
  // KEY PATTERN: Extended functionality while maintaining the same state patterns
  server.tool(
    'advanced_calculate',
    'Advanced mathematical operations',
    advancedCalculateArgsSchema.shape,
    /**
     * @summary Executes advanced mathematical operations like factorial, power, and trigonometric functions.
     * @remarks This tool extends the basic calculator with scientific functions while maintaining
     * the same state management patterns. Each operation is validated and stored in session history.
     * @param args The validated tool arguments, matching `AdvancedCalculateArgs`.
     * @throws {SessionNotFoundError} If the session ID associated with the request is invalid.
     * @throws {McpError} with code `InvalidParams` for invalid mathematical inputs.
     * @throws {StorageOperationFailedError} If persisting the updated session state fails.
     */
    async ({ operation, value, base }: AdvancedCalculateArgs): Promise<CallToolResult> => {
      const sessionData = await getSessionData();
      let result: number;

      switch (operation) {
        case 'factorial':
          if (value < 0 || !Number.isInteger(value)) {
            throw new McpError(ErrorCode.InvalidParams, 'Factorial requires non-negative integer');
          }
          result =
            value <= 1 ? 1 : Array.from({ length: value }, (_, i) => i + 1).reduce((a, b) => a * b);
          break;
        case 'power':
          if (base === undefined) {
            throw new McpError(ErrorCode.InvalidParams, 'Power operation requires base parameter');
          }
          result = Math.pow(base, value);
          break;
        case 'sqrt':
          if (value < 0) {
            throw new McpError(ErrorCode.InvalidParams, 'Square root of negative number');
          }
          result = Math.sqrt(value);
          break;
        case 'log':
          if (value <= 0) {
            throw new McpError(ErrorCode.InvalidParams, 'Logarithm requires positive number');
          }
          result = base ? Math.log(value) / Math.log(base) : Math.log(value);
          break;
        case 'sin':
          result = Math.sin(value);
          break;
        case 'cos':
          result = Math.cos(value);
          break;
        case 'tan':
          result = Math.tan(value);
          break;
      }

      // Store calculation in history
      const calculation: Calculation = {
        id: randomUUID(),
        sessionId,
        timestamp: Date.now(),
        operation,
        inputs: base !== undefined ? [value, base] : [value],
        result,
      };

      sessionData.calculations.push(calculation);
      if (sessionData.calculations.length > 50) {
        sessionData.calculations.shift();
      }

      await sessionStore.set(sessionId, sessionData);
      calculationCounter.inc({ operation });

      return {
        content: [
          {
            type: 'text',
            text: `${operation}(${value}${base !== undefined ? `, ${base}` : ''}) = ${result}`,
          },
        ],
        isError: false,
      };
    },
  );

  // --- Tool: demo_progress ---
  // Demonstrates sending real-time progress updates to the client
  // for long-running operations using the `sendNotification` callback.
  // KEY PATTERN: Progress reporting for user experience
  server.tool(
    'demo_progress',
    'Demonstrate progress notifications',
    demoProgressArgsSchema.shape,
    /**
     * @summary Demonstrates real-time progress notifications for long-running operations.
     * @remarks This tool showcases how to use the `sendNotification` callback to provide
     * real-time feedback during lengthy operations. It's purely educational and doesn't
     * modify session state - no persistent storage operations are performed.
     * @param args The validated tool arguments, matching `DemoProgressArgs`.
     * @param extra An object containing callbacks like `sendNotification`.
     * @throws {SessionNotFoundError} If the session ID associated with the request is invalid.
     */
    async ({ steps }: DemoProgressArgs, { sendNotification }): Promise<CallToolResult> => {
      const progressToken = randomUUID();

      for (let i = 0; i <= steps; i++) {
        await sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: i / steps,
            data: `Step ${i}/${steps} completed`,
          },
        });

        // Simulate work
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      return {
        content: [
          {
            type: 'text',
            text: `Progress demonstration completed with ${steps} steps`,
          },
        ],
        isError: false,
      };
    },
  );

  // ==========================================
  // RESOURCES
  // ==========================================

  /**
   * Resources provide read-only access to server data.
   * They demonstrate different URI patterns and data access methods.
   */

  // --- Resource: calculator-constants ---
  // Static resource demonstrating simple data exposure
  server.resource(
    'calculator-constants',
    'calculator://constants',
    {
      title: 'Calculator Constants',
      description: 'Mathematical constants',
      mimeType: 'application/json',
    },
    /**
     * @summary Provides access to common mathematical constants.
     * @remarks This resource returns a JSON object containing mathematical constants
     * like π, e, √2, etc. It's a stateless resource that doesn't require session data.
     * @throws {SessionNotFoundError} If the session ID associated with the request is invalid.
     */
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [
          {
            uri: 'calculator://constants',
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                pi: Math.PI,
                e: Math.E,
                sqrt2: Math.SQRT2,
                ln2: Math.LN2,
                ln10: Math.LN10,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // --- Resource: calculation-history ---
  // Dynamic resource with parameterized URI demonstrating data lookup
  const historyTemplate = 'calculator://history/{calculationId}';

  server.resource(
    'calculation-history',
    historyTemplate,
    {
      title: 'Calculation History',
      description: 'Retrieve specific calculation from history',
      mimeType: 'application/json',
    },
    /**
     * @summary Retrieves a specific calculation from the session's history.
     * @remarks This resource demonstrates parameterized URIs, extracting the calculation ID
     * from the URI path and looking it up in the session's calculation history.
     * @param uri The resource URI containing the calculation ID parameter.
     * @throws {SessionNotFoundError} If the session ID associated with the request is invalid.
     * @throws {McpError} with code `InvalidRequest` if the calculation ID is not found.
     */
    async (uri: URL | string): Promise<ReadResourceResult> => {
      // Extract calculationId from the URI
      const uriStr = typeof uri === 'string' ? uri : uri.toString();
      const calculationId = uriStr.split('/').pop();
      const sessionData = await getSessionData();

      const calculation = sessionData.calculations.find((c) => c.id === calculationId);
      if (!calculation) {
        throw new McpError(ErrorCode.InvalidRequest, `Calculation ${calculationId} not found`);
      }

      return {
        contents: [
          {
            uri: `calculator://history/${calculationId}`,
            mimeType: 'application/json',
            text: JSON.stringify(calculation, null, 2),
          },
        ],
      };
    },
  );

  // --- Resource: calculator-stats ---
  // Demonstrates integration with Prometheus metrics
  server.resource(
    'calculator-stats',
    'calculator://stats',
    {
      title: 'Calculator Statistics',
      description: 'Aggregate statistics across all sessions',
      mimeType: 'application/json',
    },
    /**
     * @summary Provides aggregate statistics across all sessions from Prometheus metrics.
     * @remarks This resource demonstrates integration with monitoring systems, extracting
     * operational metrics from the Prometheus registry and exposing them as a resource.
     * @throws {SessionNotFoundError} If the session ID associated with the request is invalid.
     */
    async (): Promise<ReadResourceResult> => {
      // Get metrics from Prometheus registry
      const metrics = await prometheusRegister.getMetricsAsJSON();
      const calculationMetric = metrics.find((m) => m.name === 'mcp_calculations_total');
      const sessionMetric = metrics.find((m) => m.name === 'mcp_active_sessions');

      return {
        contents: [
          {
            uri: 'calculator://stats',
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                totalCalculations:
                  calculationMetric?.values?.reduce((sum, v) => sum + (v.value || 0), 0) || 0,
                activeSessions: sessionMetric?.values?.[0]?.value || 0,
                operationBreakdown:
                  calculationMetric?.values?.map((v) => ({
                    operation: v.labels?.['operation'],
                    count: v.value,
                  })) || [],
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // --- Resource: session-info ---
  // Session-specific resource demonstrating access to current session state
  server.resource(
    'session-info',
    `session://info/${sessionId}`,
    {
      title: 'Session Information',
      description: 'Current session details',
      mimeType: 'application/json',
    },
    /**
     * @summary Provides detailed information about the current session.
     * @remarks This resource exposes session metadata including start time, activity tracking,
     * and calculation statistics. It demonstrates session-specific resource handling.
     * @throws {SessionNotFoundError} If the session ID associated with the request is invalid.
     */
    async (): Promise<ReadResourceResult> => {
      const sessionData = await getSessionData();

      return {
        contents: [
          {
            uri: `session://info/${sessionId}`,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                sessionId: sessionData.sessionId,
                startTime: new Date(sessionData.startTime).toISOString(),
                lastActivity: new Date(sessionData.lastActivity).toISOString(),
                requestCount: sessionData.requestCount,
                calculationCount: sessionData.calculations.length,
                uptime: Date.now() - sessionData.startTime,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // --- Resource: formulas-library ---
  // Educational resource demonstrating static educational content
  server.resource(
    'formulas-library',
    'formulas://library',
    {
      title: 'Formula Library',
      description: 'Mathematical formulas',
      mimeType: 'application/json',
    },
    /**
     * @summary Provides access to a library of mathematical formulas.
     * @remarks This educational resource demonstrates static content serving,
     * providing a collection of mathematical formulas and their descriptions.
     * @throws {SessionNotFoundError} If the session ID associated with the request is invalid.
     */
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [
          {
            uri: 'formulas://library',
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                quadratic: {
                  formula: 'ax² + bx + c = 0',
                  solution: 'x = (-b ± √(b²-4ac)) / 2a',
                },
                pythagorean: {
                  formula: 'a² + b² = c²',
                  description: 'For right triangles',
                },
                compound_interest: {
                  formula: 'A = P(1 + r/n)^(nt)',
                  variables: {
                    A: 'Final amount',
                    P: 'Principal',
                    r: 'Annual interest rate',
                    n: 'Compounding frequency',
                    t: 'Time in years',
                  },
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ==========================================
  // PROMPTS
  // ==========================================

  /**
   * Prompts are templates that help clients generate appropriate requests.
   * They demonstrate how to guide client interactions and provide structured
   * input for complex operations.
   */

  // --- Prompt: explain-calculation ---
  server.registerPrompt(
    'explain-calculation',
    {
      title: 'Explain Calculation',
      description: 'Explain how to perform a calculation step by step',
      argsSchema: explainCalculationArgsSchema.shape,
    },
    /**
     * @summary Generates prompts for step-by-step calculation explanations.
     * @remarks This prompt template helps generate educational content for explaining
     * mathematical operations at different complexity levels. It's stateless and educational.
     * @param args The validated prompt arguments, matching `ExplainCalculationArgs`.
     * @throws {SessionNotFoundError} If the session ID associated with the request is invalid.
     */
    async ({ operation, level }: ExplainCalculationArgs): Promise<GetPromptResult> => {
      const explanationLevel = level || 'basic';

      return {
        description: `Step-by-step explanation of ${operation} at ${explanationLevel} level`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please explain how to ${operation} step by step at a ${explanationLevel} level. Include examples and common mistakes to avoid.`,
            },
          },
        ],
      };
    },
  );

  // --- Prompt: generate-problems ---
  server.registerPrompt(
    'generate-problems',
    {
      title: 'Generate Practice Problems',
      description: 'Generate math practice problems',
      argsSchema: generateProblemsArgsSchema.shape,
    },
    /**
     * @summary Generates prompts for creating practice math problems.
     * @remarks This prompt template creates educational math problems at various difficulty
     * levels and topics. It's designed to help generate learning materials dynamically.
     * @param args The validated prompt arguments, matching `GenerateProblemsArgs`.
     * @throws {SessionNotFoundError} If the session ID associated with the request is invalid.
     */
    async ({ topic, difficulty, count }: GenerateProblemsArgs): Promise<GetPromptResult> => {
      return {
        description: `Generate ${count} ${difficulty} ${topic} problems`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Generate ${count} ${difficulty}-level practice problems for ${topic}. Include solutions and explanations.`,
            },
          },
        ],
      };
    },
  );

  // --- Prompt: solve_math_problem ---
  server.registerPrompt(
    'solve_math_problem',
    {
      title: 'Solve Math Problem',
      description: 'Step-by-step problem solving',
      argsSchema: solveMathProblemArgsSchema.shape,
    },
    /**
     * @summary Generates prompts for step-by-step math problem solving.
     * @remarks This prompt template helps create detailed problem-solving workflows
     * with optional detailed work shown. It's educational and helps teach methodology.
     * @param args The validated prompt arguments, matching `SolveMathProblemArgs`.
     * @throws {SessionNotFoundError} If the session ID associated with the request is invalid.
     */
    async ({ problem, showWork }: SolveMathProblemArgs): Promise<GetPromptResult> => {
      return {
        description: `Solve: ${problem}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Solve this problem: ${problem}. ${showWork === 'true' ? 'Show all work and explain each step.' : 'Provide the solution.'}`,
            },
          },
        ],
      };
    },
  );

  // --- Prompt: explain_formula ---
  server.registerPrompt(
    'explain_formula',
    {
      title: 'Explain Formula',
      description: 'Detailed formula explanation',
      argsSchema: explainFormulaArgsSchema.shape,
    },
    /**
     * @summary Generates prompts for detailed mathematical formula explanations.
     * @remarks This prompt template creates comprehensive explanations of mathematical
     * formulas with optional contextual information for practical applications.
     * @param args The validated prompt arguments, matching `ExplainFormulaArgs`.
     * @throws {SessionNotFoundError} If the session ID associated with the request is invalid.
     */
    async ({ formula, context }: ExplainFormulaArgs): Promise<GetPromptResult> => {
      return {
        description: `Explain the formula: ${formula}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Explain the formula "${formula}"${context ? ` in the context of ${context}` : ''}. Include what each variable represents and when to use this formula.`,
            },
          },
        ],
      };
    },
  );

  // --- Prompt: calculator_assistant ---
  server.registerPrompt(
    'calculator_assistant',
    {
      title: 'Calculator Assistant',
      description: 'General calculation assistance',
      argsSchema: calculatorAssistantArgsSchema.shape,
    },
    /**
     * @summary Generates prompts for general calculation assistance and guidance.
     * @remarks This prompt template provides general mathematical assistance for any
     * calculation-related query, serving as a catch-all helper for users.
     * @param args The validated prompt arguments, matching `CalculatorAssistantArgs`.
     * @throws {SessionNotFoundError} If the session ID associated with the request is invalid.
     */
    async ({ query }: CalculatorAssistantArgs): Promise<GetPromptResult> => {
      return {
        description: 'Calculator assistance request',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `I need help with this calculation: ${query}. Please provide step-by-step guidance.`,
            },
          },
        ],
      };
    },
  );

  return server;
}

// =================================================================
// SECTION 4: EXPRESS WEB SERVER (THE TRANSPORT LAYER)
// =================================================================

/**
 * Creates and configures the Express application.
 * This function handles all HTTP-level concerns including CORS, rate limiting,
 * and the complex session management logic.
 *
 * WHY: Separating this into its own function makes it testable and allows
 * for easy configuration changes without touching the core MCP logic.
 */
async function createApp(): Promise<{ app: express.Application; eventStore: EventStore }> {
  const app = express();

  // Initialize storage backends using the factory
  const stores = await initializeStores();
  sessionStore = stores.sessionStore;
  eventStore = stores.eventStore;

  // --- PROTOCOL ERROR FLOW ---
  // This sequence outlines how an incoming request is processed and how errors are handled at each stage.
  // 1. HTTP Request -> The raw request hits the Express server.
  // 2. Middleware (CORS, Rate Limiter, JSON Parser) -> Handles web-standard concerns.
  //    - On rate limit exceeded: Handler sends a 429 response with a JSON-RPC error.
  // 3. MCP Endpoint Handlers (POST/GET/DELETE /mcp) -> The main application logic begins.
  //    - On missing session ID: Throws `SessionNotFoundError`.
  //    - On session not found in store: Throws `SessionNotFoundError`.
  // 4. MCP Server Instance (Tool/Resource Handlers) -> The specific MCP operation is executed.
  //    - On invalid tool parameters (validated by Zod): SDK throws `McpError(ErrorCode.InvalidParams)`.
  //    - On internal logic failure (e.g., DB error): Throws `StorageOperationFailedError`.
  // 5. Global Error Handler (Final Middleware) -> Catches ANY unhandled exception from the handlers.
  //    - Logs the full, real error for debugging.
  //    - Sends a safe, generic, protocol-compliant JSON-RPC error to the client. This prevents leaking implementation details like stack traces.

  /**
   * CORS configuration for cross-origin requests.
   * WHY: MCP clients often run in browsers or different domains.
   * This configuration allows the necessary headers and methods.
   */
  app.use(
    cors({
      origin: config.corsOrigin,
      credentials: true,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'mcp-session-id', 'last-event-id'],
      exposedHeaders: ['Mcp-Session-Id'],
    }),
  );

  /**
   * Rate limiting to prevent abuse.
   * WHY: Without rate limiting, the server is vulnerable to DoS attacks.
   * This configuration allows reasonable usage while blocking abuse.
   */
  const limiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Too many requests, please retry later',
        },
        id: null,
      });
    },
  });

  // Apply rate limiting to all /mcp endpoints
  app.use('/mcp', limiter);

  // JSON parsing middleware with size limit for security
  app.use(express.json({ limit: '10mb' }));

  /**
   * Session cleanup interval.
   * WHY: This background job prevents memory leaks and removes orphaned sessions.
   * The logic differs between Redis (which handles expiration automatically)
   * and in-memory storage (which requires manual cleanup).
   */
  setInterval(async () => {
    if (config.useRedis) {
      /**
       * Redis cleanup: Remove orphaned transport/server instances.
       * WHY: Redis handles session expiration via TTL, but we need to clean up
       * local instances when sessions expire.
       */
      for (const [sessionId, instances] of sessionInstances) {
        const session = await sessionStore.get(sessionId);
        if (!session) {
          instances.transport.close();
          instances.server.close();
          sessionInstances.delete(sessionId);
        }
      }
    } else {
      /**
       * In-memory cleanup: Both session data and local instances.
       * WHY: In-memory storage doesn't have automatic expiration.
       */
      const inMemoryStore = sessionStore as InMemorySessionStore;
      inMemoryStore.cleanup();

      for (const [sessionId, instances] of sessionInstances) {
        const session = await sessionStore.get(sessionId);
        if (!session) {
          instances.transport.close();
          instances.server.close();
          sessionInstances.delete(sessionId);
        }
      }
    }

    // Update Prometheus metrics for observability
    activeSessionsGauge.set(sessionInstances.size);

    // Cleanup event store if it has a cleanup method
    if ('cleanup' in eventStore && typeof eventStore.cleanup === 'function') {
      await eventStore.cleanup();
    }
  }, 60000); // Every minute

  /**
   * @summary Helper to get or reconstruct MCP instances for a given session.
   * @remarks This function encapsulates the "Just-in-Time Reconstruction" pattern,
   * ensuring that any node in a cluster can handle a request for any session
   * without relying on sticky sessions. It first checks a local in-memory cache
   * for performance and falls back to reconstructing from the persistent store if needed.
   * @param sessionId The ID of the session to get instances for.
   * @returns The cached or newly created server and transport instances.
   * @throws {SessionNotFoundError} If the session does not exist in the persistent store.
   */
  async function getOrCreateInstances(
    sessionId: string,
  ): Promise<{ transport: StreamableHTTPServerTransport; server: McpServer }> {
    // 1. Check the high-performance local cache first.
    let instances = sessionInstances.get(sessionId);
    if (instances) {
      return instances;
    }

    // 2. If not cached, verify the session exists in the authoritative persistent store.
    const sessionData = await sessionStore.get(sessionId);
    if (!sessionData) {
      // This is a definitive "not found" condition.
      throw new SessionNotFoundError('Session does not exist or has expired.', { sessionId });
    }

    // 3. Reconstruct the instances, as the session is valid but not cached on this node.
    console.log(`Reconstructing instances for session ${sessionId} on this node`);
    const reconstructedTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      eventStore,
      enableDnsRebindingProtection: true,
      allowedHosts: ['localhost:' + config.port, '127.0.0.1:' + config.port],
      ...(config.corsOrigin !== '*' && {
        allowedOrigins: ['http://localhost:' + config.port, 'http://127.0.0.1:' + config.port],
      }),
      onsessioninitialized: async (sid) => {
        console.log(`Session re-initialized: ${sid}`);
      },
      onsessionclosed: async (closedSessionId) => {
        const instances = sessionInstances.get(closedSessionId);
        if (instances) {
          await instances.server.close();
          sessionInstances.delete(closedSessionId);
          await sessionStore.delete(closedSessionId);
          activeSessionsGauge.dec();
          console.log(`Session closed: ${closedSessionId}`);
        }
      },
    });

    // CRITICAL TYPE ASSERTION: We must manually assign the ID for reconstruction.
    (reconstructedTransport as TransportWithSessionId).sessionId = sessionId;

    const reconstructedServer = await createMCPServer(sessionId);
    await reconstructedServer.connect(reconstructedTransport);

    // 4. Cache the newly reconstructed instances locally for subsequent requests.
    instances = { transport: reconstructedTransport, server: reconstructedServer };
    sessionInstances.set(sessionId, instances);

    // Set up transport error handler for cleanup
    reconstructedTransport.onclose = () => {
      const sid = (reconstructedTransport as TransportWithSessionId).sessionId;
      if (sid && sessionInstances.has(sid)) {
        console.log(`Transport closed for session ${sid}`);
      }
    };

    return instances;
  }

  // ==========================================
  // MCP ENDPOINTS
  // ==========================================

  /**
   * POST /mcp - Command Channel
   * This is the most complex endpoint, handling both session initialization
   * and command processing for existing sessions.
   */
  app.post('/mcp', async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport: StreamableHTTPServerTransport;

    if (sessionId) {
      /**
       * EXISTING SESSION FLOW
       * 1. Update activity tracking
       * 2. Get or reconstruct MCP instances using helper
       * 3. Handle the request
       */

      // Update activity tracking for session timeout management
      await sessionStore.updateActivity(sessionId);

      const instances = await getOrCreateInstances(sessionId);
      transport = instances.transport;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      /**
       * NEW SESSION FLOW
       * 1. Pre-generate session ID
       * 2. Create transport with fixed ID
       * 3. Store session data FIRST
       * 4. Create MCP server AFTER storage
       * 5. Connect and cache instances
       */

      /**
       * --- PATTERN: Critical Initialization Order ---
       * To prevent race conditions in a distributed system, we follow a strict order:
       * 1. Generate the session ID client-side.
       * 2. Create the transport configured with this ID.
       * 3. PERSIST the initial session data to Redis/memory FIRST.
       * 4. THEN create the McpServer instance which can now safely read that data.
       * 5. Connect the two and cache them locally.
       *
       * WHY: If we create the MCP server before storing the session data,
       * there's a race condition where the server might try to read session
       * data that doesn't exist yet.
       */

      // Pre-create the session ID that will be used
      const newSessionId = randomUUID();

      // Create transport with fixed session ID
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        eventStore,
        enableDnsRebindingProtection: true,
        allowedHosts: ['localhost:' + config.port, '127.0.0.1:' + config.port],
        ...(config.corsOrigin !== '*' && {
          allowedOrigins: ['http://localhost:' + config.port, 'http://127.0.0.1:' + config.port],
        }),
        onsessioninitialized: async (sessionId) => {
          console.log(`Session initialized: ${sessionId}`);
          activeSessionsGauge.inc();
        },
        onsessionclosed: async (closedSessionId) => {
          const instances = sessionInstances.get(closedSessionId);
          if (instances) {
            await instances.server.close();
            sessionInstances.delete(closedSessionId);
            await sessionStore.delete(closedSessionId);
            activeSessionsGauge.dec();
            console.log(`Session closed: ${closedSessionId}`);
          }
        },
      });

      // Create session data immediately
      const sessionData: SessionData = {
        sessionId: newSessionId,
        transport: null as unknown as StreamableHTTPServerTransport,
        server: null as unknown as McpServer,
        startTime: Date.now(),
        lastActivity: Date.now(),
        requestCount: 1,
        calculations: [],
      };

      // Store session in persistent storage BEFORE creating server
      await sessionStore.set(newSessionId, sessionData);

      // Create and connect server AFTER storage is complete
      const server = await createMCPServer(newSessionId);
      await server.connect(transport);

      // Store transport and server instances locally for performance
      sessionInstances.set(newSessionId, { transport, server });

      // Set up transport error handler
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessionInstances.has(sid)) {
          console.log(`Transport closed for session ${sid}`);
        }
      };
    } else {
      // Invalid request - no session ID and not an initialization request
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Request must be an initialize request if no session ID is provided.',
      );
    }

    // Delegate request handling to the MCP SDK transport
    await transport.handleRequest(req, res, req.body);
  });

  /**
   * GET /mcp - Announcement Channel (SSE)
   * Handles Server-Sent Events for real-time communication.
   * Uses the same just-in-time reconstruction pattern as POST.
   */
  app.get('/mcp', async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string;

    if (!sessionId) {
      throw new McpError(ErrorCode.InvalidRequest, 'Mcp-Session-Id header is required');
    }

    await sessionStore.updateActivity(sessionId);

    const instances = await getOrCreateInstances(sessionId);

    // Delegate SSE handling to the SDK's transport
    await instances.transport.handleRequest(req, res);
  });

  /**
   * DELETE /mcp - Session Termination
   * Allows clients to explicitly terminate their sessions.
   */
  app.delete('/mcp', async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string;

    if (!sessionId) {
      throw new McpError(ErrorCode.InvalidRequest, 'Mcp-Session-Id header is required');
    }

    // Use the helper to ensure instances exist, even on other nodes.
    // This is an edge case but ensures correctness.
    const instances = await getOrCreateInstances(sessionId);

    // Let the transport handle the DELETE request
    // This will trigger the onsessionclosed callback
    await instances.transport.handleRequest(req, res);
  });

  /**
   * Health check endpoint with storage-aware reporting.
   * WHY: Different health criteria for different storage modes.
   * Redis mode requires connectivity check, in-memory mode is always healthy.
   */
  app.get('/health', async (_req: Request, res: Response) => {
    if (config.useRedis && redisClient) {
      try {
        // Test Redis connectivity
        await redisClient.ping();

        res.json({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          sessions: sessionInstances.size,
          uptime: process.uptime(),
          storageMode: 'redis',
          redis: redisClient.status,
        });
      } catch {
        // If Redis is down, server is unhealthy
        res.status(503).json({
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          sessions: sessionInstances.size,
          uptime: process.uptime(),
          storageMode: 'redis',
          redis: 'disconnected',
          error: 'Redis connection failed',
        });
      }
    } else {
      // In-memory mode is always healthy
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        sessions: sessionInstances.size,
        uptime: process.uptime(),
        storageMode: 'in-memory',
      });
    }
  });

  /**
   * Prometheus metrics endpoint for observability.
   * WHY: Metrics are crucial for production monitoring and capacity planning.
   */
  app.get('/metrics', async (_req: Request, res: Response) => {
    res.set('Content-Type', prometheusRegister.contentType);
    const metrics = await prometheusRegister.metrics();
    res.end(metrics);
  });

  /**
   * --- GLOBAL ERROR HANDLING MIDDLEWARE ---
   * @summary The final safety net for all requests.
   * @remarks This is the most critical piece of the server's resilience strategy.
   * It catches any error that bubbles up from the route handlers, logs the
   * true error for debugging, and sends a sanitized, protocol-compliant
   * JSON-RPC error response to the client. This prevents sensitive information
   * like stack traces from ever being leaked.
   */
  app.use((err: Error, req: Request, res: Response, next: express.NextFunction) => {
    // If headers have already been sent, delegate to the default handler
    if (res.headersSent) {
      return next(err);
    }

    // Log the full error to the console for debugging purposes
    console.error('[GLOBAL ERROR HANDLER] Unhandled error caught:', err);

    let code = ErrorCode.InternalError;
    let message = 'An internal server error occurred.';
    let data: unknown = undefined;

    if (err instanceof CalculatorServerError) {
      code = err.code;
      message = err.message;
      data = err.context;
    } else if (err instanceof McpError) {
      code = err.code;
      message = err.message;
      data = err.data;
    }

    // Extract the JSON-RPC request ID from the body if available
    const rpcId = (req.body as { id?: string | number | null })?.id ?? null;

    res.status(500).json({
      jsonrpc: '2.0',
      id: rpcId,
      error: { code, message, data },
    });
  });

  return { app, eventStore };
}

// =================================================================
// SECTION 5: APPLICATION ENTRY POINT
// =================================================================

/**
 * Main server startup function.
 * This function ties everything together and handles graceful shutdown.
 *
 * WHY: Separating startup logic makes it testable and allows for
 * different startup scenarios (tests, development, production).
 */
async function startServer(): Promise<void> {
  try {
    const { app } = await createApp();
    const server: Server = createServer(app);

    server.listen(config.port, () => {
      console.log(
        `Calculator Learning Demo - Streamable HTTP (Stateful) running on port ${config.port}`,
      );
      console.log(`POST http://localhost:${config.port}/mcp - Command channel`);
      console.log(`GET  http://localhost:${config.port}/mcp - Announcement channel`);
    });

    /**
     * Graceful shutdown handler.
     * WHY: This is critical for containerized environments like Docker/Kubernetes.
     * Proper shutdown prevents data loss and ensures clean resource cleanup.
     * Zero-downtime deployments depend on this working correctly.
     */
    process.on('SIGTERM', () => {
      console.log('Shutting down gracefully...');
      server.close(async () => {
        // Close all active sessions
        for (const [sessionId, instances] of sessionInstances) {
          instances.transport.close();
          instances.server.close();
          await sessionStore.delete(sessionId);
        }

        // Close Redis connection if using Redis
        if (redisClient) {
          await redisClient.quit();
        }

        process.exit(0);
      });
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

/**
 * Auto-start logic: Only start the server if this file is run directly.
 * WHY: This allows the module to be imported for testing without
 * automatically starting the server.
 */
if (process.env['NODE_ENV'] !== 'test') {
  startServer();
}

// Export key functions for testing and external use
export { startServer, createMCPServer, createApp, config };
