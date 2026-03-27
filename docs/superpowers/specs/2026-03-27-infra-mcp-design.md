# Infra MCP Server — Design Spec

## Purpose

Consolidated infrastructure monitoring server combining Docker and system monitoring into a single MCP process. Gives Claude visibility into machine state and running services.

## Architecture

- Single-file `index.js` (< 800 lines expected)
- Node.js + `@modelcontextprotocol/sdk` + Zod
- Docker: HTTP over Unix socket (`/var/run/docker.sock`) via native fetch/undici
- System: Parse `/proc/*` files directly + `nvidia-smi` for GPU
- Stdio transport

## Tools — System Monitor (6)

| Tool | Source | Purpose |
|------|--------|---------|
| `system_overview` | `/proc/loadavg`, `/proc/meminfo`, `/proc/uptime` | CPU load, memory, swap, uptime — one-shot health check |
| `gpu_status` | `nvidia-smi --query-gpu=...` | GPU name, temp, utilization, VRAM used/free/total |
| `gpu_processes` | `nvidia-smi pmon` | Which processes are using GPU VRAM |
| `disk_usage` | `child_process: df -h` | Per-mount disk usage |
| `io_pressure` | `/proc/pressure/{cpu,memory,io}` | PSI metrics — is the system under actual stress |
| `top_processes` | `child_process: ps aux --sort=-pcpu` or `--sort=-pmem` | Top N processes by CPU or memory |
| `service_status` | `systemctl status <service>` | Check systemd service/timer status (user or system) |
| `memory_detail` | `/proc/meminfo` | Full meminfo breakdown (buffers, cache, available, slab) |

## Tools — Docker (7)

| Tool | Docker API Endpoint | Purpose |
|------|-------------------|---------|
| `list_containers` | `GET /containers/json?all=` | List containers with optional name/label filter |
| `inspect_container` | `GET /containers/{id}/json` | Full inspect for a container |
| `container_logs` | `GET /containers/{id}/logs?tail=` | Tail logs (last N lines, optional since) |
| `start_container` | `POST /containers/{id}/start` | Start a stopped container |
| `stop_container` | `POST /containers/{id}/stop?t=` | Stop with timeout |
| `restart_container` | `POST /containers/{id}/restart` | Restart a container |
| `compose_status` | `GET /containers/json` + filter by `com.docker.compose.project` | Group running containers by compose project |

**Total: 15 tools in one process.**

## Docker Connection

1. Try native `fetch()` with Unix socket (Node 22+ / undici)
2. Fall back to spawning `curl --unix-socket /var/run/docker.sock`
3. `DOCKER_HOST` env var override (e.g., `tcp://localhost:2375`)

## Configuration

- `DOCKER_HOST` — override socket path (default: `/var/run/docker.sock`)
- `NVIDIA_SMI_PATH` — override nvidia-smi location (default: `nvidia-smi` on PATH)
- No config file — env vars only

## Error Handling

- Docker socket not found → tools return clear "Docker not running" message, don't crash server
- No NVIDIA GPU → `gpu_status` and `gpu_processes` return "No NVIDIA GPU detected"
- `/proc/pressure/` not available (older kernels) → `io_pressure` returns "PSI not supported"
- All timeouts: 10s for system queries, 15s for docker API calls, 30s for log tailing

## Design Decisions

- **Read-only system tools** — no kill, no renice, no restart
- **Docker writes are explicit** — start/stop/restart require exact container ID, no wildcards, no `rm`
- **No `docker run`** — too destructive for MCP, use terminal for that
- **Structured output** — tables and key-value pairs, not raw JSON dumps

## Testing

- `test.js` with McpTestClient pattern
- System tools: test against known `/proc` files (always available on Linux)
- Docker tools: skip gracefully if socket not available
- GPU tools: skip gracefully if no nvidia-smi
