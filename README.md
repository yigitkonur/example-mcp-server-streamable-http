<div align="center">

**[STDIO](https://github.com/yigitkonur/example-mcp-server-stdio) | [Stateful HTTP](https://github.com/yigitkonur/example-mcp-server-streamable-http) | [Stateless HTTP](https://github.com/yigitkonur/example-mcp-server-streamable-http-stateless) | [SSE](https://github.com/yigitkonur/example-mcp-server-sse)**

</div>

---

# 🎓 MCP Stateful HTTP Streamable Server - Educational Reference

<div align="center">

**A Production-Ready Model Context Protocol Server Teaching Hybrid Storage, Distributed Systems, and Resilient Error Handling**

[![MCP Version](https://img.shields.io/badge/MCP-1.0.0-blue)](https://spec.modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![SDK](https://img.shields.io/badge/SDK-Production%20Ready-green)](https://github.com/modelcontextprotocol/typescript-sdk)
[![Architecture](https://img.shields.io/badge/Architecture-Resilient%20Hybrid-gold)]()

_Learn by building a world-class, horizontally-scalable MCP server that is robust by design._

</div>

## 🎯 Project Goal & Core Concepts

This repository is a **masterclass in building distributed systems** with the Model Context Protocol. It is a comprehensive reference implementation that demonstrates how to build a robust, scalable, and fault-tolerant MCP server using a **stateful, hybrid-storage architecture**.

This project is designed to teach five core concepts:

1.  **🏗️ Clean Architecture**: Master a clean separation of concerns by organizing code into a `types.ts` for data contracts and a `server.ts` for application logic.
2.  **⚙️ Hybrid Storage (Strategy Pattern)**: Implement a system that runs with zero dependencies locally (in-memory) and seamlessly transitions to a distributed architecture using Redis for production.
3.  **🔒 Scalability & Zero-Downtime**: Build a system that scales horizontally and supports zero-downtime deployments by externalizing state and eliminating the need for "sticky sessions".
4.  **⚡ Advanced State Management**: Learn critical patterns for distributed systems, including **storage abstraction** (`ISessionStore`), **race condition prevention**, and **just-in-time instance reconstruction**.
5.  🛡️ **Resilience & Predictability**: Implement a robust error handling strategy using **specific, typed errors** and a **global error boundary** to build a server that fails gracefully and predictably.

## 🤔 When to Use This Architecture

This stateful, distributed architecture is the ideal choice for complex, high-availability applications:

- **Enterprise Applications:** Systems that require persistent user sessions and must remain available during deployments or node failures.
- **Collaborative Tools:** Scenarios where multiple users or agents interact with a shared context that must be centrally managed.
- **Multi-Turn Conversational Agents:** Complex chatbots or agents that need to remember the entire history of an interaction to provide coherent responses.
- **Any system where losing session state or failing unpredictably is unacceptable.**

## 🚀 Quick Start

This server is designed to work in two modes: a simple local mode and a scalable production mode.

### 1. Zero-Configuration Local Development

Run the server instantly on your machine with zero external dependencies.

```bash
# Clone the repository
git clone https://github.com/yigitkonur/example-mcp-server-streamable-http
cd example-mcp-server-streamable-http

# Install dependencies
npm install

# Start the server in development mode (uses in-memory storage)
npm run dev

# The server starts on port 1453 with the message:
# ✅ Using In-Memory for single-node state management.
```

### 2. Production Mode with Docker & Redis

Test the full distributed architecture using the provided Docker Compose setup.

```bash
# Make sure Docker is running on your machine
# This single command starts the server and a Redis instance
docker-compose up --build

# The server starts on port 1453 and connects to the Redis container:
# ✅ Using Redis for distributed state management.
# INFO: Redis Client Connected
```

## 📐 Architecture Overview

### Code & File Structure

This project follows a clean architecture with a deliberate separation of concerns.

```
src/
├── types.ts    # Data Contracts: Interfaces, Zod Schemas, Custom Errors
└── server.ts   # Application Logic: Storage Impls, Server Factory, HTTP Endpoints
```

### Key Architectural Principles

1.  **Storage Abstraction (Strategy Pattern):** The core application logic is decoupled from the storage mechanism (`in-memory` vs. `Redis`) via an `ISessionStore` interface defined in `types.ts`.
2.  **Stateless Nodes, Stateful System:** Individual server nodes hold only a temporary cache of session objects. The authoritative state lives in a central store (Redis), allowing the system as a whole to be stateful and resilient.
3.  **Just-in-Time Reconstruction:** Any server node can handle a request for any session ID. If a session is not in a node's local cache, it is reconstructed on-the-fly from the central store. **This eliminates the need for sticky sessions.**
4.  **Predictable Error Handling:** The server uses a multi-layered error strategy. It throws specific, typed errors for known failure modes (like an invalid session) and uses a global Express error handler as a safety net to catch all unexpected issues, ensuring the client always receives a secure, protocol-compliant error response.

### Architectural Diagrams

#### Single-Node Mode (Local Development)

```
┌─────────────────────────────────────────┐
│          Express Server                 │
│ ┌─────────────────────────────────────┐ │
│ │   Global Error Handler (Safety Net) │ │
│ └─────────────────────────────────────┘ │
│  Rate Limiting | CORS | Health Checks  │
├─────────────────────────────────────────┤
│      In-Memory Session Store            │
│         (Ephemeral Map<id, Data>)       │
├─────────────────────────────────────────┤
│   Per-Session MCP Server Instances      │
│     (Cached in an in-memory Map)        │
└─────────────────────────────────────────┘
```

#### Distributed Mode (Production)

```
        Load Balancer (No Sticky Sessions)
                   |
    +--------------+--------------+
    |              |              |
┌─────────┐    ┌─────────┐    ┌─────────┐
│ Server A│    │ Server B│    │ Server C│
└─────────┘    └─────────┘    └─────────┘
    |              |              |
    +--------------+--------------+
                   |
     ┌────────────────────────────┐
     │       Redis Cluster        │
     │ (Authoritative Session &   │
     │      Event Store)          │
     └────────────────────────────┘
```

## 🔧 Core Implementation Patterns

This section highlights the most important code patterns that define this architecture.

### Pattern 1: Storage Abstraction (`ISessionStore`)

**The Principle:** Code to an interface, not a concrete implementation. This decouples our application logic from the storage technology.

**The Implementation (`src/types.ts`):**

```typescript
// The contract that any storage backend must adhere to.
export interface ISessionStore {
  get(sessionId: string): Promise<SessionData | null>;
  set(sessionId: string, data: SessionData): Promise<void>;
  // ... and other methods
}

// Application logic in server.ts only ever interacts with this interface.
```

### Pattern 2: Just-in-Time Instance Reconstruction

**The Principle:** To achieve horizontal scalability without sticky sessions, any server node must be able to handle a request for any active session.

**The Implementation (`src/server.ts`):**

```typescript
// DRY Implementation: Single helper function eliminates code duplication
async function getOrCreateInstances(
  sessionId: string,
): Promise<{ transport: StreamableHTTPServerTransport; server: McpServer }> {
  // 1. Check high-performance local cache first
  let instances = sessionInstances.get(sessionId);
  if (instances) return instances;

  // 2. Verify session exists in authoritative persistent store
  const sessionData = await sessionStore.get(sessionId);
  if (!sessionData) {
    throw new SessionNotFoundError('Session does not exist or has expired.', { sessionId });
  }

  // 3. Reconstruct instances from persistent state
  console.log(`Reconstructing instances for session ${sessionId} on this node`);
  // ... reconstruction logic ...

  return instances;
}

// Used consistently across POST, GET, and DELETE endpoints
const instances = await getOrCreateInstances(sessionId);
```

### Pattern 3: Critical Initialization Order

**The Principle:** To prevent race conditions in a distributed system, the session record must be saved to the persistent store _before_ the `McpServer` instance is created.

**The Implementation (`src/server.ts`):**

```typescript
// 1. A new session request arrives. Generate a session ID.
const newSessionId = randomUUID();

// 2. Create the initial session data object.
const sessionData = createNewSessionData();

// 3. CRITICAL: Persist the session data to Redis/memory FIRST.
await sessionStore.set(newSessionId, sessionData);

// 4. NOW it's safe to create the McpServer instance, which may need to read this data.
const server = await createMCPServer(newSessionId);
```

### Pattern 4: Resilient & Predictable Error Handling

**The Principle:** A robust server fails predictably. We use specific error types for known issues and a global safety net for everything else.

**The Implementation:**

**1. Define Custom, Specific Errors (`src/types.ts`):** We create a hierarchy of error classes to represent distinct failure modes.

```typescript
// A base class for all our application's errors.
export class CalculatorServerError extends McpError {
  /* ... */
}

// A specific error for when a session is not found.
export class SessionNotFoundError extends CalculatorServerError {
  /* ... */
}

// A specific error for when a database/Redis operation fails.
export class StorageOperationFailedError extends CalculatorServerError {
  /* ... */
}
```

**2. Throw Specific Errors in Logic (`src/server.ts`):** Instead of returning generic errors, our code throws these specific types.

```typescript
// Inside an HTTP handler...
const sessionData = await sessionStore.get(sessionId);
if (!sessionData) {
  // This is a known, predictable failure. Throw the specific error.
  throw new SessionNotFoundError('Session not found or expired', { sessionId });
}
```

**3. Complete Error Boundary Coverage (`src/server.ts`):** Every endpoint throws specific errors instead of direct HTTP responses, ensuring 100% coverage by the global handler. This prevents any error from bypassing our safety net.

```typescript
// All endpoints throw errors instead of sending responses directly
if (!sessionId) {
  throw new McpError(ErrorCode.InvalidRequest, 'Mcp-Session-Id header is required');
}

// Global Express middleware catches ALL errors
app.use((err: Error, req: Request, res: Response, next: express.NextFunction) => {
  // 1. Log the full, detailed error for our internal records.
  console.error('[GLOBAL ERROR HANDLER] Unhandled error caught:', err);

  // 2. Handle specific error types with proper codes and context
  let code = ErrorCode.InternalError;
  let message = 'An internal server error occurred.';
  let data: unknown = undefined;

  if (err instanceof CalculatorServerError) {
    code = err.code;
    message = err.message;
    data = err.context; // Include contextual information for debugging
  } else if (err instanceof McpError) {
    code = err.code;
    message = err.message;
    data = err.data;
  }

  // 3. Always send protocol-compliant JSON-RPC error responses
  res.status(500).json({ jsonrpc: '2.0', id: rpcId, error: { code, message, data } });
});
```

## 📊 Features Implemented

This server implements a comprehensive set of capabilities to demonstrate a production-grade system.

| Feature                          | Description                                                                                        | Key Pattern Demonstrated                                                                       |
| :------------------------------- | :------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------- |
| **Hybrid Storage**               | Switches between in-memory and Redis via `USE_REDIS` env var.                                      | **Strategy Pattern** and environment-based configuration.                                      |
| **Persistent History**           | Calculation history is saved as part of the session data.                                          | **Stateful Tool Use:** Tools modify session state which is then persisted.                     |
| **Gold-Standard Error Handling** | Complete error boundary coverage with typed errors and comprehensive TSDoc documentation.          | **Multi-Layered Defense:** Custom error hierarchy + global safety net + contextual error data. |
| **DRY Code Architecture**        | Single `getOrCreateInstances` helper eliminates reconstruction logic duplication.                  | **Maintainability:** Critical patterns abstracted into reusable, well-documented functions.    |
| **Health Checks**                | `/health` endpoint reports server status, including Redis connectivity.                            | **Observability:** Providing critical system status for monitoring.                            |
| **Prometheus Metrics**           | `/metrics` endpoint exposes `mcp_active_sessions` and more.                                        | **Monitoring:** Exposing key performance indicators for a metrics scraper.                     |
| **Complete Documentation**       | Every tool, resource, and prompt handler documents exact failure modes with `@throws` annotations. | **Predictable APIs:** Clear contracts for all failure scenarios.                               |

## 🧪 Testing & Validation

### Health & Metrics

Verify the server's operational status and view its metrics. The `/health` endpoint is aware of the storage mode.

```bash
# Check basic health (works in both modes)
curl http://localhost:1453/health

# In Redis mode, a healthy response will include:
# "storageMode": "redis", "redis": "ready"

# Check Prometheus-style metrics
curl http://localhost:1453/metrics
```

### Manual Request (with `curl`)

Use `curl` to test the full session lifecycle.

```bash
# 1. Initialize a session and capture the Mcp-Session-Id header
SESSION_ID=$(curl -i -X POST http://localhost:1453/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1.0.0"}}' \
  | grep -i Mcp-Session-Id | awk '{print $2}' | tr -d '\r')

echo "Acquired Session ID: $SESSION_ID"

# 2. Use the session ID to call a tool
curl -X POST http://localhost:1453/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"calculate","arguments":{"a":100,"b":50,"op":"add"}}}'
```

### Interactive Testing with MCP Inspector

Use the official inspector to interactively test the stateful server.

```bash
# The inspector will handle the session ID automatically.
npx @modelcontextprotocol/inspector --cli http://localhost:1453/mcp
```

## 🏭 Deployment & Configuration

### Configuration

The server is configured using environment variables.

| Variable           | Description                                                                                                                                                                                                                                                                             | Default                  |
| :----------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------- |
| `PORT`             | The port for the HTTP server to listen on.                                                                                                                                                                                                                                              | `1453`                   |
| `USE_REDIS`        | **Set to `true` to enable Redis for distributed state.**                                                                                                                                                                                                                                | `false`                  |
| `REDIS_URL`        | The connection string for the Redis instance.                                                                                                                                                                                                                                           | `redis://localhost:6379` |
| `LOG_LEVEL`        | Logging verbosity (`debug`, `info`, `warn`, `error`).                                                                                                                                                                                                                                   | `info`                   |
| `CORS_ORIGIN`      | Allowed origin for CORS. Use a specific domain in production.                                                                                                                                                                                                                           | `*`                      |
| `SAMPLE_TOOL_NAME` | **(Educational)** Demonstrates dynamic tool registration via environment variables. When set, adds a simple echo tool with the specified name that takes a `value` parameter and returns `test string print: {value}`. This pattern shows how MCP servers can be configured at runtime. | None                     |

### Production Deployment

This server is designed for high-availability, horizontally-scaled deployments.

- **Containerization:** The multi-stage `Dockerfile` creates a lean, secure production image. The `docker-compose.yml` file is ready for multi-replica scaling (`docker-compose up --scale mcp-server=4`).
- **Load Balancing:** Deploy behind any standard load balancer. **Sticky sessions are not required** due to the "Just-in-Time Reconstruction" architecture.
- **Zero-Downtime Updates:** Because session state is externalized to Redis, you can perform rolling deployments of new server versions without interrupting or losing active user sessions.
