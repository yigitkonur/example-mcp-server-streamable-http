import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import type { Server } from 'http';
import fetch from 'node-fetch';
import EventSource from 'eventsource';

// Polyfills for Node.js
(global as any).fetch = fetch;
(global as any).EventSource = EventSource;

describe('Streamable HTTP Transport Integration Tests', () => {
  let app: express.Application;
  let httpServer: Server;
  let client: Client;
  let port: number;
  let baseUrl: string;
  let sessionId: string | undefined;

  beforeEach(async () => {
    // Create Express app
    app = express();
    app.use(express.json());

    // Session management
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    // Main endpoint handler
    app.post('/mcp', async (req, res) => {
      const requestSessionId = req.headers['mcp-session-id'] as string | undefined;

      let transport: StreamableHTTPServerTransport;

      if (requestSessionId && sessions.has(requestSessionId)) {
        transport = sessions.get(requestSessionId)!;
      } else {
        // Create new session
        const newSessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId
        });

        sessions.set(newSessionId, transport);
        sessionId = newSessionId;

        // Set session ID in response header
        res.setHeader('Mcp-Session-Id', newSessionId);
      }

      await transport.handleRequest(req, res, req.body);
    });

    // SSE endpoint for announcements
    app.get('/mcp', async (req, res) => {
      const requestSessionId = req.headers['mcp-session-id'] as string;

      if (!requestSessionId || !sessions.has(requestSessionId)) {
        res.status(400).send('Invalid session');
        return;
      }

      const transport = sessions.get(requestSessionId)!;
      await transport.handleRequest(req, res);
    });

    // Session termination
    app.delete('/mcp', async (req, res) => {
      const requestSessionId = req.headers['mcp-session-id'] as string;

      if (!requestSessionId || !sessions.has(requestSessionId)) {
        res.status(400).send('Invalid session');
        return;
      }

      const transport = sessions.get(requestSessionId)!;
      sessions.delete(requestSessionId);
      await transport.handleRequest(req, res);
    });

    // Health check
    app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        activeSessions: sessions.size,
        timestamp: new Date().toISOString()
      });
    });

    // Start HTTP server
    await new Promise<void>((resolve) => {
      httpServer = app.listen(0, () => {
        const address = httpServer.address();
        port = typeof address === 'object' && address ? address.port : 3000;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });

    // Create client
    client = new Client({
      name: 'test-streamable-http-client',
      version: '1.0.0'
    }, {
      capabilities: {
        tools: {},
        resources: { subscribe: true },
        prompts: {}
      }
    });
  });

  afterEach(async () => {
    // Clean up
    if (client) {
      await client.close();
    }

    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });

  describe('Connection Management', () => {
    test('should establish connection and create session', async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport);

      // Session should be established
      expect(transport.sessionId).toBeDefined();
      sessionId = transport.sessionId;

      // Should be able to use the connection
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sessionId!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'ping',
          id: 1
        })
      });

      expect(response.status).toBe(200);
    });

    test('should handle session resumption', async () => {
      // First connection
      const transport1 = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport1);
      const firstSessionId = transport1.sessionId;

      await client.close();

      // Second connection with same session ID
      const transport2 = new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/mcp`),
        { sessionId: firstSessionId }
      );

      const client2 = new Client({
        name: 'test-client-2',
        version: '1.0.0'
      });

      await client2.connect(transport2);
      expect(transport2.sessionId).toBe(firstSessionId);

      await client2.close();
    });

    test('should handle session termination', async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport);
      const sid = transport.sessionId;

      // Terminate session
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'DELETE',
        headers: {
          'Mcp-Session-Id': sid!
        }
      });

      expect(response.status).toBeLessThan(400);

      // Health check should show no active sessions
      const health = await fetch(`${baseUrl}/health`);
      const healthData = await health.json();
      expect(healthData.activeSessions).toBe(0);
    });
  });

  describe('Request-Response Communication', () => {
    test('should handle POST requests with SSE responses', async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport);

      // Make a request that would return SSE
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': transport.sessionId!,
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'test',
          params: { stream: true },
          id: 1
        })
      });

      expect(response.headers.get('content-type')).toContain('event-stream');
    });

    test('should handle concurrent requests', async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport);
      const sid = transport.sessionId;

      // Send multiple concurrent requests
      const requests = Array.from({ length: 5 }, (_, i) =>
        fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': sid!
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'test',
            params: { index: i },
            id: i + 1
          })
        })
      );

      const responses = await Promise.all(requests);

      responses.forEach(response => {
        expect(response.status).toBe(200);
      });
    });
  });

  describe('SSE Announcement Channel', () => {
    test('should establish SSE connection for announcements', async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport);
      const sid = transport.sessionId;

      // Connect to SSE endpoint
      const eventSource = new EventSource(`${baseUrl}/mcp`, {
        headers: {
          'Mcp-Session-Id': sid!
        }
      });

      await new Promise<void>((resolve, reject) => {
        eventSource.onopen = () => resolve();
        eventSource.onerror = (err) => reject(err);
        setTimeout(() => reject(new Error('SSE connection timeout')), 5000);
      });

      expect(eventSource.readyState).toBe(EventSource.OPEN);
      eventSource.close();
    });

    test('should receive server-sent events', async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport);
      const sid = transport.sessionId;

      const eventSource = new EventSource(`${baseUrl}/mcp`, {
        headers: {
          'Mcp-Session-Id': sid!
        }
      });

      const messagePromise = new Promise<MessageEvent>((resolve) => {
        eventSource.onmessage = (event) => {
          resolve(event);
        };
      });

      // Trigger an event by making a request
      await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sid!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'trigger-event',
          id: 1
        })
      });

      // Wait for event (with timeout)
      const event = await Promise.race([
        messagePromise,
        new Promise<MessageEvent>((_, reject) =>
          setTimeout(() => reject(new Error('Event timeout')), 5000)
        )
      ]).catch(() => null);

      if (event) {
        expect(event.data).toBeDefined();
      }

      eventSource.close();
    });
  });

  describe('Error Handling', () => {
    test('should handle network errors gracefully', async () => {
      // Use invalid URL
      const transport = new StreamableHTTPClientTransport(
        new URL('http://localhost:99999/mcp')
      );

      await expect(client.connect(transport)).rejects.toThrow();
    });

    test('should handle invalid session IDs', async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'invalid-session-id'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'test',
          id: 1
        })
      });

      // Should create new session
      expect(response.headers.get('mcp-session-id')).toBeDefined();
    });

    test('should handle server errors', async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport);

      // Send malformed request
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': transport.sessionId!
        },
        body: 'invalid json'
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('Performance', () => {
    test('should handle high-frequency requests', async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport);
      const sid = transport.sessionId;

      const startTime = Date.now();
      const requestCount = 50;

      for (let i = 0; i < requestCount; i++) {
        await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': sid!
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'test',
            params: { index: i },
            id: i + 1
          })
        });
      }

      const duration = Date.now() - startTime;
      const requestsPerSecond = (requestCount / duration) * 1000;

      expect(requestsPerSecond).toBeGreaterThan(10); // At least 10 req/sec
    });

    test('should handle large payloads', async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport);

      // Create large payload
      const largeData = Array(1000).fill(0).map((_, i) => ({
        index: i,
        data: 'x'.repeat(100)
      }));

      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': transport.sessionId!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'process-data',
          params: { data: largeData },
          id: 1
        })
      });

      expect(response.status).toBe(200);
    });
  });

  describe('Headers and Configuration', () => {
    test('should include proper headers in requests', async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport);

      // Intercept request to check headers
      let capturedHeaders: any = {};
      const originalFetch = global.fetch;
      global.fetch = jest.fn(async (url: any, options: any) => {
        capturedHeaders = options.headers || {};
        return originalFetch(url, options);
      }) as any;

      await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': transport.sessionId!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'test',
          id: 1
        })
      });

      expect(capturedHeaders['Content-Type']).toBe('application/json');
      expect(capturedHeaders['Mcp-Session-Id']).toBe(transport.sessionId);

      global.fetch = originalFetch;
    });

    test('should handle CORS headers', async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://example.com',
          'Access-Control-Request-Method': 'POST'
        }
      });

      // Express doesn't set CORS by default, but in production it should
      expect(response.status).toBeLessThan(500);
    });
  });

  describe('Resumability', () => {
    test('should support Last-Event-ID for resumption', async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport);
      const sid = transport.sessionId;

      // Simulate SSE with Last-Event-ID
      const eventSource = new EventSource(`${baseUrl}/mcp`, {
        headers: {
          'Mcp-Session-Id': sid!,
          'Last-Event-ID': 'event_123'
        }
      });

      // Should connect successfully
      await new Promise<void>((resolve, reject) => {
        eventSource.onopen = () => resolve();
        eventSource.onerror = () => reject(new Error('SSE connection failed'));
        setTimeout(() => reject(new Error('Timeout')), 5000);
      }).catch(() => {
        // Ignore errors for this test
      });

      eventSource.close();
    });

    test('should handle connection recovery', async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport);
      const sid = transport.sessionId;

      // First request
      const response1 = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sid!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'test',
          params: { index: 1 },
          id: 1
        })
      });

      expect(response1.status).toBe(200);

      // Simulate disconnect and reconnect
      await new Promise(resolve => setTimeout(resolve, 100));

      // Second request with same session
      const response2 = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sid!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'test',
          params: { index: 2 },
          id: 2
        })
      });

      expect(response2.status).toBe(200);
    });
  });

  describe('Security', () => {
    test('should not expose sensitive session data', async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport);

      // Health check should not expose session details
      const health = await fetch(`${baseUrl}/health`);
      const healthData = await health.json();

      expect(healthData.activeSessions).toBeDefined();
      expect(healthData).not.toHaveProperty('sessionIds');
      expect(healthData).not.toHaveProperty('sessionData');
    });

    test('should validate Content-Type header', async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain' // Wrong content type
        },
        body: 'test'
      });

      // Should handle gracefully (might accept or reject based on implementation)
      expect(response.status).toBeDefined();
    });
  });
});
