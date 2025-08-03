# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this comprehensive MCP reference implementation.

## 🎯 **CRITICAL**: This is an Educational Reference Implementation

This codebase is a **masterclass in building production-grade distributed systems** with the Model Context Protocol. It demonstrates advanced architectural patterns including:

- **Hybrid Architecture**: Seamlessly switches between in-memory (development) and Redis (production) modes
- **Strategy Pattern**: Storage abstraction through `ISessionStore` interface
- **Factory Pattern**: Runtime storage selection via `initializeStores()`
- **Just-in-Time Instance Reconstruction**: Eliminates session affinity for true horizontal scaling
- **Event Sourcing**: Complete audit trail with resumability
- **Production Security**: DNS rebinding protection, rate limiting, input validation

## Essential Commands

**Development (Zero Dependencies)**:
- `npm run dev` - Start in-memory mode (no Redis required) on port 1453
- `npm run build` - Compile TypeScript to dist/ 
- `npm start` - Run production server (requires build first)

**Production Mode**:
- `docker-compose up` - Full distributed architecture with Redis
- `USE_REDIS=true npm start` - Force Redis mode (requires running Redis)
- `USE_REDIS=false npm start` - Force in-memory mode

**Health & Monitoring**:
- `npm run test:health` - Quick health check via curl (storage mode aware)
- `curl http://localhost:1453/health` - Detailed health status with storage info
- `curl http://localhost:1453/metrics` - Prometheus metrics

**Code Quality**:
- `npm run lint` - ESLint check (zero warnings enforced)
- `npm run lint:fix` - Auto-fix ESLint issues
- `npm run typecheck` - TypeScript type checking without emit
- `npm run ci` - Full CI pipeline (lint + typecheck + build)

## Hybrid Architecture Overview

This server implements a **revolutionary hybrid architecture** that demonstrates how to build systems that:
- **Start Simple**: Zero external dependencies for development
- **Scale Seamlessly**: Production-ready distributed architecture
- **Teach Deeply**: Every pattern explained and documented

### 🏗️ Core Architectural Patterns

**1. Storage Abstraction (Strategy Pattern)**:
```typescript
interface ISessionStore {
  get(sessionId: string): Promise<SessionData | null>;
  set(sessionId: string, data: SessionData): Promise<void>;
  delete(sessionId: string): Promise<void>;
  updateActivity(sessionId: string): Promise<void>;
}
```
- `InMemorySessionStore` - Development mode (Map-based)
- `RedisSessionStore` - Production mode (Redis Hash-based)
- Application code is identical regardless of backend

**2. Factory Pattern for Runtime Selection**:
```typescript
async function initializeStores() {
  if (config.useRedis) {
    return { sessionStore: new RedisSessionStore(...), eventStore: new RedisEventStore(...) };
  } else {
    return { sessionStore: new InMemorySessionStore(...), eventStore: new InMemoryEventStore() };
  }
}
```

**3. Just-in-Time Instance Reconstruction**:
- **Revolutionary**: Any server node can handle any session without sticky sessions
- Sessions reconstructed on-demand from persistent state
- Enables true horizontal scaling and zero-downtime deployments

**4. Event Sourcing with Resumability**:
- Complete audit trail of all interactions
- Clients can resume interrupted connections with `Last-Event-Id`
- Redis Streams (production) or in-memory events (development)

### 🚦 Storage Mode Detection

The server automatically selects storage mode based on `USE_REDIS` environment variable:

**In-Memory Mode (Default)**:
- Console: `✅ Using In-Memory for single-node state management.`
- Health: `"storageMode": "in-memory"`
- Perfect for: Development, testing, single-instance deployments

**Redis Mode (Production)**:
- Console: `✅ Using Redis for distributed state management.`
- Health: `"storageMode": "redis", "redis": "ready"`
- Perfect for: Horizontal scaling, high availability, zero-downtime deployments

### 📁 Key Files Architecture

**Clean Architecture Implementation**:
- `src/types.ts` (360+ lines) - **Data Contracts Layer**
  - All interfaces: `ISessionStore`, `SessionData`, `TransportWithSessionId`
  - Zod validation schemas for tools, resources, and prompts
  - Custom error hierarchy: `CalculatorServerError`, `SessionNotFoundError`, `StorageOperationFailedError`
  - Type inference from Zod schemas for compile-time safety

- `src/server.ts` (1950+ lines) - **Application Logic Layer**
  - Section 1: Global state and configuration management
  - Section 2: Storage implementations (`InMemorySessionStore`, `RedisSessionStore`, Event Stores)
  - Section 3: Core factories (`initializeStores`, `createMCPServer`, `getOrCreateInstances`)
  - Section 4: Express web server with MCP endpoints and global error boundary
  - Section 5: Application entry point with startup logic

**Configuration & Deployment**:
- `docker-compose.yml` - Production deployment with Redis
- `.env.example` - All environment variables documented
- `.nvmrc` - Node.js version specification

**Documentation**:
- `README.md` - Comprehensive educational guide with gold-standard patterns
- This file (`CLAUDE.md`) - Assistant context with implementation details

### 🔄 Session Lifecycle (Critical Understanding)

**Initialization Pattern (Prevents Race Conditions)**:
1. Pre-generate session ID with `randomUUID()`
2. Create transport with fixed session ID generator
3. **CRITICAL**: Store session data BEFORE creating MCP server
4. Create MCP server (lookup will succeed)
5. Connect server to transport and cache instances

**Just-in-Time Reconstruction (DRY Implementation)**:
1. **`getOrCreateInstances(sessionId)` helper** - Single function eliminates code duplication
2. Check high-performance local cache first 
3. If not cached, verify session exists in persistent storage (throws `SessionNotFoundError`)
4. Reconstruct `StreamableHTTPServerTransport` with existing session ID
5. **CRITICAL**: Set `(transport as TransportWithSessionId).sessionId = sessionId`
6. Recreate MCP server and connect to transport
7. Cache instances locally and return - **Used consistently across POST, GET, DELETE endpoints**

### 🛠️ MCP Implementation Features

**Tools (7 total)**:
- `calculate` - Basic arithmetic with history
- `batch_calculate` - Multiple operations with progress
- `advanced_calculate` - Scientific functions
- `demo_progress` - Streaming updates demonstration
- Plus 3 extended tools based on manifest configuration

**Resources (5 total)**:
- `calculator://constants` - Mathematical constants
- `calculator://history/{id}` - Session calculation history
- `calculator://stats` - Global statistics
- `session://info/{sessionId}` - Session introspection
- `calculator://help` - Interactive help

**Prompts (5 total)**:
- `explain-calculation` - Step-by-step explanations
- `generate-problems` - Dynamic problem generation
- `solve_math_problem` - Complex problem solving
- Plus additional educational prompts

### 🔧 Production Features

**Observability**:
- Health endpoint adapts to storage mode
- Prometheus metrics (`/metrics`)
- Structured logging for both modes
- Session reconstruction logging

**Security**:
- DNS rebinding protection
- Rate limiting (configurable per endpoint)
- Input validation with Zod schemas
- Session isolation and authentication

**Performance**:
- Ring buffer pattern (bounded memory)
- Redis connection pooling
- Local session instance caching
- Event store size limits (in-memory: time-based, Redis: MAXLEN)

### 🏭 Deployment Scenarios

**Local Development**:
```bash
npm run dev  # Starts immediately, no external dependencies
```

**Docker Development** (test distributed architecture):
```bash
docker-compose up  # Automatically starts Redis
```

**Production Kubernetes**:
```yaml
env:
- name: USE_REDIS
  value: "true"
- name: REDIS_HOST
  value: redis-cluster
```

### 🎓 Educational Value

This codebase teaches:
1. **Strategy Pattern**: Interface-based storage abstraction
2. **Factory Pattern**: Runtime dependency injection
3. **Event Sourcing**: Immutable event streams for auditability
4. **Distributed Systems**: Session affinity elimination
5. **Production Patterns**: Security, monitoring, deployment
6. **Clean Architecture**: Separation of concerns and testability

### ⚠️ Critical Implementation Notes

1. **Session Storage Race Condition**: Always store session data BEFORE creating MCP server
2. **Transport Session ID**: Must manually set `sessionId` property after reconstruction  
3. **Memory Management**: Ring buffers and size limits prevent unbounded growth
4. **Gold-Standard Error Handling**: 
   - **Complete Error Boundary Coverage**: Every endpoint throws errors instead of direct responses
   - **Custom Error Hierarchy**: `SessionNotFoundError`, `StorageOperationFailedError` with context
   - **Global Safety Net**: Express middleware catches ALL errors and sends protocol-compliant responses
   - **TSDoc Documentation**: Every handler documents exact failure modes with `@throws` annotations
5. **Storage Mode**: Check console output and health endpoint to confirm mode
6. **DRY Architecture**: `getOrCreateInstances` helper eliminates reconstruction code duplication

### 🧪 Testing Strategy

**Storage Abstraction**: Same test suite runs against both implementations
**Session Reconstruction**: Tests verify seamless failover between nodes
**Resumability**: Network interruption simulation with event replay
**Production**: Health checks, metrics validation, Redis failover scenarios

The codebase demonstrates **how to build systems that embrace complexity through simplicity** - sophisticated enough for production, simple enough to understand and learn from.