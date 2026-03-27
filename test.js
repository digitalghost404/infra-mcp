#!/usr/bin/env node
/**
 * infra-mcp — Test suite
 * Spawns the MCP server as a subprocess and communicates via JSON-RPC over stdio.
 * System tools: tested against /proc (always available on Linux)
 * Docker tools: skipped gracefully if socket not available
 * GPU tools: skipped gracefully if no nvidia-smi
 */

import { spawn } from "child_process";
import { access } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Colours ──────────────────────────────────────────────────────────────────
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const B = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;

// ─── MCP client ───────────────────────────────────────────────────────────────
class McpTestClient {
  constructor() {
    this.proc = null;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn("node", [path.join(__dirname, "index.js")], {
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.proc.stdout.on("data", (chunk) => {
        this.buffer += chunk.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            const resolve = this.pending.get(msg.id);
            if (resolve) {
              this.pending.delete(msg.id);
              resolve(msg);
            }
          } catch {
            /* ignore non-JSON lines */
          }
        }
      });

      this.proc.stderr.on("data", () => {}); // suppress server logs

      this.proc.on("error", reject);

      this.call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "infra-mcp-test", version: "1" },
      }).then((res) => {
        const notif = JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }) + "\n";
        this.proc.stdin.write(notif);
        resolve(res);
      }).catch(reject);
    });
  }

  call(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.proc.stdin.write(msg);
    });
  }

  tool(name, args = {}, timeoutMs = 30000) {
    return this.call("tools/call", { name, arguments: args }, timeoutMs);
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.proc) return resolve();
      this.proc.on("close", resolve);
      this.proc.kill();
    });
  }
}

// ─── Test runner ──────────────────────────────────────────────────────────────
const results = [];

function assert(condition, testName, detail = "") {
  results.push({ name: testName, pass: !!condition, detail });
}

function skip(testName, reason) {
  results.push({ name: testName, pass: true, detail: `SKIPPED: ${reason}`, skipped: true });
}

function getText(res) {
  return res?.result?.content?.[0]?.text ?? "";
}

function isError(res) {
  return !!(res?.error || res?.result?.isError);
}

// ─── Feature detection ───────────────────────────────────────────────────────
async function hasDocker() {
  const sock = process.env.DOCKER_HOST || "/var/run/docker.sock";
  try {
    await access(sock);
    return true;
  } catch {
    return false;
  }
}

async function hasNvidiaSmi() {
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const exec = promisify(execFile);
    await exec(process.env.NVIDIA_SMI_PATH || "nvidia-smi", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log(B("\ninfra-mcp — Test Suite\n"));

const docker = await hasDocker();
const gpu = await hasNvidiaSmi();
console.log(DIM(`Docker: ${docker ? "available" : "not available"}`));
console.log(DIM(`GPU:    ${gpu ? "available" : "not available"}\n`));

const client = new McpTestClient();

// ── Server Init ──────────────────────────────────────────────────────────────
console.log(Y("Server Init"));
let initRes;
try {
  initRes = await client.start();
  const serverName = initRes?.result?.serverInfo?.name ?? "";
  assert(serverName === "infra-mcp", "server init: name is 'infra-mcp'", `serverInfo.name = "${serverName}"`);
} catch (e) {
  assert(false, "server init: name is 'infra-mcp'", `Failed to start: ${e.message}`);
  console.log(R("Fatal: could not start server. Aborting."));
  process.exit(1);
}

// ── List tools ───────────────────────────────────────────────────────────────
console.log(Y("\ntools/list"));
try {
  const res = await client.call("tools/list");
  const tools = res?.result?.tools ?? [];
  const toolNames = tools.map((t) => t.name).sort();
  assert(tools.length === 15, "tools/list: has 15 tools", `found ${tools.length}: ${toolNames.join(", ")}`);

  const expected = [
    "system_overview", "gpu_status", "gpu_processes", "disk_usage",
    "io_pressure", "top_processes", "service_status", "memory_detail",
    "list_containers", "inspect_container", "container_logs",
    "start_container", "stop_container", "restart_container", "compose_status",
  ].sort();

  const missing = expected.filter((n) => !toolNames.includes(n));
  assert(missing.length === 0, "tools/list: all expected tools registered", missing.length > 0 ? `missing: ${missing.join(", ")}` : "all present");
} catch (e) {
  assert(false, "tools/list: has 15 tools", e.message);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM TOOLS
// ═══════════════════════════════════════════════════════════════════════════════
console.log(Y("\nsystem_overview"));
try {
  const res = await client.tool("system_overview");
  const text = getText(res);
  assert(
    text.includes("Load avg") && text.includes("Memory") && text.includes("Uptime"),
    "system_overview: contains Load avg, Memory, Uptime",
    text.split("\n").slice(0, 3).join(" | ")
  );
  assert(!isError(res), "system_overview: no error", "");
} catch (e) {
  assert(false, "system_overview: contains Load avg, Memory, Uptime", e.message);
}

console.log(Y("\nmemory_detail"));
try {
  const res = await client.tool("memory_detail");
  const text = getText(res);
  assert(
    text.includes("MemTotal") && text.includes("MemFree"),
    "memory_detail: contains MemTotal and MemFree",
    text.split("\n").slice(3, 6).join(" | ")
  );
} catch (e) {
  assert(false, "memory_detail: contains MemTotal and MemFree", e.message);
}

console.log(Y("\ndisk_usage"));
try {
  const res = await client.tool("disk_usage");
  const text = getText(res);
  assert(
    text.includes("Mounted on") || text.includes("/"),
    "disk_usage: contains mount points",
    text.split("\n").slice(0, 5).join(" | ")
  );
} catch (e) {
  assert(false, "disk_usage: contains mount points", e.message);
}

console.log(Y("\nio_pressure"));
try {
  const res = await client.tool("io_pressure");
  const text = getText(res);
  const hasPsi = text.includes("avg10=") || text.includes("not supported") || text.includes("not available");
  assert(hasPsi, "io_pressure: returns PSI data or 'not supported'", text.split("\n").slice(0, 4).join(" | "));
} catch (e) {
  assert(false, "io_pressure: returns PSI data or 'not supported'", e.message);
}

console.log(Y("\ntop_processes (by CPU)"));
try {
  const res = await client.tool("top_processes", { sort_by: "cpu", count: 5 });
  const text = getText(res);
  assert(
    text.includes("Top 5") && text.includes("CPU"),
    "top_processes: returns top 5 by CPU header",
    text.split("\n")[0]
  );
  // Should have header + separator + at least 1 process
  const lineCount = text.trim().split("\n").length;
  assert(lineCount >= 6, "top_processes: has at least 6 lines (title + header + separator + processes)", `${lineCount} lines`);
} catch (e) {
  assert(false, "top_processes: returns top 5 by CPU", e.message);
}

console.log(Y("\ntop_processes (by memory)"));
try {
  const res = await client.tool("top_processes", { sort_by: "mem", count: 3 });
  const text = getText(res);
  assert(
    text.includes("Memory"),
    "top_processes: returns memory sort header",
    text.split("\n")[0]
  );
} catch (e) {
  assert(false, "top_processes: returns memory sort header", e.message);
}

console.log(Y("\nservice_status"));
try {
  // Test with a service that should exist on most systems
  const res = await client.tool("service_status", { service: "dbus.service" });
  const text = getText(res);
  // Even if service doesn't exist, systemctl will return a status message
  assert(text.length > 0, "service_status: returns non-empty output for dbus", text.split("\n")[0]);
} catch (e) {
  assert(false, "service_status: returns non-empty output for dbus", e.message);
}

// ── GPU tools ────────────────────────────────────────────────────────────────
console.log(Y("\ngpu_status"));
if (gpu) {
  try {
    const res = await client.tool("gpu_status");
    const text = getText(res);
    assert(
      text.includes("GPU Status") && text.includes("Temp"),
      "gpu_status: contains GPU Status header and Temp column",
      text.split("\n").slice(0, 5).join(" | ")
    );
  } catch (e) {
    assert(false, "gpu_status: contains GPU Status header", e.message);
  }
} else {
  try {
    const res = await client.tool("gpu_status");
    const text = getText(res);
    assert(
      text.includes("No NVIDIA GPU"),
      "gpu_status: gracefully reports no GPU",
      text
    );
  } catch (e) {
    assert(false, "gpu_status: gracefully reports no GPU", e.message);
  }
}

console.log(Y("\ngpu_processes"));
if (gpu) {
  try {
    const res = await client.tool("gpu_processes");
    const text = getText(res);
    assert(
      text.includes("GPU Processes") || text.includes("No processes"),
      "gpu_processes: returns process list or 'no processes'",
      text.split("\n")[0]
    );
  } catch (e) {
    assert(false, "gpu_processes: returns process list", e.message);
  }
} else {
  try {
    const res = await client.tool("gpu_processes");
    const text = getText(res);
    assert(
      text.includes("No NVIDIA GPU"),
      "gpu_processes: gracefully reports no GPU",
      text
    );
  } catch (e) {
    assert(false, "gpu_processes: gracefully reports no GPU", e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCKER TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

if (docker) {
  console.log(Y("\nlist_containers"));
  try {
    const res = await client.tool("list_containers", { all: true });
    const text = getText(res);
    assert(
      text.includes("Docker Containers") && text.includes("Total:"),
      "list_containers: contains header and total count",
      text.split("\n").slice(0, 3).join(" | ")
    );
  } catch (e) {
    assert(false, "list_containers: contains header and total count", e.message);
  }

  console.log(Y("\ncompose_status"));
  try {
    const res = await client.tool("compose_status");
    const text = getText(res);
    assert(
      text.includes("Compose") || text.includes("No Docker Compose"),
      "compose_status: returns compose projects or 'none found'",
      text.split("\n")[0]
    );
  } catch (e) {
    assert(false, "compose_status: returns compose projects", e.message);
  }
} else {
  console.log(Y("\nDocker tools"));
  skip("list_containers", "Docker socket not available");
  skip("compose_status", "Docker socket not available");
  skip("inspect_container", "Docker socket not available");
  skip("container_logs", "Docker socket not available");
  skip("start_container", "Docker socket not available");
  skip("stop_container", "Docker socket not available");
  skip("restart_container", "Docker socket not available");

  // Verify docker tools return error, not crash
  console.log(Y("\nlist_containers (no docker)"));
  try {
    const res = await client.tool("list_containers");
    const text = getText(res);
    assert(
      isError(res) || text.includes("Docker") || text.includes("error"),
      "list_containers: returns error message when docker unavailable",
      text.slice(0, 100)
    );
  } catch (e) {
    assert(false, "list_containers: returns error (not crash) without docker", e.message);
  }
}

// ─── Cleanup & Report ─────────────────────────────────────────────────────────
await client.stop();

const passed = results.filter((r) => r.pass && !r.skipped);
const skipped = results.filter((r) => r.skipped);
const failed = results.filter((r) => !r.pass);

console.log(B("\n─────────────────────────────────────────"));
console.log(B("Results\n"));

for (const r of results) {
  if (r.skipped) {
    console.log(`${Y("SKIP")} ${r.name.padEnd(55)} ${DIM(String(r.detail))}`);
  } else if (r.pass) {
    console.log(`${G("PASS")} ${r.name.padEnd(55)} ${DIM(String(r.detail).replace(/\n/g, " ").slice(0, 80))}`);
  } else {
    console.log(`${R("FAIL")} ${r.name.padEnd(55)} ${Y(String(r.detail))}`);
  }
}

console.log(B("\n─────────────────────────────────────────"));
console.log(
  `${G(`PASS ${passed.length}`)}  ${skipped.length ? Y(`SKIP ${skipped.length}`) + "  " : ""}${failed.length ? R(`FAIL ${failed.length}`) : ""}  / ${results.length} total\n`
);

if (failed.length) process.exit(1);
