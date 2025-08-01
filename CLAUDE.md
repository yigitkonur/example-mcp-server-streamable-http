# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Essential Commands

**Development**:
- `npm run dev` - Start development server on port 1453 with hot reload
- `npm run build` - Compile TypeScript to dist/
- `npm start` - Run production server (requires build first)

**Testing**:
- `npm test` - Run Jest test suite
- `npm run test:watch` - Run tests in watch mode
- `npm run test:e2e` - Run end-to-end tests with real HTTP requests
- `npm run test:inspector` - Test with MCP Inspector CLI
- `npm run test:health` - Quick health check via curl

**Code Quality**:
- `npm run lint` - ESLint check
- `npm run lint:fix` - Auto-fix ESLint issues
- `npm run typecheck` - TypeScript type checking without emit
- `npm run ci` - Full CI pipeline (lint + typecheck + test + build)

**Single Test Execution**:
- `npm test -- --testNamePattern="session management"` - Run specific test
- `npm test -- src/tests/resumability.test.ts` - Run specific test file

## Architecture Overview

This is a **stateful MCP (Model Context Protocol) server** implementing Streamable HTTP transport with session management.

### Core Architecture Components

**Stateful Session Management**:
- Global `sessions` Map stores active sessions by UUID
- Each session has its own `StreamableHTTPServerTransport` and `McpServer` instance
- Sessions persist for 30 minutes of inactivity (configurable via `SESSION_TIMEOUT`)
- Ring buffer stores last 50 calculations per session

**Event Store for Resumability**:
- `InMemoryEventStore` class implements event sourcing pattern
- Events stored with format: `{streamId}_{timestamp}_{randomId}`
- Supports `Last-Event-Id` header for resuming interrupted connections
- Events expire after 24 hours or 10,000 entries per session

**Transport Layer**:
- Single `/mcp` endpoint handles both JSON-RPC (POST) and SSE (GET)
- Initialization returns 202 Accepted with `Mcp-Session-Id` header
- All subsequent requests require session ID for authentication
- Rate limiting applied per endpoint

**MCP Implementation**:
- **Tools**: 7 tools (4 core + 3 extended) including `calculate`, `batch_calculate`, `advanced_calculate`
- **Resources**: 5 resources including `calculator://constants`, `calculator://history/{id}`, `session://info/{sessionId}`
- **Prompts**: 5 prompts including `explain-calculation`, `generate-problems`, `solve_math_problem`

### Key Files

- `src/production-server.ts` - Main server implementation (1000+ lines)
- `mcp-demo-manifest.json` - Defines core vs extended features
- `src/tests/` - Comprehensive test suite covering session lifecycle, resumability

### Session Lifecycle

1. **Initialize**: Client sends `initialize` request → Server creates session with UUID
2. **Authenticate**: All requests include `Mcp-Session-Id` header
3. **State Persistence**: Calculations stored in session ring buffer
4. **Resumability**: Client can reconnect with `Last-Event-Id` to replay missed events
5. **Cleanup**: Sessions auto-expire after timeout or explicit DELETE

### Configuration

- Default port: 1453 (via `PORT` environment variable)
- Session timeout: 30 minutes (via `SESSION_TIMEOUT`)
- Rate limit: 1000 requests per 15 minutes (via `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW`)
- CORS origin: `*` (via `CORS_ORIGIN`)

### Testing Strategy

- Unit tests for individual components
- Integration tests for session management
- E2E tests with real HTTP requests
- Resumability tests with network simulation  
- MCP Inspector validation for protocol compliance

The codebase emphasizes **true statefulness** over stateless design, enabling complex workflows, debugging capabilities, and enterprise-grade session management.