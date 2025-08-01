import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import supertest from 'supertest';
import { createApp } from '../production-server.js';
import type { Application } from 'express';

describe('Calculator Learning Demo - Streamable HTTP (Stateful) Tests', () => {
  let app: Application;
  let sessionId: string;

  beforeEach(async () => {
    const result = await createApp();
    app = result.app;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Session Management', () => {
    test('should return 202 Accepted with Mcp-Session-Id header on initialization', async () => {
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
        .send(initRequest)
        .expect(202);

      expect(response.headers['mcp-session-id']).toBeDefined();
      sessionId = response.headers['mcp-session-id'];
      expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    test('should reject requests without session ID with 401', async () => {
      const toolRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'calculate',
          arguments: { a: 1, b: 2, op: 'add' }
        }
      };

      await supertest(app)
        .post('/mcp')
        .send(toolRequest)
        .expect(401);
    });

    test('should reject requests with invalid session ID with 401', async () => {
      const toolRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'calculate',
          arguments: { a: 1, b: 2, op: 'add' }
        }
      };

      await supertest(app)
        .post('/mcp')
        .set('mcp-session-id', 'invalid-session-id')
        .send(toolRequest)
        .expect(401);
    });

    test('should accept requests with valid session ID', async () => {
      // First initialize
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

      const initResponse = await supertest(app)
        .post('/mcp')
        .send(initRequest)
        .expect(202);

      sessionId = initResponse.headers['mcp-session-id'];

      // Then make a tool call
      const toolRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'calculate',
          arguments: { a: 5, b: 3, op: 'add' }
        }
      };

      const response = await supertest(app)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .send(toolRequest)
        .expect(200);

      const result = response.body;
      expect(result.result).toBeDefined();
      expect(result.result.content).toBeDefined();
      expect(result.result.content[0].text).toBe('5 add 3 = 8');
    });
  });

  describe('Core Tools', () => {
    beforeEach(async () => {
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

    test('calculate tool should perform basic arithmetic', async () => {
      const operations = [
        { a: 10, b: 5, op: 'add', expected: 15 },
        { a: 10, b: 5, op: 'subtract', expected: 5 },
        { a: 10, b: 5, op: 'multiply', expected: 50 },
        { a: 10, b: 5, op: 'divide', expected: 2 }
      ];

      for (const { a, b, op, expected } of operations) {
        const request = {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'calculate',
            arguments: { a, b, op }
          }
        };

        const response = await supertest(app)
          .post('/mcp')
          .set('mcp-session-id', sessionId)
          .send(request)
          .expect(200);

        expect(response.body.result.content[0].text).toBe(`${a} ${op} ${b} = ${expected}`);
      }
    });

    test('calculate tool should handle division by zero', async () => {
      const request = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'calculate',
          arguments: { a: 10, b: 0, op: 'divide' }
        }
      };

      const response = await supertest(app)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .send(request)
        .expect(200);

      expect(response.body.error).toBeDefined();
      expect(response.body.error.message).toContain('Division by zero');
    });
  });

  describe('Extended Tools', () => {
    beforeEach(async () => {
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

    test('batch_calculate should process multiple calculations', async () => {
      const request = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'batch_calculate',
          arguments: {
            calculations: [
              { a: 10, b: 5, op: 'add' },
              { a: 20, b: 4, op: 'multiply' }
            ]
          }
        }
      };

      const response = await supertest(app)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .send(request)
        .expect(200);

      const result = JSON.parse(response.body.result.content[0].text);
      expect(result).toHaveLength(2);
      expect(result[0].result).toBe(15);
      expect(result[1].result).toBe(80);
    });

    test('advanced_calculate should handle advanced operations', async () => {
      const operations = [
        { operation: 'factorial', value: 5, expected: 120 },
        { operation: 'sqrt', value: 16, expected: 4 },
        { operation: 'power', value: 2, base: 3, expected: 8 }
      ];

      for (const op of operations) {
        const request = {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'advanced_calculate',
            arguments: op
          }
        };

        const response = await supertest(app)
          .post('/mcp')
          .set('mcp-session-id', sessionId)
          .send(request)
          .expect(200);

        expect(response.body.result.content[0].text).toContain(op.expected.toString());
      }
    });
  });

  describe('Resources', () => {
    beforeEach(async () => {
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

    test('should provide calculator constants', async () => {
      const request = {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: {
          uri: 'calculator://constants'
        }
      };

      const response = await supertest(app)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .send(request)
        .expect(200);

      const constants = JSON.parse(response.body.result.contents[0].text);
      expect(constants.pi).toBeCloseTo(Math.PI);
      expect(constants.e).toBeCloseTo(Math.E);
      expect(constants.sqrt2).toBeCloseTo(Math.SQRT2);
    });

    test('should provide session info', async () => {
      const request = {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: {
          uri: `session://info/${sessionId}`
        }
      };

      const response = await supertest(app)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .send(request)
        .expect(200);

      const info = JSON.parse(response.body.result.contents[0].text);
      expect(info.sessionId).toBe(sessionId);
      expect(info.startedAt).toBeDefined();
      expect(info.requestCount).toBeGreaterThan(0);
    });

    test('should track calculation history', async () => {
      // First do a calculation
      const calcRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'calculate',
          arguments: { a: 10, b: 5, op: 'add' }
        }
      };

      await supertest(app)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .send(calcRequest);

      // Then check stats
      const statsRequest = {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: {
          uri: 'calculator://stats'
        }
      };

      const response = await supertest(app)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .send(statsRequest)
        .expect(200);

      const stats = JSON.parse(response.body.result.contents[0].text);
      expect(stats.totalCalculations).toBeGreaterThan(0);
      expect(stats.operationCounts.add).toBe(1);
    });
  });

  describe('Prompts', () => {
    beforeEach(async () => {
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

    test('should provide explain-calculation prompt', async () => {
      const request = {
        jsonrpc: '2.0',
        id: 2,
        method: 'prompts/get',
        params: {
          name: 'explain-calculation',
          arguments: {
            operation: '10 + 5',
            level: 'basic'
          }
        }
      };

      const response = await supertest(app)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .send(request)
        .expect(200);

      expect(response.body.result.messages).toHaveLength(1);
      expect(response.body.result.messages[0].content.text).toContain('10 + 5');
      expect(response.body.result.messages[0].content.text).toContain('basic');
    });

    test('should provide generate-problems prompt', async () => {
      const request = {
        jsonrpc: '2.0',
        id: 2,
        method: 'prompts/get',
        params: {
          name: 'generate-problems',
          arguments: {
            topic: 'fractions',
            difficulty: 'medium',
            count: '3'
          }
        }
      };

      const response = await supertest(app)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .send(request)
        .expect(200);

      expect(response.body.result.messages).toHaveLength(1);
      expect(response.body.result.messages[0].content.text).toContain('3 practice problems');
      expect(response.body.result.messages[0].content.text).toContain('fractions');
      expect(response.body.result.messages[0].content.text).toContain('medium');
    });
  });

  describe('SSE Announcement Channel', () => {
    test('should reject GET requests without session ID with 401', async () => {
      await supertest(app)
        .get('/mcp')
        .expect(401);
    });

    test('should reject GET requests with invalid session ID with 401', async () => {
      await supertest(app)
        .get('/mcp')
        .set('mcp-session-id', 'invalid-session-id')
        .expect(401);
    });

    test('should accept GET requests with valid session ID', async () => {
      // First initialize
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

      const initResponse = await supertest(app)
        .post('/mcp')
        .send(initRequest);

      sessionId = initResponse.headers['mcp-session-id'];

      // Then connect to SSE
      const response = await supertest(app)
        .get('/mcp')
        .set('mcp-session-id', sessionId)
        .set('Accept', 'text/event-stream');

      // Should return 200 and set appropriate headers
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
    });
  });

  describe('Health Endpoints', () => {
    test('should provide health status', async () => {
      const response = await supertest(app)
        .get('/health')
        .expect(200);

      expect(response.body.status).toBe('healthy');
      expect(response.body.timestamp).toBeDefined();
      expect(response.body.sessions).toBeDefined();
      expect(response.body.uptime).toBeDefined();
    });
  });
});
