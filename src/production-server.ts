/**
 * Calculator Learning Demo - Streamable HTTP (Stateful)
 * 
 * Reference implementation for MCP learning edition showcasing:
 * - Stateful session management
 * - Event store integration for resumability
 * - Core and extended tools, resources, and prompts
 * - Proper error handling and security
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createServer, Server } from 'http';
import { randomUUID } from 'crypto';
import { z } from 'zod';

// MCP SDK imports
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
  isInitializeRequest,
  JSONRPCMessage
} from '@modelcontextprotocol/sdk/types.js';
import { EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * In-memory Event Store implementation
 */
class InMemoryEventStore implements EventStore {
  private events: Map<string, { 
    streamId: string; 
    message: JSONRPCMessage; 
    timestamp: number;
  }> = new Map();
  
  private readonly maxAge: number = 24 * 60 * 60 * 1000; // 24 hours
  private readonly maxEvents: number = 10000;

  private generateEventId(streamId: string): string {
    return `${streamId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }

  private getStreamIdFromEventId(eventId: string): string {
    const parts = eventId.split('_');
    return parts.length > 0 ? parts[0]! : '';
  }

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = this.generateEventId(streamId);
    const timestamp = Date.now();
    
    this.events.set(eventId, { 
      streamId, 
      message, 
      timestamp
    });

    // Enforce limits
    if (this.events.size > this.maxEvents) {
      const sortedEvents = [...this.events.entries()]
        .sort(([, a], [, b]) => a.timestamp - b.timestamp);
      
      const eventsToDelete = this.events.size - this.maxEvents;
      for (let i = 0; i < eventsToDelete; i++) {
        this.events.delete(sortedEvents[i]![0]);
      }
    }
    
    return eventId;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }
  ): Promise<string> {
    if (!lastEventId || !this.events.has(lastEventId)) {
      return '';
    }

    const streamId = this.getStreamIdFromEventId(lastEventId);
    if (!streamId) return '';

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

  cleanup(): void {
    const now = Date.now();
    for (const [eventId, { timestamp }] of this.events) {
      if (now - timestamp > this.maxAge) {
        this.events.delete(eventId);
      }
    }
  }
}

/**
 * Calculation history and stats management
 */
interface Calculation {
  id: string;
  sessionId: string;
  timestamp: number;
  operation: string;
  inputs: number[];
  result: number;
}

interface SessionData {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  startTime: number;
  lastActivity: number;
  requestCount: number;
  calculations: Calculation[]; // Ring buffer, max 50
}

// Global state
const sessions = new Map<string, SessionData>();
const globalStats = {
  totalCalculations: 0,
  operationCounts: new Map<string, number>(),
  startTime: Date.now()
};

/**
 * Create MCP Server with all capabilities
 */
function createMCPServer(sessionId: string): McpServer {
  const server = new McpServer(
    {
      name: 'calculator-learning-demo-streamable-http',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {}
      },
    }
  );

  // Get or create session data
  const sessionData = sessions.get(sessionId);
  if (!sessionData) {
    throw new Error('Session not found');
  }

  // ==========================================
  // SAMPLE TOOL (EDUCATIONAL)
  // ==========================================
  
  // Optional sample tool for educational purposes
  const sampleToolName = process.env['SAMPLE_TOOL_NAME']?.trim();
  if (sampleToolName) {
    server.tool(
      sampleToolName,
      'Sample educational tool for learning MCP concepts',
      {
        message: z.string().describe('Message to echo back')
      },
      async ({ message }): Promise<CallToolResult> => {
        return {
          content: [{
            type: 'text',
            text: `Sample tool "${sampleToolName}" received: ${message}`
          }]
        };
      }
    );
  }

  // ==========================================
  // CORE TOOLS
  // ==========================================

  // Core tool: calculate
  server.tool(
    'calculate',
    'Performs arithmetic calculations',
    {
      a: z.number().describe('First operand'),
      b: z.number().describe('Second operand'),
      op: z.enum(['add', 'subtract', 'multiply', 'divide']).describe('Operation to perform'),
      stream: z.boolean().optional().describe('Stream intermediate results')
    },
    async ({ a, b, op, stream }, { sendNotification }): Promise<CallToolResult> => {
      const requestId = randomUUID();
      
      if (stream) {
        // Stream intermediate results
        await sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: requestId,
            progress: 0.2,
            data: `Starting ${op} calculation...`
          }
        });
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
        await sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: requestId,
            progress: 0.5,
            data: `Processing: ${a} ${op} ${b}`
          }
        });
        
        await new Promise(resolve => setTimeout(resolve, 100));
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
            throw new Error('Division by zero');
          }
          result = a / b;
          break;
      }

      // Store in history
      const calculation: Calculation = {
        id: requestId,
        sessionId,
        timestamp: Date.now(),
        operation: op,
        inputs: [a, b],
        result
      };

      sessionData.calculations.push(calculation);
      if (sessionData.calculations.length > 50) {
        sessionData.calculations.shift(); // Maintain ring buffer
      }

      // Update global stats
      globalStats.totalCalculations++;
      globalStats.operationCounts.set(
        op,
        (globalStats.operationCounts.get(op) || 0) + 1
      );

      if (stream) {
        await sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: requestId,
            progress: 1.0,
            data: `Calculation complete: ${result}`
          }
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: `${a} ${op} ${b} = ${result}`
          }
        ]
      };
    }
  );

  // ==========================================
  // EXTENDED TOOLS
  // ==========================================

  // Extended tool: batch_calculate
  server.tool(
    'batch_calculate',
    'Perform multiple calculations in batch',
    {
      calculations: z.array(z.object({
        a: z.number(),
        b: z.number(),
        op: z.enum(['add', 'subtract', 'multiply', 'divide'])
      })).describe('Array of calculations to perform')
    },
    async ({ calculations }): Promise<CallToolResult> => {
      const results = [];
      
      for (const calc of calculations) {
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
              result = NaN;
            } else {
              result = calc.a / calc.b;
            }
            break;
        }
        
        results.push({
          operation: `${calc.a} ${calc.op} ${calc.b}`,
          result
        });

        // Update stats
        globalStats.totalCalculations++;
        globalStats.operationCounts.set(
          calc.op,
          (globalStats.operationCounts.get(calc.op) || 0) + 1
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results, null, 2)
          }
        ]
      };
    }
  );

  // Extended tool: advanced_calculate
  server.tool(
    'advanced_calculate',
    'Advanced mathematical operations',
    {
      operation: z.enum(['factorial', 'power', 'sqrt', 'log', 'sin', 'cos', 'tan']).describe('Advanced operation'),
      value: z.number().describe('Input value'),
      base: z.number().optional().describe('Base for power or logarithm operations')
    },
    async ({ operation, value, base }): Promise<CallToolResult> => {
      let result: number;
      
      switch (operation) {
        case 'factorial':
          if (value < 0 || !Number.isInteger(value)) {
            throw new Error('Factorial requires non-negative integer');
          }
          result = 1;
          for (let i = 2; i <= value; i++) {
            result *= i;
          }
          break;
        case 'power':
          result = Math.pow(value, base || 2);
          break;
        case 'sqrt':
          if (value < 0) {
            throw new Error('Square root of negative number');
          }
          result = Math.sqrt(value);
          break;
        case 'log':
          if (value <= 0) {
            throw new Error('Logarithm of non-positive number');
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

      return {
        content: [
          {
            type: 'text',
            text: `${operation}(${value}${base !== undefined ? `, ${base}` : ''}) = ${result}`
          }
        ]
      };
    }
  );

  // Extended tool: demo_progress
  server.tool(
    'demo_progress',
    'Demonstrate progress notifications',
    {
      steps: z.number().default(5).describe('Number of progress steps')
    },
    async ({ steps }, { sendNotification }): Promise<CallToolResult> => {
      const progressToken = randomUUID();
      
      for (let i = 0; i <= steps; i++) {
        await sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: i / steps,
            data: `Step ${i} of ${steps}`
          }
        });
        
        if (i < steps) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `Progress demonstration completed with ${steps} steps`
          }
        ]
      };
    }
  );

  // ==========================================
  // CORE RESOURCES
  // ==========================================

  // Core resource: calculator://constants
  server.resource(
    'calculator-constants',
    'calculator://constants',
    {
      title: 'Calculator Constants',
      description: 'Mathematical constants',
      mimeType: 'application/json'
    },
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [
          {
            uri: 'calculator://constants',
            text: JSON.stringify({
              pi: Math.PI,
              e: Math.E,
              sqrt2: Math.SQRT2,
              ln2: Math.LN2,
              ln10: Math.LN10,
              phi: (1 + Math.sqrt(5)) / 2
            }, null, 2),
            mimeType: 'application/json'
          }
        ]
      };
    }
  );

  // ==========================================
  // EXTENDED RESOURCES
  // ==========================================

  // Extended resource: calculator://history/{calculationId}
  server.resource(
    'calculation-history',
    'calculator://history/*',
    {
      title: 'Calculation History',
      description: 'Retrieve specific calculation from history',
      mimeType: 'application/json'
    },
    async (uri: URL | string): Promise<ReadResourceResult> => {
      const uriString = typeof uri === 'string' ? uri : uri.toString();
      const match = uriString.match(/calculator:\/\/history\/(.+)/);
      if (!match) {
        throw new Error('Invalid history URI');
      }
      
      const calculationId = match[1];
      const calculation = sessionData.calculations.find(c => c.id === calculationId);
      
      if (!calculation) {
        throw new Error('Calculation not found in history');
      }

      return {
        contents: [
          {
            uri: uriString,
            text: JSON.stringify(calculation, null, 2),
            mimeType: 'application/json'
          }
        ]
      };
    }
  );

  // Extended resource: calculator://stats
  server.resource(
    'calculator-stats',
    'calculator://stats',
    {
      title: 'Calculator Statistics',
      description: 'Aggregate statistics across all sessions',
      mimeType: 'application/json'
    },
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [
          {
            uri: 'calculator://stats',
            text: JSON.stringify({
              totalCalculations: globalStats.totalCalculations,
              operationCounts: Object.fromEntries(globalStats.operationCounts),
              uptimeSeconds: Math.floor((Date.now() - globalStats.startTime) / 1000),
              activeSessions: sessions.size
            }, null, 2),
            mimeType: 'application/json'
          }
        ]
      };
    }
  );

  // Extended resource: session://info/{sessionId}
  server.resource(
    'session-info',
    `session://info/${sessionId}`,
    {
      title: 'Session Information',
      description: 'Current session details',
      mimeType: 'application/json'
    },
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [
          {
            uri: `session://info/${sessionId}`,
            text: JSON.stringify({
              sessionId,
              startedAt: new Date(sessionData.startTime).toISOString(),
              lastRequestAt: new Date(sessionData.lastActivity).toISOString(),
              requestCount: sessionData.requestCount,
              calculationCount: sessionData.calculations.length
            }, null, 2),
            mimeType: 'application/json'
          }
        ]
      };
    }
  );

  // Extended resource: formulas://library
  server.resource(
    'formulas-library',
    'formulas://library',
    {
      title: 'Formula Library',
      description: 'Mathematical formulas',
      mimeType: 'application/json'
    },
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [
          {
            uri: 'formulas://library',
            text: JSON.stringify({
              quadratic: {
                formula: 'x = (-b ± √(b² - 4ac)) / 2a',
                description: 'Solves ax² + bx + c = 0'
              },
              pythagorean: {
                formula: 'a² + b² = c²',
                description: 'Relationship in right triangles'
              },
              compound_interest: {
                formula: 'A = P(1 + r/n)^(nt)',
                description: 'Future value with compound interest'
              },
              distance: {
                formula: 'd = √((x₂-x₁)² + (y₂-y₁)²)',
                description: 'Distance between two points'
              }
            }, null, 2),
            mimeType: 'application/json'
          }
        ]
      };
    }
  );

  // ==========================================
  // PROMPTS
  // ==========================================

  // Core prompt: explain-calculation
  server.registerPrompt(
    'explain-calculation',
    {
      title: 'Explain Calculation',
      description: 'Explain how to perform a calculation step by step',
      argsSchema: {
        operation: z.string().describe('The calculation to explain'),
        level: z.string().optional().describe('Explanation level: basic, intermediate, advanced')
      }
    },
    async ({ operation, level }): Promise<GetPromptResult> => {
      const actualLevel = level || 'intermediate';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please explain how to perform this calculation: ${operation}

Explanation level: ${actualLevel}

Provide a clear, step-by-step explanation appropriate for the specified level.`
            }
          }
        ]
      };
    }
  );

  // Core prompt: generate-problems
  server.registerPrompt(
    'generate-problems',
    {
      title: 'Generate Practice Problems',
      description: 'Generate math practice problems',
      argsSchema: {
        topic: z.string().describe('Math topic (e.g., "fractions", "algebra", "geometry")'),
        difficulty: z.string().describe('Difficulty level: easy, medium, hard'),
        count: z.string().describe('Number of problems to generate')
      }
    },
    async ({ topic, difficulty, count }): Promise<GetPromptResult> => {
      const problemCount = count || '5';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Generate ${problemCount} practice problems for the topic: ${topic}

Difficulty level: ${difficulty}

Include a mix of problem types and provide the answer key at the end.`
            }
          }
        ]
      };
    }
  );

  // Extended prompt: solve_math_problem
  server.registerPrompt(
    'solve_math_problem',
    {
      title: 'Solve Math Problem',
      description: 'Step-by-step problem solving',
      argsSchema: {
        problem: z.string().describe('The problem to solve'),
        showWork: z.string().describe('Show detailed work')
      }
    },
    async ({ problem, showWork }): Promise<GetPromptResult> => {
      const shouldShowWork = showWork === 'true';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Solve this math problem${shouldShowWork ? ' with detailed work' : ''}:

${problem}

Use the calculate and advanced_calculate tools as needed.`
            }
          }
        ]
      };
    }
  );

  // Extended prompt: explain_formula
  server.registerPrompt(
    'explain_formula',
    {
      title: 'Explain Formula',
      description: 'Detailed formula explanation',
      argsSchema: {
        formula: z.string().describe('The formula to explain'),
        context: z.string().optional().describe('Application context')
      }
    },
    async ({ formula, context }): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Explain this mathematical formula:

${formula}

${context ? `Context: ${context}` : ''}

Include what each variable represents and provide an example calculation.`
            }
          }
        ]
      };
    }
  );

  // Extended prompt: calculator_assistant
  server.registerPrompt(
    'calculator_assistant',
    {
      title: 'Calculator Assistant',
      description: 'General calculation assistance',
      argsSchema: {
        query: z.string().describe('What you need help calculating')
      }
    },
    async ({ query }): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Help me with: ${query}

Use available calculation tools and resources to provide a comprehensive answer.`
            }
          }
        ]
      };
    }
  );

  return server;
}

/**
 * Express app configuration
 */
const config = {
  port: parseInt(process.env['PORT'] || '1453'),
  corsOrigin: process.env['CORS_ORIGIN'] || '*',
  sessionTimeout: parseInt(process.env['SESSION_TIMEOUT'] || '1800000'), // 30 minutes
  rateLimitMax: parseInt(process.env['RATE_LIMIT_MAX'] || '1000'),
  rateLimitWindow: parseInt(process.env['RATE_LIMIT_WINDOW'] || '900000') // 15 minutes
};

async function createApp(): Promise<{ app: express.Application; eventStore: InMemoryEventStore }> {
  const app = express();
  const eventStore = new InMemoryEventStore();

  // Middleware
  app.use(cors({
    origin: config.corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'mcp-session-id', 'last-event-id'],
    exposedHeaders: ['Mcp-Session-Id']
  }));

  const limiter = rateLimit({
    windowMs: config.rateLimitWindow,
    max: config.rateLimitMax,
    message: {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Too many requests'
      },
      id: null
    }
  });
  app.use('/mcp', limiter);

  app.use(express.json({ limit: '10mb' }));

  // Session cleanup
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (now - session.lastActivity > config.sessionTimeout) {
        session.transport.close();
        session.server.close();
        sessions.delete(sessionId);
      }
    }
    eventStore.cleanup();
  }, 60000); // Every minute

  // ==========================================
  // MCP ENDPOINTS
  // ==========================================

  // POST /mcp - Command Channel
  app.post('/mcp', async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      if (sessionId) {
        // Existing session
        const session = sessions.get(sessionId);
        if (!session) {
          res.status(401).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Session not found or expired'
            },
            id: null
          });
          return;
        }
        
        session.lastActivity = Date.now();
        session.requestCount++;
        
        // Use the MCP transport properly - let it handle the request
        await session.transport.handleRequest(req, res, req.body);
      } else if (isInitializeRequest(req.body)) {
        // New session initialization
        const newSessionId = randomUUID();

        // Create session data first
        const sessionData: SessionData = {
          sessionId: newSessionId,
          transport: null as any, // Will be set below
          server: null as any, // Will be set below
          startTime: Date.now(),
          lastActivity: Date.now(),
          requestCount: 1,
          calculations: []
        };
        sessions.set(newSessionId, sessionData);

        // Create new transport for this session
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          eventStore
        });
        sessionData.transport = transport;

        // Create the MCP server
        const server = createMCPServer(newSessionId);
        sessionData.server = server;

        // Connect server to transport
        await server.connect(transport);

        // Let the transport handle the initialization request
        await transport.handleRequest(req, res, req.body);
      } else {
        res.status(401).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided or not an initialization request'
          },
          id: null
        });
      }
    } catch (error) {
      console.error('Error handling request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error'
          },
          id: null
        });
      }
    }
  });

  // GET /mcp - Announcement Channel (SSE)
  app.get('/mcp', async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string;
    // const lastEventId = req.headers['last-event-id'] as string | undefined;

    if (!sessionId) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Session ID required for announcement channel'
        },
        id: null
      });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Session not found or expired'
        },
        id: null
      });
      return;
    }

    session.lastActivity = Date.now();

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Send initial event
    res.write('event: connected\n');
    res.write('data: {"type":"connected","sessionId":"' + sessionId + '"}\n\n');

    // Keep connection alive with heartbeat
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write('event: heartbeat\n');
        res.write('data: {"type":"heartbeat","timestamp":' + Date.now() + '}\n\n');
      } else {
        clearInterval(heartbeat);
      }
    }, 30000); // 30 seconds

    req.on('close', () => {
      clearInterval(heartbeat);
    });
  });

  // DELETE /mcp - Session Termination
  app.delete('/mcp', async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string;

    if (!sessionId) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Session ID required for termination'
        },
        id: null
      });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Session not found'
        },
        id: null
      });
      return;
    }

    try {
      session.transport.close();
      session.server.close();
      sessions.delete(sessionId);
      res.status(204).send(); // No Content
    } catch (error) {
      console.error('Termination error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error'
          },
          id: null
        });
      }
    }
  });

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      sessions: sessions.size,
      uptime: process.uptime()
    });
  });

  return { app, eventStore };
}

/**
 * Start server
 */
async function startServer(): Promise<void> {
  try {
    const { app } = await createApp();
    const server: Server = createServer(app);

    server.listen(config.port, () => {
      console.log(`Calculator Learning Demo - Streamable HTTP (Stateful) running on port ${config.port}`);
      console.log(`POST http://localhost:${config.port}/mcp - Command channel`);
      console.log(`GET  http://localhost:${config.port}/mcp - Announcement channel`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log('Shutting down gracefully...');
      server.close(() => {
        for (const session of sessions.values()) {
          session.transport.close();
          session.server.close();
        }
        process.exit(0);
      });
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start if run directly (not during tests)
if (process.env['NODE_ENV'] !== 'test') {
  startServer();
}

export { startServer, createMCPServer, createApp, config };