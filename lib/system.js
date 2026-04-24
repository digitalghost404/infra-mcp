import { z } from "zod";
import {
  TIMEOUT_SYSTEM,
  errorResult,
  execWithTimeout,
  humanBytes,
  humanUptime,
  padLeft,
  padRight,
  readProc,
  textResult,
} from "./helpers.js";

const NVIDIA_SMI = process.env.NVIDIA_SMI_PATH || "nvidia-smi";

function jsonResult(value) {
  return textResult(JSON.stringify(value, null, 2));
}

export function registerSystemTools(server) {
  server.tool(
    "system_overview",
    "One-shot system health check: CPU load averages, memory usage, swap, and uptime",
    {
      format: z.enum(["text", "json"]).default("text").describe("Output format"),
    },
    async ({ format }) => {
      try {
        const [loadavgRaw, meminfoRaw, uptimeRaw] = await Promise.all([
          readProc("/proc/loadavg"),
          readProc("/proc/meminfo"),
          readProc("/proc/uptime"),
        ]);

        const loadParts = loadavgRaw.split(/\s+/);
        const [load1, load5, load15] = loadParts.slice(0, 3);
        const runnable = loadParts[3];
        const uptimeSecs = parseFloat(uptimeRaw.split(/\s+/)[0]);

        const mem = {};
        for (const line of meminfoRaw.split("\n")) {
          const match = line.match(/^(\w+):\s+(\d+)/);
          if (match) mem[match[1]] = parseInt(match[2], 10);
        }

        const totalMem = mem.MemTotal || 0;
        const availMem = mem.MemAvailable || 0;
        const usedMem = totalMem - availMem;
        const memPct = totalMem > 0 ? Number(((usedMem / totalMem) * 100).toFixed(1)) : 0;
        const swapTotal = mem.SwapTotal || 0;
        const swapFree = mem.SwapFree || 0;
        const swapUsed = swapTotal - swapFree;
        const swapPct = swapTotal > 0 ? Number(((swapUsed / swapTotal) * 100).toFixed(1)) : 0;

        if (format === "json") {
          return jsonResult({
            loadavg: [Number(load1), Number(load5), Number(load15)],
            memory: {
              total_kb: totalMem,
              used_kb: usedMem,
              available_kb: availMem,
              pct: memPct,
            },
            swap: {
              total_kb: swapTotal,
              used_kb: swapUsed,
              pct: swapPct,
            },
            uptime_seconds: uptimeSecs,
            processes_runnable: runnable,
          });
        }

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

  server.tool(
    "gpu_status",
    "NVIDIA GPU status: name, temperature, utilization, VRAM usage",
    {
      format: z.enum(["text", "json"]).default("text").describe("Output format"),
    },
    async ({ format }) => {
      try {
        const { stdout } = await execWithTimeout(NVIDIA_SMI, [
          "--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.free,memory.total",
          "--format=csv,noheader,nounits",
        ], TIMEOUT_SYSTEM);

        const rows = stdout.trim().split("\n").filter(Boolean).map((row) => {
          const [name, temp, util, memUsed, memFree, memTotal] = row.split(",").map((s) => s.trim());
          return {
            name,
            temp_c: Number(temp),
            util_pct: Number(util),
            mem_used_mb: Number(memUsed),
            mem_free_mb: Number(memFree),
            mem_total_mb: Number(memTotal),
          };
        });

        if (format === "json") {
          return jsonResult(rows);
        }

        const lines = ["GPU Status", "═══════════════════════════════════════", ""];
        const header = `${padRight("GPU", 30)} ${padLeft("Temp", 6)} ${padLeft("Util%", 7)} ${padLeft("VRAM Used", 11)} ${padLeft("VRAM Free", 11)} ${padLeft("VRAM Total", 11)}`;
        lines.push(header);
        lines.push("─".repeat(header.length));

        for (const row of rows) {
          lines.push(
            `${padRight(row.name, 30)} ${padLeft(row.temp_c + "C", 6)} ${padLeft(row.util_pct + "%", 7)} ${padLeft(row.mem_used_mb + " MB", 11)} ${padLeft(row.mem_free_mb + " MB", 11)} ${padLeft(row.mem_total_mb + " MB", 11)}`
          );
        }
        return textResult(lines.join("\n"));
      } catch (err) {
        if (err.code === "ENOENT" || err.message?.includes("not found")) {
          return format === "json" ? jsonResult([]) : textResult("No NVIDIA GPU detected (nvidia-smi not found)");
        }
        return errorResult(`GPU query failed: ${err.message}`);
      }
    }
  );

  server.tool(
    "gpu_processes",
    "List processes currently using NVIDIA GPU VRAM",
    {
      format: z.enum(["text", "json"]).default("text").describe("Output format"),
    },
    async ({ format }) => {
      try {
        const { stdout } = await execWithTimeout(NVIDIA_SMI, [
          "--query-compute-apps=pid,used_memory,name",
          "--format=csv,noheader,nounits",
        ], TIMEOUT_SYSTEM);

        const rows = stdout.trim()
          ? stdout.trim().split("\n").filter(Boolean).map((row) => {
              const [pid, mem, name] = row.split(",").map((s) => s.trim());
              return { pid: Number(pid), vram_mb: Number(mem), name };
            })
          : [];

        if (format === "json") {
          return jsonResult(rows);
        }

        if (!rows.length) {
          return textResult("No processes currently using GPU VRAM.");
        }

        const lines = ["GPU Processes", "═══════════════════════════════════════", ""];
        const header = `${padRight("PID", 10)} ${padLeft("VRAM (MB)", 12)}  ${padRight("Process", 50)}`;
        lines.push(header);
        lines.push("─".repeat(header.length));

        for (const row of rows) {
          lines.push(`${padRight(row.pid, 10)} ${padLeft(row.vram_mb, 12)}  ${padRight(row.name, 50)}`);
        }
        return textResult(lines.join("\n"));
      } catch (err) {
        if (err.code === "ENOENT" || err.message?.includes("not found")) {
          return format === "json" ? jsonResult([]) : textResult("No NVIDIA GPU detected (nvidia-smi not found)");
        }
        return errorResult(`GPU process query failed: ${err.message}`);
      }
    }
  );

  server.tool(
    "disk_usage",
    "Disk usage per mount point (excludes tmpfs, devtmpfs, efivarfs)",
    {
      format: z.enum(["text", "json"]).default("text").describe("Output format"),
    },
    async ({ format }) => {
      try {
        if (format === "json") {
          const { stdout } = await execWithTimeout("df", [
            "-h", "--output=target,size,used,avail,pcent,fstype",
          ], TIMEOUT_SYSTEM);
          const rows = stdout.trim().split("\n").slice(1).filter(Boolean);
          const data = rows
            .map((line) => line.match(/^(.*\S)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/))
            .filter(Boolean)
            .map(([, mount, size, used, avail, pct, fstype]) => ({ mount, size, used, avail, pct, fstype }))
            .filter((row) => !new Set(["tmpfs", "devtmpfs", "efivarfs"]).has(row.fstype));
          return jsonResult(data);
        }

        const { stdout } = await execWithTimeout("df", [
          "-h", "--output=target,size,used,avail,pcent",
        ], TIMEOUT_SYSTEM);

        const exclude = new Set(["tmpfs", "devtmpfs", "efivarfs"]);
        const rows = stdout.trim().split("\n");
        const header = rows[0];
        const filtered = [header];

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

  server.tool(
    "io_pressure",
    "PSI (Pressure Stall Information) for CPU, memory, and I/O — shows if the system is under real stress",
    {
      format: z.enum(["text", "json"]).default("text").describe("Output format"),
    },
    async ({ format }) => {
      try {
        const resources = ["cpu", "memory", "io"];

        if (format === "json") {
          const data = {};
          for (const res of resources) {
            try {
              const raw = await readProc(`/proc/pressure/${res}`);
              data[res] = { some: null, full: null };
              for (const line of raw.split("\n")) {
                const match = line.match(/^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)\s+total=(\d+)/);
                if (match) {
                  const [, type, avg10, avg60, avg300, total] = match;
                  data[res][type] = {
                    avg10: Number(avg10),
                    avg60: Number(avg60),
                    avg300: Number(avg300),
                    total: Number(total),
                  };
                }
              }
            } catch {
              data[res] = { some: null, full: null };
            }
          }
          return jsonResult(data);
        }

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

  server.tool(
    "top_processes",
    "Top N processes sorted by CPU or memory usage",
    {
      sort_by: z.enum(["cpu", "mem"]).default("cpu").describe("Sort by 'cpu' or 'mem'"),
      count: z.number().min(1).max(50).default(10).describe("Number of processes to return"),
      format: z.enum(["text", "json"]).default("text").describe("Output format"),
    },
    async ({ sort_by, count, format }) => {
      try {
        if (format === "json") {
          const sortField = sort_by === "cpu" ? "-pcpu" : "-pmem";
          const { stdout } = await execWithTimeout("ps", [
            "-eo", "pid,user,pcpu,pmem,vsz,rss,tty,stat,start,time,command",
            `--sort=${sortField}`,
          ], TIMEOUT_SYSTEM);
          const data = stdout.trim().split("\n").slice(1, count + 1).map((line) => line.trim().split(/\s+/, 11)).filter((parts) => parts.length >= 11).map(([pid, user, cpu, mem, vsz, rss, tty, stat, start, time, command]) => ({
            pid: Number(pid),
            user,
            cpu_pct: Number(cpu),
            mem_pct: Number(mem),
            vsz: Number(vsz),
            rss: Number(rss),
            tty,
            stat,
            start,
            time,
            command,
          }));
          return jsonResult(data);
        }

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

  server.tool(
    "service_status",
    "Check systemd service status (system or user unit)",
    {
      service: z.string().describe("Service/unit name, e.g. 'docker' or 'podman.socket'"),
      user: z.boolean().default(false).describe("Check user service (--user) instead of system"),
      format: z.enum(["text", "json"]).default("text").describe("Output format"),
    },
    async ({ service, user, format }) => {
      try {
        if (format === "json") {
          const baseArgs = user ? ["--user"] : [];
          try {
            const { stdout } = await execWithTimeout("systemctl", [
              ...baseArgs,
              "show",
              service,
              "--property=Id,LoadState,ActiveState,SubState,MainPID",
              "--output=json",
            ], TIMEOUT_SYSTEM);
            const parsed = JSON.parse(stdout);
            const unit = Array.isArray(parsed) ? parsed[0] : parsed;
            return jsonResult({
              service: unit?.Id || service,
              load_state: unit?.LoadState || "",
              active_state: unit?.ActiveState || "",
              sub_state: unit?.SubState || "",
              main_pid: Number(unit?.MainPID) || 0,
            });
          } catch {
            const { stdout } = await execWithTimeout("systemctl", [
              ...baseArgs,
              "show",
              service,
              "--property=Id,LoadState,ActiveState,SubState,MainPID",
            ], TIMEOUT_SYSTEM);
            const data = { service, load_state: "", active_state: "", sub_state: "", main_pid: 0 };
            for (const line of stdout.split("\n")) {
              const [key, ...rest] = line.split("=");
              const value = rest.join("=");
              if (key === "Id" && value) data.service = value;
              if (key === "LoadState") data.load_state = value;
              if (key === "ActiveState") data.active_state = value;
              if (key === "SubState") data.sub_state = value;
              if (key === "MainPID") data.main_pid = Number(value) || 0;
            }
            return jsonResult(data);
          }
        }

        const args = user ? ["--user", "status", service] : ["status", service];
        const { stdout, stderr } = await execWithTimeout("systemctl", args, TIMEOUT_SYSTEM);
        return textResult(stdout || stderr);
      } catch (err) {
        if (err.stdout || err.stderr) {
          if (format === "json") {
            const raw = err.stdout || err.stderr;
            const data = { service, load_state: "", active_state: "", sub_state: "", main_pid: 0 };
            for (const line of raw.split("\n")) {
              const [key, ...rest] = line.split("=");
              const value = rest.join("=");
              if (key === "Id" && value) data.service = value;
              if (key === "LoadState") data.load_state = value;
              if (key === "ActiveState") data.active_state = value;
              if (key === "SubState") data.sub_state = value;
              if (key === "MainPID") data.main_pid = Number(value) || 0;
            }
            return jsonResult(data);
          }
          return textResult(err.stdout || err.stderr);
        }
        return errorResult(`Failed to get service status: ${err.message}`);
      }
    }
  );

  server.tool(
    "memory_detail",
    "Full /proc/meminfo breakdown with human-readable sizes",
    {
      format: z.enum(["text", "json"]).default("text").describe("Output format"),
    },
    async ({ format }) => {
      try {
        const raw = await readProc("/proc/meminfo");

        if (format === "json") {
          const data = {};
          for (const line of raw.split("\n")) {
            const match = line.match(/^(.+?):\s+(\d+)\s*(kB)?/);
            if (match) {
              const key = `${match[1].trim()}_kb`;
              data[key] = parseInt(match[2], 10);
            }
          }
          return jsonResult(data);
        }

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
}
