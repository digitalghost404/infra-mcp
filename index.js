#!/usr/bin/env node
/**
 * infra-mcp — Consolidated Docker + System monitoring MCP server.
 * Single-file server giving Claude visibility into machine state and running services.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "fs/promises";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);

// ─── Configuration ───────────────────────────────────────────────────────────
const DOCKER_SOCKET = process.env.DOCKER_HOST || "/var/run/docker.sock";
const NVIDIA_SMI = process.env.NVIDIA_SMI_PATH || "nvidia-smi";
const DOCKER_API = "v1.43";

const TIMEOUT_SYSTEM = 10_000;
const TIMEOUT_DOCKER = 15_000;
const TIMEOUT_LOGS = 30_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function humanBytes(kb) {
  const n = Number(kb);
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} GB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} MB`;
  return `${n} KB`;
}

function humanUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

function padRight(s, n) {
  return String(s).padEnd(n);
}

function padLeft(s, n) {
  return String(s).padStart(n);
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

async function readProc(path) {
  return (await readFile(path, "utf-8")).trim();
}

async function execWithTimeout(cmd, args, timeoutMs) {
  return execFile(cmd, args, { timeout: timeoutMs });
}

/** Docker API via curl --unix-socket */
async function dockerApi(method, path, timeoutMs = TIMEOUT_DOCKER) {
  const url = `http://localhost/${DOCKER_API}${path}`;
  const args = ["--unix-socket", DOCKER_SOCKET, "-s", "-X", method, url];
  try {
    const { stdout } = await execWithTimeout("curl", args, timeoutMs);
    return JSON.parse(stdout);
  } catch (err) {
    if (err.code === "ENOENT") throw new Error("curl not found on system");
    // Check if docker socket doesn't exist
    try {
      await readFile(DOCKER_SOCKET);
    } catch {
      throw new Error(`Docker socket not found at ${DOCKER_SOCKET}. Is Docker running?`);
    }
    throw err;
  }
}

async function dockerApiRaw(method, path, timeoutMs = TIMEOUT_DOCKER) {
  const url = `http://localhost/${DOCKER_API}${path}`;
  const args = ["--unix-socket", DOCKER_SOCKET, "-s", "-X", method, url];
  try {
    const { stdout } = await execWithTimeout("curl", args, timeoutMs);
    return stdout;
  } catch (err) {
    try {
      await readFile(DOCKER_SOCKET);
    } catch {
      throw new Error(`Docker socket not found at ${DOCKER_SOCKET}. Is Docker running?`);
    }
    throw err;
  }
}

async function dockerApiPost(path, timeoutMs = TIMEOUT_DOCKER) {
  const url = `http://localhost/${DOCKER_API}${path}`;
  const args = [
    "--unix-socket", DOCKER_SOCKET, "-s",
    "-X", "POST",
    "-w", "\n%{http_code}",
    url,
  ];
  try {
    const { stdout } = await execWithTimeout("curl", args, timeoutMs);
    const lines = stdout.trimEnd().split("\n");
    const statusCode = parseInt(lines.pop(), 10);
    const body = lines.join("\n");
    return { statusCode, body };
  } catch (err) {
    try {
      await readFile(DOCKER_SOCKET);
    } catch {
      throw new Error(`Docker socket not found at ${DOCKER_SOCKET}. Is Docker running?`);
    }
    throw err;
  }
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "infra-mcp",
  version: "1.0.0",
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

// ── system_overview ──────────────────────────────────────────────────────────
server.tool(
  "system_overview",
  "One-shot system health check: CPU load averages, memory usage, swap, and uptime",
  {},
  async () => {
    try {
      const [loadavgRaw, meminfoRaw, uptimeRaw] = await Promise.all([
        readProc("/proc/loadavg"),
        readProc("/proc/meminfo"),
        readProc("/proc/uptime"),
      ]);

      // Parse loadavg
      const loadParts = loadavgRaw.split(/\s+/);
      const [load1, load5, load15] = loadParts.slice(0, 3);
      const runnable = loadParts[3]; // e.g. "2/384"

      // Parse uptime
      const uptimeSecs = parseFloat(uptimeRaw.split(/\s+/)[0]);

      // Parse meminfo
      const mem = {};
      for (const line of meminfoRaw.split("\n")) {
        const match = line.match(/^(\w+):\s+(\d+)/);
        if (match) mem[match[1]] = parseInt(match[2], 10);
      }

      const totalMem = mem.MemTotal || 0;
      const availMem = mem.MemAvailable || 0;
      const usedMem = totalMem - availMem;
      const memPct = totalMem > 0 ? ((usedMem / totalMem) * 100).toFixed(1) : "0";
      const swapTotal = mem.SwapTotal || 0;
      const swapFree = mem.SwapFree || 0;
      const swapUsed = swapTotal - swapFree;
      const swapPct = swapTotal > 0 ? ((swapUsed / swapTotal) * 100).toFixed(1) : "0";

      const lines = [
        "System Overview",
        "═══════════════════════════════════════",
        "",
        `Uptime        ${humanUptime(uptimeSecs)}`,
        `Load avg      ${load1}  ${load5}  ${load15}  (1m / 5m / 15m)`,
        `Processes     ${runnable}`,
        "",
        "Memory",
        `  Total       ${humanBytes(totalMem)}`,
        `  Used        ${humanBytes(usedMem)}  (${memPct}%)`,
        `  Available   ${humanBytes(availMem)}`,
        "",
        "Swap",
        `  Total       ${humanBytes(swapTotal)}`,
        `  Used        ${humanBytes(swapUsed)}  (${swapPct}%)`,
        `  Free        ${humanBytes(swapFree)}`,
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(`Failed to read system info: ${err.message}`);
    }
  }
);

// ── gpu_status ───────────────────────────────────────────────────────────────
server.tool(
  "gpu_status",
  "NVIDIA GPU status: name, temperature, utilization, VRAM usage",
  {},
  async () => {
    try {
      const { stdout } = await execWithTimeout(NVIDIA_SMI, [
        "--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.free,memory.total",
        "--format=csv,noheader,nounits",
      ], TIMEOUT_SYSTEM);

      const lines = ["GPU Status", "═══════════════════════════════════════", ""];
      const header = `${padRight("GPU", 30)} ${padLeft("Temp", 6)} ${padLeft("Util%", 7)} ${padLeft("VRAM Used", 11)} ${padLeft("VRAM Free", 11)} ${padLeft("VRAM Total", 11)}`;
      lines.push(header);
      lines.push("─".repeat(header.length));

      for (const row of stdout.trim().split("\n")) {
        const [name, temp, util, memUsed, memFree, memTotal] = row.split(",").map((s) => s.trim());
        lines.push(
          `${padRight(name, 30)} ${padLeft(temp + "C", 6)} ${padLeft(util + "%", 7)} ${padLeft(memUsed + " MB", 11)} ${padLeft(memFree + " MB", 11)} ${padLeft(memTotal + " MB", 11)}`
        );
      }
      return textResult(lines.join("\n"));
    } catch (err) {
      if (err.code === "ENOENT" || err.message?.includes("not found")) {
        return textResult("No NVIDIA GPU detected (nvidia-smi not found)");
      }
      return errorResult(`GPU query failed: ${err.message}`);
    }
  }
);

// ── gpu_processes ────────────────────────────────────────────────────────────
server.tool(
  "gpu_processes",
  "List processes currently using NVIDIA GPU VRAM",
  {},
  async () => {
    try {
      const { stdout } = await execWithTimeout(NVIDIA_SMI, [
        "--query-compute-apps=pid,used_memory,name",
        "--format=csv,noheader,nounits",
      ], TIMEOUT_SYSTEM);

      if (!stdout.trim()) {
        return textResult("No processes currently using GPU VRAM.");
      }

      const lines = ["GPU Processes", "═══════════════════════════════════════", ""];
      const header = `${padRight("PID", 10)} ${padLeft("VRAM (MB)", 12)}  ${padRight("Process", 50)}`;
      lines.push(header);
      lines.push("─".repeat(header.length));

      for (const row of stdout.trim().split("\n")) {
        const [pid, mem, name] = row.split(",").map((s) => s.trim());
        lines.push(`${padRight(pid, 10)} ${padLeft(mem, 12)}  ${padRight(name, 50)}`);
      }
      return textResult(lines.join("\n"));
    } catch (err) {
      if (err.code === "ENOENT" || err.message?.includes("not found")) {
        return textResult("No NVIDIA GPU detected (nvidia-smi not found)");
      }
      return errorResult(`GPU process query failed: ${err.message}`);
    }
  }
);

// ── disk_usage ───────────────────────────────────────────────────────────────
server.tool(
  "disk_usage",
  "Disk usage per mount point (excludes tmpfs, devtmpfs, efivarfs)",
  {},
  async () => {
    try {
      const { stdout } = await execWithTimeout("df", [
        "-h", "--output=target,size,used,avail,pcent",
      ], TIMEOUT_SYSTEM);

      const exclude = new Set(["tmpfs", "devtmpfs", "efivarfs"]);
      const rows = stdout.trim().split("\n");
      const header = rows[0];
      const filtered = [header];

      // Get filesystem types to filter
      const { stdout: dfTypes } = await execWithTimeout("df", [
        "-h", "--output=target,fstype",
      ], TIMEOUT_SYSTEM);
      const typeMap = {};
      for (const line of dfTypes.trim().split("\n").slice(1)) {
        const parts = line.trim().split(/\s+/);
        const fstype = parts.pop();
        const mount = parts.join(" ");
        typeMap[mount] = fstype;
      }

      for (const line of rows.slice(1)) {
        const mount = line.trim().split(/\s+/)[0];
        if (exclude.has(typeMap[mount])) continue;
        filtered.push(line);
      }

      const lines = ["Disk Usage", "═══════════════════════════════════════", ""];
      lines.push(filtered.join("\n"));
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(`Failed to get disk usage: ${err.message}`);
    }
  }
);

// ── io_pressure ──────────────────────────────────────────────────────────────
server.tool(
  "io_pressure",
  "PSI (Pressure Stall Information) for CPU, memory, and I/O — shows if the system is under real stress",
  {},
  async () => {
    try {
      const resources = ["cpu", "memory", "io"];
      const lines = ["I/O Pressure (PSI)", "═══════════════════════════════════════", ""];

      for (const res of resources) {
        try {
          const raw = await readProc(`/proc/pressure/${res}`);
          lines.push(`${res.toUpperCase()}:`);
          for (const line of raw.split("\n")) {
            const match = line.match(/^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)\s+total=(\d+)/);
            if (match) {
              const [, type, avg10, avg60, avg300, total] = match;
              lines.push(`  ${padRight(type, 6)} avg10=${padLeft(avg10 + "%", 8)}  avg60=${padLeft(avg60 + "%", 8)}  avg300=${padLeft(avg300 + "%", 8)}  total=${total}us`);
            }
          }
          lines.push("");
        } catch {
          lines.push(`${res.toUpperCase()}: not available`);
          lines.push("");
        }
      }
      return textResult(lines.join("\n"));
    } catch (err) {
      if (err.code === "ENOENT") {
        return textResult("PSI not supported on this kernel (requires CONFIG_PSI)");
      }
      return errorResult(`Failed to read pressure info: ${err.message}`);
    }
  }
);

// ── top_processes ────────────────────────────────────────────────────────────
server.tool(
  "top_processes",
  "Top N processes sorted by CPU or memory usage",
  {
    sort_by: z.enum(["cpu", "mem"]).default("cpu").describe("Sort by 'cpu' or 'mem'"),
    count: z.number().min(1).max(50).default(10).describe("Number of processes to return"),
  },
  async ({ sort_by, count }) => {
    try {
      const sortFlag = sort_by === "cpu" ? "--sort=-pcpu" : "--sort=-pmem";
      const { stdout } = await execWithTimeout("ps", [
        "aux", sortFlag,
      ], TIMEOUT_SYSTEM);

      const rows = stdout.trim().split("\n");
      const header = rows[0];
      const procs = rows.slice(1, count + 1);

      const lines = [
        `Top ${count} Processes by ${sort_by === "cpu" ? "CPU" : "Memory"}`,
        "═══════════════════════════════════════",
        "",
        header,
        "─".repeat(header.length),
        ...procs,
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(`Failed to get process list: ${err.message}`);
    }
  }
);

// ── service_status ───────────────────────────────────────────────────────────
server.tool(
  "service_status",
  "Check systemd service status (system or user unit)",
  {
    service: z.string().describe("Service/unit name, e.g. 'docker' or 'podman.socket'"),
    user: z.boolean().default(false).describe("Check user service (--user) instead of system"),
  },
  async ({ service, user }) => {
    try {
      const args = user ? ["--user", "status", service] : ["status", service];
      const { stdout, stderr } = await execWithTimeout("systemctl", args, TIMEOUT_SYSTEM);
      return textResult(stdout || stderr);
    } catch (err) {
      // systemctl status exits non-zero for inactive services but still has output
      if (err.stdout || err.stderr) {
        return textResult(err.stdout || err.stderr);
      }
      return errorResult(`Failed to get service status: ${err.message}`);
    }
  }
);

// ── memory_detail ────────────────────────────────────────────────────────────
server.tool(
  "memory_detail",
  "Full /proc/meminfo breakdown with human-readable sizes",
  {},
  async () => {
    try {
      const raw = await readProc("/proc/meminfo");
      const lines = ["Memory Detail", "═══════════════════════════════════════", ""];
      const header = `${padRight("Key", 25)} ${padLeft("Value", 14)}`;
      lines.push(header);
      lines.push("─".repeat(header.length));

      for (const line of raw.split("\n")) {
        const match = line.match(/^(.+?):\s+(\d+)\s*(kB)?/);
        if (match) {
          const key = match[1].trim();
          const val = parseInt(match[2], 10);
          const display = match[3] ? humanBytes(val) : String(val);
          lines.push(`${padRight(key, 25)} ${padLeft(display, 14)}`);
        }
      }
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(`Failed to read meminfo: ${err.message}`);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// DOCKER TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

function containerSummary(c) {
  const name = (c.Names?.[0] || "").replace(/^\//, "");
  const id = c.Id?.slice(0, 12) || "";
  const image = c.Image || "";
  const state = c.State || "";
  const status = c.Status || "";
  return { id, name, image, state, status };
}

function containerTable(containers) {
  if (!containers.length) return "No containers found.";
  const rows = containers.map(containerSummary);
  const lines = [];
  const header = `${padRight("ID", 14)} ${padRight("Name", 30)} ${padRight("Image", 35)} ${padRight("State", 10)} ${padRight("Status", 25)}`;
  lines.push(header);
  lines.push("─".repeat(header.length));
  for (const r of rows) {
    lines.push(`${padRight(r.id, 14)} ${padRight(r.name, 30)} ${padRight(r.image, 35)} ${padRight(r.state, 10)} ${padRight(r.status, 25)}`);
  }
  return lines.join("\n");
}

// ── list_containers ──────────────────────────────────────────────────────────
server.tool(
  "list_containers",
  "List Docker containers with optional filters",
  {
    all: z.boolean().default(false).describe("Include stopped containers"),
    name_filter: z.string().optional().describe("Filter by container name substring"),
    label_filter: z.string().optional().describe("Filter by label, e.g. 'app=web'"),
  },
  async ({ all, name_filter, label_filter }) => {
    try {
      let path = `/containers/json?all=${all}`;
      const filters = {};
      if (name_filter) filters.name = [name_filter];
      if (label_filter) filters.label = [label_filter];
      if (Object.keys(filters).length > 0) {
        path += `&filters=${encodeURIComponent(JSON.stringify(filters))}`;
      }

      const containers = await dockerApi("GET", path);
      if (!Array.isArray(containers)) {
        return errorResult(`Unexpected Docker API response: ${JSON.stringify(containers).slice(0, 200)}`);
      }

      const lines = [
        `Docker Containers${all ? " (including stopped)" : ""}`,
        "═══════════════════════════════════════",
        "",
        containerTable(containers),
        "",
        `Total: ${containers.length}`,
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(`Docker error: ${err.message}`);
    }
  }
);

// ── inspect_container ────────────────────────────────────────────────────────
server.tool(
  "inspect_container",
  "Full inspect details for a Docker container",
  {
    id: z.string().describe("Container ID or name"),
  },
  async ({ id }) => {
    try {
      const info = await dockerApi("GET", `/containers/${encodeURIComponent(id)}/json`);

      const name = (info.Name || "").replace(/^\//, "");
      const state = info.State || {};
      const config = info.Config || {};
      const network = info.NetworkSettings || {};
      const mounts = info.Mounts || [];

      const lines = [
        `Container: ${name}`,
        "═══════════════════════════════════════",
        "",
        `ID            ${info.Id?.slice(0, 12)}`,
        `Image         ${config.Image || ""}`,
        `Created       ${info.Created || ""}`,
        `Status        ${state.Status || ""}`,
        `Running       ${state.Running || false}`,
        `PID           ${state.Pid || "N/A"}`,
        `RestartCount  ${info.RestartCount || 0}`,
        "",
        "Ports:",
      ];

      const ports = network.Ports || {};
      if (Object.keys(ports).length === 0) {
        lines.push("  (none)");
      } else {
        for (const [containerPort, bindings] of Object.entries(ports)) {
          if (bindings && bindings.length > 0) {
            for (const b of bindings) {
              lines.push(`  ${b.HostIp || "0.0.0.0"}:${b.HostPort} -> ${containerPort}`);
            }
          } else {
            lines.push(`  ${containerPort} (not published)`);
          }
        }
      }

      lines.push("", "Environment:");
      const env = config.Env || [];
      for (const e of env.slice(0, 20)) {
        lines.push(`  ${e}`);
      }
      if (env.length > 20) lines.push(`  ... and ${env.length - 20} more`);

      lines.push("", "Mounts:");
      if (mounts.length === 0) {
        lines.push("  (none)");
      } else {
        for (const m of mounts) {
          lines.push(`  ${m.Source} -> ${m.Destination} (${m.Mode || "rw"})`);
        }
      }

      // Labels
      const labels = config.Labels || {};
      const labelKeys = Object.keys(labels);
      if (labelKeys.length > 0) {
        lines.push("", "Labels:");
        for (const k of labelKeys.slice(0, 30)) {
          lines.push(`  ${k}=${labels[k]}`);
        }
        if (labelKeys.length > 30) lines.push(`  ... and ${labelKeys.length - 30} more`);
      }

      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(`Docker error: ${err.message}`);
    }
  }
);

// ── container_logs ───────────────────────────────────────────────────────────
server.tool(
  "container_logs",
  "Tail logs from a Docker container",
  {
    id: z.string().describe("Container ID or name"),
    tail: z.number().default(100).describe("Number of lines to tail (default 100)"),
    since: z.string().optional().describe("Show logs since timestamp (e.g. '2024-01-01T00:00:00Z' or '10m')"),
  },
  async ({ id, tail, since }) => {
    try {
      let path = `/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&tail=${tail}`;
      if (since) path += `&since=${encodeURIComponent(since)}`;

      const raw = await dockerApiRaw("GET", path, TIMEOUT_LOGS);

      // Docker log stream has 8-byte header per frame; strip it for readability
      const cleaned = raw.replace(/[\x00-\x08]/g, "").replace(/\r/g, "");

      const lines = [
        `Logs: ${id} (last ${tail} lines)`,
        "═══════════════════════════════════════",
        "",
        cleaned || "(no log output)",
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(`Docker error: ${err.message}`);
    }
  }
);

// ── start_container ──────────────────────────────────────────────────────────
server.tool(
  "start_container",
  "Start a stopped Docker container",
  {
    id: z.string().describe("Container ID or name"),
  },
  async ({ id }) => {
    try {
      const { statusCode, body } = await dockerApiPost(`/containers/${encodeURIComponent(id)}/start`);
      if (statusCode === 204 || statusCode === 304) {
        return textResult(`Container ${id} started successfully.`);
      }
      const parsed = body ? JSON.parse(body) : {};
      return errorResult(`Failed to start ${id}: ${parsed.message || `HTTP ${statusCode}`}`);
    } catch (err) {
      return errorResult(`Docker error: ${err.message}`);
    }
  }
);

// ── stop_container ───────────────────────────────────────────────────────────
server.tool(
  "stop_container",
  "Stop a running Docker container with optional timeout",
  {
    id: z.string().describe("Container ID or name"),
    timeout: z.number().default(10).describe("Seconds to wait before killing (default 10)"),
  },
  async ({ id, timeout }) => {
    try {
      const { statusCode, body } = await dockerApiPost(`/containers/${encodeURIComponent(id)}/stop?t=${timeout}`);
      if (statusCode === 204 || statusCode === 304) {
        return textResult(`Container ${id} stopped successfully.`);
      }
      const parsed = body ? JSON.parse(body) : {};
      return errorResult(`Failed to stop ${id}: ${parsed.message || `HTTP ${statusCode}`}`);
    } catch (err) {
      return errorResult(`Docker error: ${err.message}`);
    }
  }
);

// ── restart_container ────────────────────────────────────────────────────────
server.tool(
  "restart_container",
  "Restart a Docker container",
  {
    id: z.string().describe("Container ID or name"),
  },
  async ({ id }) => {
    try {
      const { statusCode, body } = await dockerApiPost(`/containers/${encodeURIComponent(id)}/restart`);
      if (statusCode === 204) {
        return textResult(`Container ${id} restarted successfully.`);
      }
      const parsed = body ? JSON.parse(body) : {};
      return errorResult(`Failed to restart ${id}: ${parsed.message || `HTTP ${statusCode}`}`);
    } catch (err) {
      return errorResult(`Docker error: ${err.message}`);
    }
  }
);

// ── compose_status ───────────────────────────────────────────────────────────
server.tool(
  "compose_status",
  "Show Docker Compose projects with their containers grouped by project",
  {},
  async () => {
    try {
      const containers = await dockerApi("GET", "/containers/json?all=true");
      if (!Array.isArray(containers)) {
        return errorResult("Unexpected Docker API response");
      }

      // Group by compose project label
      const projects = {};
      let nonCompose = 0;

      for (const c of containers) {
        const labels = c.Labels || {};
        const project = labels["com.docker.compose.project"];
        if (!project) {
          nonCompose++;
          continue;
        }
        if (!projects[project]) projects[project] = [];
        projects[project].push(c);
      }

      const projectNames = Object.keys(projects).sort();
      if (projectNames.length === 0) {
        return textResult("No Docker Compose projects found." + (nonCompose > 0 ? ` (${nonCompose} non-compose containers running)` : ""));
      }

      const lines = ["Docker Compose Projects", "═══════════════════════════════════════", ""];

      for (const proj of projectNames) {
        const pContainers = projects[proj];
        lines.push(`Project: ${proj} (${pContainers.length} containers)`);
        lines.push("─".repeat(40));

        for (const c of pContainers) {
          const s = containerSummary(c);
          const service = c.Labels?.["com.docker.compose.service"] || s.name;
          lines.push(`  ${padRight(service, 25)} ${padRight(s.state, 10)} ${s.status}`);
        }
        lines.push("");
      }

      if (nonCompose > 0) {
        lines.push(`(${nonCompose} additional non-compose containers)`);
      }

      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(`Docker error: ${err.message}`);
    }
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[infra-mcp] Server started");
