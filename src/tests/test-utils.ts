/**
 * Shared test utilities for Streamable HTTP MCP server testing
 * Provides common test helpers and fixtures
 */

// Removed unused imports
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import type { Server } from 'http';
import { performance } from 'perf_hooks';

/**
 * Standard test timeout for async operations
 */
export const TEST_TIMEOUT = 10000;

/**
 * Helper to create a test Express app with Streamable HTTP transport
 */
export async function createTestServer(
  setupTransport?: (transport: StreamableHTTPServerTransport) => Promise<void>
): Promise<{
  app: express.Application;
  server: Server;
  port: number;
  baseUrl: string;
  sessions: Map<string, StreamableHTTPServerTransport>;
  cleanup: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  // Main endpoint
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && sessions.has(sessionId)) {
      transport = sessions.get(sessionId) as StreamableHTTPServerTransport;
    } else {
      const newSessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId
      });

      if (setupTransport) {
        await setupTransport(transport);
      }

      sessions.set(newSessionId, transport);
      res.setHeader('Mcp-Session-Id', newSessionId);
    }

    await transport.handleRequest(req, res, req.body);
  });

  // SSE endpoint
  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string;

    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send('Invalid session');
      return;
    }

    const transport = sessions.get(sessionId) as StreamableHTTPServerTransport;
    await transport.handleRequest(req, res);
  });

  // Session termination
  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string;

    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send('Invalid session');
      return;
    }

    const transport = sessions.get(sessionId) as StreamableHTTPServerTransport;
    sessions.delete(sessionId);
    await transport.handleRequest(req, res);
  });

  // Health endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      activeSessions: sessions.size,
      timestamp: new Date().toISOString()
    });
  });

  // Start server
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 3000;
      const baseUrl = `http://localhost:${port}`;

      resolve({
        app,
        server,
        port,
        baseUrl,
        sessions,
        cleanup: async () => {
          await new Promise<void>((res, rej) => {
            server.close((err) => {
              if (err) {
                rej(err);
              } else {
                res();
              }
            });
          });
        }
      });
    });
  });
}

/**
 * Session test data
 */
export const SESSION_TEST_DATA = {
  validSessionId: 'session_1234567890_abcdef',
  invalidSessionId: 'invalid_session',
  expiredSessionId: 'session_expired_12345'
};

/**
 * Helper to extract session ID from response headers
 */
export function extractSessionId(response: Response | { headers?: { get?: (key: string) => string | null; [key: string]: unknown } }): string | undefined {
  return response.headers?.get?.('mcp-session-id') ||
         (response.headers as any)?.['mcp-session-id'];
}

/**
 * Helper to create session headers
 */
export function createSessionHeaders(sessionId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Mcp-Session-Id': sessionId
  };
}

/**
 * Helper to create SSE headers
 */
export function createSSEHeaders(sessionId: string, lastEventId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Mcp-Session-Id': sessionId,
    'Accept': 'text/event-stream'
  };

  if (lastEventId) {
    headers['Last-Event-ID'] = lastEventId;
  }

  return headers;
}

/**
 * Test helper for progress notifications
 */
export interface ProgressNotification {
  progressToken: string;
  progress: number;
  total: number;
  message: string | undefined;
}

export function createProgressNotification(
  token: string,
  progress: number,
  total: number = 1.0,
  message?: string
): ProgressNotification {
  return {
    progressToken: token,
    progress,
    total,
    message
  };
}

/**
 * Helper to validate calculation results with session info
 */
export function validateSessionCalculationResult(
  result: CallToolResult,
  expectedValue?: number,
  expectError: boolean = false
): void {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe('text');

  if (!expectError && expectedValue !== undefined) {
    expect(result.content[0]!.text).toContain(expectedValue.toString());
  }
}

/**
 * Helper to parse SSE messages
 */
export function parseSSEMessage(data: string): unknown {
  const lines = data.trim().split('\n');
  const message: Record<string, unknown> = {};

  for (const line of lines) {
    if (line.startsWith('id:')) {
      message['id'] = line.substring(3).trim();
    } else if (line.startsWith('event:')) {
      message['event'] = line.substring(6).trim();
    } else if (line.startsWith('data:')) {
      const jsonData = line.substring(5).trim();
      try {
        message['data'] = JSON.parse(jsonData);
      } catch {
        message['data'] = jsonData;
      }
    }
  }

  return message;
}

/**
 * Helper to wait for SSE connection
 */
export async function waitForSSEConnection(
  eventSource: EventSource,
  timeout: number = 5000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('SSE connection timeout'));
    }, timeout);

    eventSource.onopen = () => {
      clearTimeout(timer);
      resolve();
    };

    eventSource.onerror = (error) => {
      clearTimeout(timer);
      reject(error);
    };
  });
}

/**
 * Helper to collect SSE messages
 */
export async function collectSSEMessages(
  eventSource: EventSource,
  count: number,
  timeout: number = 5000
): Promise<MessageEvent[]> {
  const messages: MessageEvent[] = [];

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eventSource.close();
      reject(new Error(`Timeout waiting for ${count} messages, got ${messages.length}`));
    }, timeout);

    eventSource.onmessage = (event) => {
      messages.push(event);
      if (messages.length >= count) {
        clearTimeout(timer);
        eventSource.close();
        resolve(messages);
      }
    };

    eventSource.onerror = (error) => {
      clearTimeout(timer);
      eventSource.close();
      reject(error);
    };
  });
}

/**
 * Test data for session-based calculations
 */
export const SESSION_CALCULATION_DATA = {
  calculations: [
    { operation: 'add', input_1: 10, input_2: 5, showProgress: true },
    { operation: 'multiply', input_1: 3, input_2: 7, showProgress: false },
    { operation: 'divide', input_1: 20, input_2: 4, showProgress: true },
    { operation: 'power', input_1: 2, input_2: 8, showProgress: false },
    { operation: 'sqrt', input_1: 64, showProgress: true }
  ],

  batchCalculations: [
    { operation: 'add', inputs: [1, 2, 3, 4, 5] },
    { operation: 'multiply', inputs: [2, 4, 6, 8, 10] }
  ]
};

/**
 * Helper to simulate network latency
 */
export async function simulateLatency(ms: number = 100): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Helper to create a mock EventStore for testing
 */
export class MockEventStore {
  private events: Map<string, Array<{ id: string; data: unknown; timestamp: number }>> = new Map();

  async storeEvent(streamId: string, eventId: string, data: unknown): Promise<void> {
    if (!this.events.has(streamId)) {
      this.events.set(streamId, []);
    }

    const events = this.events.get(streamId);
    if (events) {
      events.push({
        id: eventId,
        data,
        timestamp: Date.now()
      });
    }
  }

  async getEventsSince(streamId: string, lastEventId?: string): Promise<Array<{ id: string; data: unknown }>> {
    const streamEvents = this.events.get(streamId) || [];

    if (!lastEventId) {
      return streamEvents;
    }

    const lastIndex = streamEvents.findIndex(e => e.id === lastEventId);
    if (lastIndex === -1) {
      return streamEvents;
    }

    return streamEvents.slice(lastIndex + 1);
  }

  clear(): void {
    this.events.clear();
  }
}

/**
 * Helper to validate session statistics
 */
export function validateSessionStats(stats: Record<string, unknown>, expectations: {
  minCalculations?: number;
  maxErrors?: number;
  hasRecentCalculations?: boolean;
}): void {
  expect(stats).toBeDefined();
  expect(stats['sessionId']).toBeDefined();
  expect(stats['totalCalculations']).toBeDefined();

  if (expectations.minCalculations !== undefined) {
    expect(stats['totalCalculations']).toBeGreaterThanOrEqual(expectations.minCalculations);
  }

  if (expectations.hasRecentCalculations) {
    expect(stats['recentCalculations']).toBeDefined();
    expect(Array.isArray(stats['recentCalculations'])).toBe(true);
    expect((stats['recentCalculations'] as any[]).length).toBeGreaterThan(0);
  }
}

/**
 * Performance testing helpers
 */
export async function measureRequestLatency(
  url: string,
  options: RequestInit
): Promise<{ response: Response; latency: number }> {
  const startTime = performance.now();
  const response = await fetch(url, options);
  const latency = performance.now() - startTime;

  return { response, latency };
}

export function calculateStats(latencies: number[]): {
  mean: number;
  median: number;
  min: number;
  max: number;
  p95: number;
  p99: number;
} {
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, val) => acc + val, 0);

  return {
    mean: sum / sorted.length,
    median: sorted[Math.floor(sorted.length / 2)]!,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    p95: sorted[Math.floor(sorted.length * 0.95)]!,
    p99: sorted[Math.floor(sorted.length * 0.99)]!
  };
}
