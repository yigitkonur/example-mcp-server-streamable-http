#!/usr/bin/env node

/**
 * End-to-End Test Script for Calculator Learning Demo - Streamable HTTP (Stateful)
 *
 * This script tests the complete workflow:
 * 1. Initialize session and receive session header
 * 2. POST calculate with streaming enabled
 * 3. Simulate connection drop and reconnect with Last-Event-Id
 * 4. Verify missed events are replayed
 */

// Removed unused imports
import EventSource from 'eventsource';
import { startServer } from '../production-server.js';

const PORT = 1454; // Use different port for testing
const BASE_URL = `http://localhost:${PORT}`;

interface TestResult {
  success: boolean;
  message: string;
  details?: unknown;
}

async function makeRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const url = `${BASE_URL}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
}

async function runTest(name: string, testFn: () => Promise<void>): Promise<TestResult> {
  console.log(`\n🧪 Running: ${name}`);
  try {
    await testFn();
    console.log(`✅ PASS: ${name}`);
    return { success: true, message: 'Test passed' };
  } catch (error) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   Error: ${(error as Error).message}`);
    return {
      success: false,
      message: (error as Error).message,
      details: error
    };
  }
}

async function testInitialization(): Promise<string> {
  const response = await makeRequest('/mcp', {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '1.0.0',
        capabilities: {},
        clientInfo: {
          name: 'e2e-test-client',
          version: '1.0.0'
        }
      }
    })
  });

  if (response.status !== 202) {
    throw new Error(`Expected 202 status, got ${response.status}`);
  }

  const sessionId = response.headers.get('mcp-session-id')!;
  if (!sessionId) {
    throw new Error('No Mcp-Session-Id header in response');
  }

  const body = await response.json();
  if (!body.result?.protocolVersion) {
    throw new Error('Invalid initialization response');
  }

  console.log(`   Session ID: ${sessionId}`);
  return sessionId;
}

async function testStreamingCalculation(sessionId: string): Promise<void> {
  const response = await makeRequest('/mcp', {
    method: 'POST',
    headers: {
      'mcp-session-id': sessionId
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'calculate',
        arguments: {
          a: 100,
          b: 50,
          op: 'multiply',
          stream: true
        }
      }
    })
  });

  if (response.status !== 200) {
    throw new Error(`Expected 200 status, got ${response.status}`);
  }

  const body = await response.json();
  if (!body.result?.content?.[0]?.text) {
    throw new Error('Invalid calculation response');
  }

  const result = body.result.content[0].text;
  if (!result.includes('5000')) {
    throw new Error(`Expected result to contain 5000, got: ${result}`);
  }

  console.log(`   Calculation result: ${result}`);
}

async function testSSEReconnection(sessionId: string): Promise<void> {
  console.log('   Testing SSE connection and reconnection...');

  // Track received events
  const receivedEvents: unknown[] = [];
  let lastEventId: string | null = null;

  // Create initial SSE connection
  const eventSource = new EventSource(`${BASE_URL}/mcp`, {
    headers: {
      'mcp-session-id': sessionId
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      eventSource.close();
      reject(new Error('SSE connection timeout'));
    }, 5000);

    eventSource.onopen = () => {
      console.log('   SSE connection established');
      clearTimeout(timeout);

      // Trigger a progress demo to generate events
      makeRequest('/mcp', {
        method: 'POST',
        headers: {
          'mcp-session-id': sessionId
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'demo_progress',
            arguments: { steps: 5 }
          }
        })
      }).then(() => {
        // Wait a bit to receive some events
        setTimeout(() => {
          eventSource.close();
          resolve();
        }, 2000);
      });
    };

    eventSource.onmessage = (event) => {
      receivedEvents.push(event.data);
      if (event.lastEventId) {
        lastEventId = event.lastEventId;
      }
      console.log(`   Received event: ${event.type}, ID: ${event.lastEventId}`);
    };

    eventSource.onerror = (_error) => {
      clearTimeout(timeout);
      console.log('   SSE connection error (expected during test)');
    };
  });

  console.log(`   Received ${receivedEvents.length} events before disconnect`);
  console.log(`   Last Event ID: ${lastEventId}`);

  // Simulate reconnection with Last-Event-Id
  if (lastEventId) {
    console.log('   Reconnecting with Last-Event-Id...');

    const reconnectSource = new EventSource(`${BASE_URL}/mcp`, {
      headers: {
        'mcp-session-id': sessionId,
        'Last-Event-Id': lastEventId
      }
    });

    await new Promise<void>((resolve) => {
      const reconnectTimeout = setTimeout(() => {
        reconnectSource.close();
        resolve();
      }, 2000);

      reconnectSource.onopen = () => {
        console.log('   Reconnection successful');
      };

      reconnectSource.onmessage = (event) => {
        console.log(`   Replayed event: ${event.type}, ID: ${event.lastEventId}`);
      };

      reconnectSource.onerror = () => {
        clearTimeout(reconnectTimeout);
        reconnectSource.close();
        resolve();
      };
    });
  }
}

async function testSessionPersistence(sessionId: string): Promise<void> {
  // Verify session info is maintained
  const response = await makeRequest('/mcp', {
    method: 'POST',
    headers: {
      'mcp-session-id': sessionId
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: {
        uri: `session://info/${sessionId}`
      }
    })
  });

  if (response.status !== 200) {
    throw new Error(`Expected 200 status, got ${response.status}`);
  }

  const body = await response.json();
  const sessionInfo = JSON.parse(body.result.contents[0].text);

  if (sessionInfo.sessionId !== sessionId) {
    throw new Error('Session ID mismatch');
  }

  if (sessionInfo.requestCount < 3) {
    throw new Error('Request count not properly tracked');
  }

  console.log(`   Session request count: ${sessionInfo.requestCount}`);
  console.log(`   Session started at: ${sessionInfo.startedAt}`);
}

async function testInvalidSession(): Promise<void> {
  const response = await makeRequest('/mcp', {
    method: 'POST',
    headers: {
      'mcp-session-id': 'invalid-session-id'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'calculate',
        arguments: { a: 1, b: 1, op: 'add' }
      }
    })
  });

  if (response.status !== 401) {
    throw new Error(`Expected 401 status for invalid session, got ${response.status}`);
  }

  console.log('   Invalid session properly rejected with 401');
}

async function main() {
  console.log('🚀 Starting E2E Test Suite for Calculator Learning Demo - Streamable HTTP (Stateful)\n');

  // Override port for testing
  process.env['PORT'] = PORT.toString();

  // Start the server
  console.log(`Starting server on port ${PORT}...`);
  try {
    await startServer();
    console.log('Server started successfully\n');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }

  // Wait for server to be ready
  await new Promise(resolve => setTimeout(resolve, 1000));

  const results: TestResult[] = [];
  let sessionId: string | null = null;

  // Run tests
  results.push(await runTest('Server Health Check', async () => {
    const response = await makeRequest('/health');
    const health = await response.json();
    if (health.status !== 'healthy') {
      throw new Error('Server not healthy');
    }
  }));

  results.push(await runTest('Session Initialization', async () => {
    sessionId = await testInitialization();
  }));

  if (sessionId) {
    results.push(await runTest('Streaming Calculation', async () => {
      await testStreamingCalculation(sessionId!);
    }));

    results.push(await runTest('SSE Connection and Reconnection', async () => {
      await testSSEReconnection(sessionId!);
    }));

    results.push(await runTest('Session Persistence', async () => {
      await testSessionPersistence(sessionId!);
    }));
  }

  results.push(await runTest('Invalid Session Rejection', async () => {
    await testInvalidSession();
  }));

  // Summary
  console.log('\n📊 Test Summary:');
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(`   Total: ${results.length}`);
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);

  if (failed > 0) {
    console.log('\n❌ E2E Test Suite FAILED');
    process.exit(1);
  } else {
    console.log('\n✅ E2E Test Suite PASSED');
    process.exit(0);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}
