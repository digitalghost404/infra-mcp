# infra-mcp index.js split implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the monolithic MCP server into helper, system-tool, and docker-tool modules without changing behavior.

**Architecture:** Move shared constants and helper utilities into `lib/helpers.js`, isolate tool registration groups in `lib/system.js` and `lib/docker.js`, and keep `index.js` as a thin server bootstrap. Preserve all tool names, schemas, output formatting, and MCP startup behavior.

**Tech Stack:** Node.js ESM, `@modelcontextprotocol/sdk`, `zod`

---

### Task 1: Map module boundaries

**Files:**
- Modify: `index.js`
- Create: `lib/helpers.js`
- Create: `lib/system.js`
- Create: `lib/docker.js`

- [ ] Inventory shared constants and helper functions that must move into `lib/helpers.js`.
- [ ] Group the 8 system tool registrations for `registerSystemTools(server)`.
- [ ] Group the 7 docker tool registrations for `registerDockerTools(server)`.

### Task 2: Extract helpers

**Files:**
- Create: `lib/helpers.js`

- [ ] Move formatting helpers, process helpers, Docker cache/API helpers, container formatting helpers, and exported config constants into `lib/helpers.js`.
- [ ] Keep implementations byte-for-byte equivalent except for necessary export/import syntax.

### Task 3: Extract system tools

**Files:**
- Create: `lib/system.js`

- [ ] Implement `registerSystemTools(server)` and move `system_overview`, `gpu_status`, `gpu_processes`, `disk_usage`, `io_pressure`, `top_processes`, `service_status`, and `memory_detail` into it.
- [ ] Import `z` and all required helpers from `./helpers.js`.

### Task 4: Extract docker tools

**Files:**
- Create: `lib/docker.js`

- [ ] Implement `registerDockerTools(server)` and move `list_containers`, `inspect_container`, `container_logs`, `start_container`, `stop_container`, `restart_container`, and `compose_status` into it.
- [ ] Import `z` and all required helpers from `./helpers.js`.

### Task 5: Simplify bootstrap and verify

**Files:**
- Modify: `index.js`

- [ ] Replace the monolith with a minimal bootstrap that creates the server, installs resource/prompt handlers, registers system/docker tools, and connects stdio transport.
- [ ] Run diagnostics on changed files.
- [ ] Run `npm run test` and confirm all 15 tools still behave identically.
