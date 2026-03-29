# infra-mcp

MCP server that gives Claude Code real-time visibility into local infrastructure — Docker containers and system health.

## Tools

### System (8 tools)

| Tool | Description |
|------|-------------|
| `system_overview` | CPU load, memory, uptime |
| `gpu_status` | NVIDIA GPU utilization and VRAM |
| `gpu_processes` | Processes using the GPU |
| `disk_usage` | Filesystem usage |
| `io_pressure` | PSI metrics for I/O pressure |
| `top_processes` | Top processes by CPU/memory |
| `service_status` | systemd service status |
| `memory_detail` | Detailed memory breakdown |

### Docker (7 tools)

| Tool | Description |
|------|-------------|
| `list_containers` | List all containers with status |
| `inspect_container` | Detailed container info |
| `container_logs` | Tail container logs |
| `start_container` | Start a stopped container |
| `stop_container` | Stop a running container |
| `restart_container` | Restart a container |
| `compose_status` | Docker Compose project status |

## Setup

```bash
npm install
```

## Usage

```bash
npm start
```

Configure in Claude Code MCP settings:

```json
{
  "mcpServers": {
    "infra": {
      "command": "node",
      "args": ["/path/to/infra-mcp/index.js"]
    }
  }
}
```

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `DOCKER_HOST` | `/var/run/docker.sock` | Docker socket path |
| `NVIDIA_SMI_PATH` | `nvidia-smi` | Path to nvidia-smi binary |

## Tech Stack

- Node.js (>=18)
- `@modelcontextprotocol/sdk`
- Docker API v1.43 (Unix socket)
- `/proc` filesystem for system metrics
- `nvidia-smi` for GPU monitoring
