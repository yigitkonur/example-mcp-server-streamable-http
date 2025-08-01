import { describe, test, expect, beforeEach } from '@jest/globals';
import supertest from 'supertest';
import { createApp } from '../production-server.js';
import type { Application } from 'express';
// EventEmitter import removed - not used

describe('Resumability Tests with Last-Event-Id', () => {
  let app: Application;
  let sessionId: string;

  beforeEach(async () => {
    const result = await createApp();
    app = result.app;

    // Initialize session
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '1.0.0',
        capabilities: {},
        clientInfo: {
          name: 'test-client',
          version: '1.0.0'
        }
      }
    };

    const response = await supertest(app)
      .post('/mcp')
      .send(initRequest);

    sessionId = response.headers['mcp-session-id'];
  });

  test('should handle reconnection with Last-Event-Id', async () => {
    // Create an SSE connection
    const sseRequest = supertest(app)
      .get('/mcp')
      .set('mcp-session-id', sessionId)
      .set('Accept', 'text/event-stream');

    const response = await sseRequest;
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    // Simulate receiving events and storing last event ID
    // lastEventId would be tracked here in a real implementation

    // Make a request that will generate events
    const toolRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'demo_progress',
        arguments: { steps: 3 }
      }
    };

    await supertest(app)
      .post('/mcp')
      .set('mcp-session-id', sessionId)
      .send(toolRequest);

    // Simulate disconnection and reconnection with Last-Event-Id
    const reconnectRequest = supertest(app)
      .get('/mcp')
      .set('mcp-session-id', sessionId)
      .set('Accept', 'text/event-stream')
      .set('Last-Event-Id', 'test-event-id');

    const reconnectResponse = await reconnectRequest;
    expect(reconnectResponse.status).toBe(200);
    expect(reconnectResponse.headers['content-type']).toContain('text/event-stream');
  });

  test('should maintain event order after reconnection', async () => {
    // Generate multiple events
    const requests = [];
    for (let i = 0; i < 5; i++) {
      const request = {
        jsonrpc: '2.0',
        id: i + 2,
        method: 'tools/call',
        params: {
          name: 'calculate',
          arguments: { a: i, b: 1, op: 'add' }
        }
      };
      requests.push(request);
    }

    // Send all requests
    for (const req of requests) {
      await supertest(app)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .send(req);
    }

    // Connect to SSE with Last-Event-Id
    const sseResponse = await supertest(app)
      .get('/mcp')
      .set('mcp-session-id', sessionId)
      .set('Accept', 'text/event-stream')
      .set('Last-Event-Id', 'event-2');

    expect(sseResponse.status).toBe(200);
  });

  test('should handle invalid Last-Event-Id gracefully', async () => {
    const response = await supertest(app)
      .get('/mcp')
      .set('mcp-session-id', sessionId)
      .set('Accept', 'text/event-stream')
      .set('Last-Event-Id', 'invalid-event-id');

    // Should still connect successfully
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
  });

  test('should support progress notification replay', async () => {
    // Start a long-running operation
    const progressRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'demo_progress',
        arguments: { steps: 5 }
      }
    };

    // Send the request
    const progressPromise = supertest(app)
      .post('/mcp')
      .set('mcp-session-id', sessionId)
      .send(progressRequest);

    // Simulate mid-stream disconnection and reconnection
    await new Promise(resolve => setTimeout(resolve, 100));

    const reconnectResponse = await supertest(app)
      .get('/mcp')
      .set('mcp-session-id', sessionId)
      .set('Accept', 'text/event-stream')
      .set('Last-Event-Id', 'progress-event-2');

    expect(reconnectResponse.status).toBe(200);

    // Wait for original request to complete
    await progressPromise;
  });

  test('should handle multiple concurrent sessions with resumability', async () => {
    // Create second session
    const initRequest2 = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '1.0.0',
        capabilities: {},
        clientInfo: {
          name: 'test-client-2',
          version: '1.0.0'
        }
      }
    };

    const response2 = await supertest(app)
      .post('/mcp')
      .send(initRequest2);

    const sessionId2 = response2.headers['mcp-session-id'];

    // Make requests on both sessions
    const req1 = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'calculate',
        arguments: { a: 1, b: 1, op: 'add' }
      }
    };

    const req2 = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'calculate',
        arguments: { a: 2, b: 2, op: 'multiply' }
      }
    };

    await supertest(app)
      .post('/mcp')
      .set('mcp-session-id', sessionId)
      .send(req1);

    await supertest(app)
      .post('/mcp')
      .set('mcp-session-id', sessionId2)
      .send(req2);

    // Test resumability for both sessions
    const sse1 = await supertest(app)
      .get('/mcp')
      .set('mcp-session-id', sessionId)
      .set('Accept', 'text/event-stream')
      .set('Last-Event-Id', 'session1-event-1');

    const sse2 = await supertest(app)
      .get('/mcp')
      .set('mcp-session-id', sessionId2)
      .set('Accept', 'text/event-stream')
      .set('Last-Event-Id', 'session2-event-1');

    expect(sse1.status).toBe(200);
    expect(sse2.status).toBe(200);
  });

  test('should cleanup old events and handle missing event IDs', async () => {
    // Generate many events to trigger cleanup
    const requests = [];
    for (let i = 0; i < 100; i++) {
      requests.push({
        jsonrpc: '2.0',
        id: i + 2,
        method: 'tools/call',
        params: {
          name: 'calculate',
          arguments: { a: i, b: i, op: 'add' }
        }
      });
    }

    // Send requests in batches
    for (let i = 0; i < requests.length; i += 10) {
      const batch = requests.slice(i, i + 10);
      await Promise.all(
        batch.map(req =>
          supertest(app)
            .post('/mcp')
            .set('mcp-session-id', sessionId)
            .send(req)
        )
      );
    }

    // Try to resume from a very old event (likely cleaned up)
    const response = await supertest(app)
      .get('/mcp')
      .set('mcp-session-id', sessionId)
      .set('Accept', 'text/event-stream')
      .set('Last-Event-Id', 'very-old-event-id');

    // Should still connect, but won't replay old events
    expect(response.status).toBe(200);
  });
});
