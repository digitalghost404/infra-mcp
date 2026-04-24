import { z } from "zod";
import {
  TIMEOUT_LOGS,
  containerSummary,
  containerTable,
  dockerApi,
  dockerApiPost,
  dockerApiRaw,
  errorResult,
  jsonTextResult,
  padLeft,
  padRight,
  textResult,
} from "./helpers.js";

const FORMAT_PARAM = z.enum(["text", "json"]).default("text").describe("Output format");

function humanBytesFromBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function humanMbFromBytes(bytes) {
  return `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)} MB`;
}

function formatCreated(value) {
  if (!value) return "";
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 19).replace("T", " ");
}

function cleanImageId(id) {
  return String(id || "").replace(/^sha256:/, "");
}

function parseRepoTags(tags) {
  return Array.isArray(tags) ? tags.filter((tag) => tag && tag !== "<none>:<none>") : [];
}

function sumNetworkBytes(networks = {}) {
  return Object.values(networks).reduce(
    (totals, network) => ({
      rx: totals.rx + Number(network?.rx_bytes || 0),
      tx: totals.tx + Number(network?.tx_bytes || 0),
    }),
    { rx: 0, tx: 0 }
  );
}

function sumBlockIo(blkio = {}) {
  const entries = Array.isArray(blkio?.io_service_bytes_recursive) ? blkio.io_service_bytes_recursive : [];
  return entries.reduce(
    (totals, entry) => {
      const op = String(entry?.op || "").toLowerCase();
      const value = Number(entry?.value || 0);
      if (op === "read") totals.read += value;
      if (op === "write") totals.write += value;
      return totals;
    },
    { read: 0, write: 0 }
  );
}

function computeCpuPct(stats) {
  const cpuDelta = Number(stats?.cpu_stats?.cpu_usage?.total_usage || 0) - Number(stats?.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = Number(stats?.cpu_stats?.system_cpu_usage || 0) - Number(stats?.precpu_stats?.system_cpu_usage || 0);
  const onlineCpus = Number(stats?.cpu_stats?.online_cpus || stats?.cpu_stats?.cpu_usage?.percpu_usage?.length || 1);
  if (cpuDelta <= 0 || systemDelta <= 0) return 0;
  return (cpuDelta / systemDelta) * onlineCpus * 100;
}

function getMemoryUsageBytes(stats) {
  const usage = Number(stats?.memory_stats?.usage || 0);
  const inactiveFile = Number(stats?.memory_stats?.stats?.inactive_file || 0);
  return Math.max(usage - inactiveFile, 0);
}

function parsePruneBody(body) {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function countPruneObjects(data) {
  if (Array.isArray(data?.ImagesDeleted)) return data.ImagesDeleted.length;
  if (Array.isArray(data?.VolumesDeleted)) return data.VolumesDeleted.length;
  if (Array.isArray(data?.CachesDeleted)) return data.CachesDeleted.length;
  if (Array.isArray(data?.ContainersDeleted)) return data.ContainersDeleted.length;
  return 0;
}

export function registerDockerTools(server) {
  server.tool(
    "list_containers",
    "List Docker containers with optional filters",
    {
      all: z.boolean().default(false).describe("Include stopped containers"),
      name_filter: z.string().optional().describe("Filter by container name substring"),
      label_filter: z.string().optional().describe("Filter by label, e.g. 'app=web'"),
      format: FORMAT_PARAM,
    },
    async ({ all, name_filter, label_filter, format }) => {
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

        if (format === "json") {
          return jsonTextResult(containers.map((container) => ({
            id: container.Id || "",
            name: (container.Names?.[0] || "").replace(/^\//, ""),
            image: container.Image || "",
            state: container.State || "",
            status: container.Status || "",
          })));
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

  server.tool(
    "inspect_container",
    "Full inspect details for a Docker container",
    {
      id: z.string().describe("Container ID or name"),
      format: FORMAT_PARAM,
    },
    async ({ id, format }) => {
      try {
        const info = await dockerApi("GET", `/containers/${encodeURIComponent(id)}/json`);

        const name = (info.Name || "").replace(/^\//, "");
        const state = info.State || {};
        const config = info.Config || {};
        const network = info.NetworkSettings || {};
        const mounts = info.Mounts || [];

        if (format === "json") {
          const ports = [];
          for (const [containerPort, bindings] of Object.entries(network.Ports || {})) {
            if (bindings && bindings.length > 0) {
              for (const binding of bindings) {
                ports.push({
                  host_ip: binding.HostIp || "0.0.0.0",
                  host_port: binding.HostPort || "",
                  container_port: containerPort.split("/")[0],
                });
              }
            } else {
              ports.push({ host_ip: null, host_port: null, container_port: containerPort.split("/")[0] });
            }
          }

          return jsonTextResult({
            id: info.Id || "",
            name,
            image: config.Image || "",
            created: info.Created || "",
            status: state.Status || "",
            running: Boolean(state.Running),
            pid: state.Pid || 0,
            restart_count: info.RestartCount || 0,
            ports,
            env: config.Env || [],
            mounts: mounts.map((mount) => ({
              source: mount.Source || "",
              destination: mount.Destination || "",
              mode: mount.Mode || "rw",
            })),
            labels: config.Labels || {},
          });
        }

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

  server.tool(
    "container_logs",
    "Tail logs from a Docker container",
    {
      id: z.string().describe("Container ID or name"),
      tail: z.number().default(100).describe("Number of lines to tail (default 100)"),
      since: z.string().optional().describe("Show logs since timestamp (e.g. '2024-01-01T00:00:00Z' or '10m')"),
      format: FORMAT_PARAM,
    },
    async ({ id, tail, since, format }) => {
      try {
        let path = `/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&tail=${tail}`;
        if (since) path += `&since=${encodeURIComponent(since)}`;

        const raw = await dockerApiRaw("GET", path, TIMEOUT_LOGS);
        const cleaned = raw.replace(/[\x00-\x08]/g, "").replace(/\r/g, "");

        if (format === "json") {
          return jsonTextResult({
            container: id,
            lines: cleaned ? cleaned.replace(/\n$/, "").split("\n") : [],
          });
        }

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

  server.tool(
    "start_container",
    "Start a stopped Docker container",
    {
      id: z.string().describe("Container ID or name"),
      format: FORMAT_PARAM,
    },
    async ({ id, format }) => {
      try {
        const { statusCode, body } = await dockerApiPost(`/containers/${encodeURIComponent(id)}/start`);
        if (statusCode === 204 || statusCode === 304) {
          return format === "json"
            ? jsonTextResult({ container: id, started: true })
            : textResult(`Container ${id} started successfully.`);
        }
        const parsed = body ? JSON.parse(body) : {};
        return errorResult(`Failed to start ${id}: ${parsed.message || `HTTP ${statusCode}`}`);
      } catch (err) {
        return errorResult(`Docker error: ${err.message}`);
      }
    }
  );

  server.tool(
    "stop_container",
    "Stop a running Docker container with optional timeout",
    {
      id: z.string().describe("Container ID or name"),
      timeout: z.number().default(10).describe("Seconds to wait before killing (default 10)"),
      format: FORMAT_PARAM,
    },
    async ({ id, timeout, format }) => {
      try {
        const { statusCode, body } = await dockerApiPost(`/containers/${encodeURIComponent(id)}/stop?t=${timeout}`);
        if (statusCode === 204 || statusCode === 304) {
          return format === "json"
            ? jsonTextResult({ container: id, stopped: true })
            : textResult(`Container ${id} stopped successfully.`);
        }
        const parsed = body ? JSON.parse(body) : {};
        return errorResult(`Failed to stop ${id}: ${parsed.message || `HTTP ${statusCode}`}`);
      } catch (err) {
        return errorResult(`Docker error: ${err.message}`);
      }
    }
  );

  server.tool(
    "restart_container",
    "Restart a Docker container",
    {
      id: z.string().describe("Container ID or name"),
      format: FORMAT_PARAM,
    },
    async ({ id, format }) => {
      try {
        const { statusCode, body } = await dockerApiPost(`/containers/${encodeURIComponent(id)}/restart`);
        if (statusCode === 204) {
          return format === "json"
            ? jsonTextResult({ container: id, restarted: true })
            : textResult(`Container ${id} restarted successfully.`);
        }
        const parsed = body ? JSON.parse(body) : {};
        return errorResult(`Failed to restart ${id}: ${parsed.message || `HTTP ${statusCode}`}`);
      } catch (err) {
        return errorResult(`Docker error: ${err.message}`);
      }
    }
  );

  server.tool(
    "compose_status",
    "Show Docker Compose projects with their containers grouped by project",
    { format: FORMAT_PARAM },
    async ({ format }) => {
      try {
        const containers = await dockerApi("GET", "/containers/json?all=true");
        if (!Array.isArray(containers)) {
          return errorResult("Unexpected Docker API response");
        }

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
        if (format === "json") {
          return jsonTextResult({
            projects: projectNames.map((name) => ({
              name,
              containers: projects[name].map((container) => ({
                service: container.Labels?.["com.docker.compose.service"] || containerSummary(container).name,
                state: containerSummary(container).state,
                status: containerSummary(container).status,
              })),
            })),
            non_compose_count: nonCompose,
          });
        }

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

  server.tool(
    "list_images",
    "List Docker images with optional all filter",
    {
      all: z.boolean().default(false).describe("Include intermediate images"),
      format: FORMAT_PARAM,
    },
    async ({ all, format }) => {
      try {
        const images = await dockerApi("GET", `/images/json?all=${all}`);
        if (!Array.isArray(images)) return errorResult("Unexpected Docker API response");

        const rows = images.map((image) => ({
          id: cleanImageId(image.Id),
          tags: parseRepoTags(image.RepoTags),
          size_bytes: Number(image.Size || 0),
          created: Number(image.Created || 0),
          shared_size: Number(image.SharedSize || 0),
          virtual_size: Number(image.VirtualSize || 0),
        }));

        if (format === "json") return jsonTextResult(rows);

        const header = `${padRight("ID", 14)} ${padRight("Tags", 40)} ${padLeft("Size", 12)} ${padRight("Created", 19)}`;
        const lines = ["Docker Images", "═══════════════════════════════════════", "", header, "─".repeat(header.length)];
        for (const row of rows) {
          lines.push(
            `${padRight(row.id.slice(0, 12), 14)} ${padRight(row.tags.join(", ") || "<none>", 40)} ${padLeft(humanBytesFromBytes(row.size_bytes), 12)} ${padRight(formatCreated(row.created), 19)}`
          );
        }
        if (rows.length === 0) lines.push("No images found.");
        return textResult(lines.join("\n"));
      } catch (err) {
        return errorResult(`Docker error: ${err.message}`);
      }
    }
  );

  server.tool(
    "list_volumes",
    "List Docker volumes and warnings",
    { format: FORMAT_PARAM },
    async ({ format }) => {
      try {
        const payload = await dockerApi("GET", "/volumes");
        const volumes = Array.isArray(payload?.Volumes)
          ? payload.Volumes.map((volume) => ({
              name: volume.Name || "",
              driver: volume.Driver || "",
              mountpoint: volume.Mountpoint || "",
              scope: volume.Scope || "",
            }))
          : [];
        const warnings = Array.isArray(payload?.Warnings) ? payload.Warnings : [];

        if (format === "json") return jsonTextResult({ volumes, warnings });

        const header = `${padRight("Name", 28)} ${padRight("Driver", 12)} ${padRight("Mountpoint", 50)}`;
        const lines = ["Docker Volumes", "═══════════════════════════════════════", "", header, "─".repeat(header.length)];
        for (const volume of volumes) {
          lines.push(`${padRight(volume.name, 28)} ${padRight(volume.driver, 12)} ${padRight(volume.mountpoint, 50)}`);
        }
        if (volumes.length === 0) lines.push("No volumes found.");
        if (warnings.length > 0) lines.push("", `Warnings: ${warnings.join("; ")}`);
        return textResult(lines.join("\n"));
      } catch (err) {
        return errorResult(`Docker error: ${err.message}`);
      }
    }
  );

  server.tool(
    "list_networks",
    "List Docker networks with IPAM info",
    { format: FORMAT_PARAM },
    async ({ format }) => {
      try {
        const networks = await dockerApi("GET", "/networks");
        if (!Array.isArray(networks)) return errorResult("Unexpected Docker API response");

        const rows = networks.map((network) => ({
          name: network.Name || "",
          id: network.Id || "",
          driver: network.Driver || "",
          scope: network.Scope || "",
          ipam: {
            config: Array.isArray(network?.IPAM?.Config)
              ? network.IPAM.Config.map((config) => ({
                  subnet: config.Subnet || "",
                  gateway: config.Gateway || "",
                }))
              : [],
          },
          containers_count: Object.keys(network.Containers || {}).length,
        }));

        if (format === "json") return jsonTextResult(rows);

        const header = `${padRight("Name", 20)} ${padRight("Driver", 12)} ${padRight("Scope", 10)} ${padRight("Subnet", 20)} ${padRight("Gateway", 18)}`;
        const lines = ["Docker Networks", "═══════════════════════════════════════", "", header, "─".repeat(header.length)];
        for (const row of rows) {
          const firstConfig = row.ipam.config[0] || { subnet: "", gateway: "" };
          lines.push(
            `${padRight(row.name, 20)} ${padRight(row.driver, 12)} ${padRight(row.scope, 10)} ${padRight(firstConfig.subnet || "-", 20)} ${padRight(firstConfig.gateway || "-", 18)}`
          );
        }
        if (rows.length === 0) lines.push("No networks found.");
        return textResult(lines.join("\n"));
      } catch (err) {
        return errorResult(`Docker error: ${err.message}`);
      }
    }
  );

  server.tool(
    "container_health",
    "Show Docker container health check status",
    { format: FORMAT_PARAM },
    async ({ format }) => {
      try {
        const containers = await dockerApi("GET", "/containers/json?all=true");
        if (!Array.isArray(containers)) return errorResult("Unexpected Docker API response");

        const rows = await Promise.all(
          containers.map(async (container) => {
            const info = await dockerApi("GET", `/containers/${encodeURIComponent(container.Id)}/json`);
            const health = info?.State?.Health;
            const lastLog = Array.isArray(health?.Log) && health.Log.length > 0 ? health.Log[health.Log.length - 1] : {};
            return {
              name: (container.Names?.[0] || "").replace(/^\//, ""),
              id: container.Id || "",
              health_status: health?.Status || "no check",
              failing_streak: Number(health?.FailingStreak || 0),
              last_exit_code: lastLog?.ExitCode ?? null,
              last_start: lastLog?.Start || null,
              last_end: lastLog?.End || null,
            };
          })
        );

        if (format === "json") return jsonTextResult(rows);

        const header = `${padRight("Container", 28)} ${padRight("Health", 12)} ${padLeft("Fails", 7)} ${padLeft("Exit", 6)}`;
        const lines = ["Container Health", "═══════════════════════════════════════", "", header, "─".repeat(header.length)];
        for (const row of rows) {
          lines.push(
            `${padRight(row.name, 28)} ${padRight(row.health_status, 12)} ${padLeft(row.failing_streak, 7)} ${padLeft(row.last_exit_code ?? "-", 6)}`
          );
        }
        if (rows.length === 0) lines.push("No containers found.");
        return textResult(lines.join("\n"));
      } catch (err) {
        return errorResult(`Docker error: ${err.message}`);
      }
    }
  );

  server.tool(
    "docker_stats",
    "Show one-shot Docker stats for running containers",
    { format: FORMAT_PARAM },
    async ({ format }) => {
      try {
        const containers = await dockerApi("GET", "/containers/json");
        if (!Array.isArray(containers)) return errorResult("Unexpected Docker API response");

        const statsRows = await Promise.all(
          containers.map(async (container) => {
            const stats = await dockerApi("GET", `/containers/${encodeURIComponent(container.Id)}/stats?stream=false`);
            const cpuPct = computeCpuPct(stats);
            const memUsageBytes = getMemoryUsageBytes(stats);
            const memLimitBytes = Number(stats?.memory_stats?.limit || 0);
            const memPct = memLimitBytes > 0 ? (memUsageBytes / memLimitBytes) * 100 : 0;
            const net = sumNetworkBytes(stats?.networks || {});
            const block = sumBlockIo(stats?.blkio_stats || {});

            return {
              name: (container.Names?.[0] || "").replace(/^\//, ""),
              cpu_pct: Number(cpuPct.toFixed(2)),
              mem_usage_mb: Number((memUsageBytes / 1024 / 1024).toFixed(2)),
              mem_limit_mb: Number((memLimitBytes / 1024 / 1024).toFixed(2)),
              mem_pct: Number(memPct.toFixed(2)),
              net_rx_bytes: net.rx,
              net_tx_bytes: net.tx,
              block_read_bytes: block.read,
              block_write_bytes: block.write,
            };
          })
        );

        const totalMemBytes = statsRows.reduce((sum, row) => sum + row.mem_usage_mb * 1024 * 1024, 0);
        const totalMemLimitBytes = statsRows.reduce((sum, row) => sum + row.mem_limit_mb * 1024 * 1024, 0);
        const summary = {
          total_cpu_pct: Number(statsRows.reduce((sum, row) => sum + row.cpu_pct, 0).toFixed(2)),
          total_mem_mb: Number((totalMemBytes / 1024 / 1024).toFixed(2)),
          total_mem_pct: totalMemLimitBytes > 0 ? Number(((totalMemBytes / totalMemLimitBytes) * 100).toFixed(2)) : 0,
          containers: statsRows,
        };

        if (format === "json") return jsonTextResult(summary);

        const header = `${padRight("Name", 24)} ${padLeft("CPU%", 7)} ${padLeft("Mem Usage", 12)} ${padLeft("Mem%", 7)} ${padLeft("Net I/O", 21)} ${padLeft("Block I/O", 21)}`;
        const lines = [
          "Docker Stats",
          "═══════════════════════════════════════",
          "",
          `Summary: CPU ${summary.total_cpu_pct.toFixed(2)}%  Memory ${summary.total_mem_mb.toFixed(1)} MB  (${summary.total_mem_pct.toFixed(2)}%)`,
          "",
          header,
          "─".repeat(header.length),
        ];

        for (const row of statsRows) {
          lines.push(
            `${padRight(row.name, 24)} ${padLeft(row.cpu_pct.toFixed(2), 7)} ${padLeft(`${row.mem_usage_mb.toFixed(1)} MB`, 12)} ${padLeft(`${row.mem_pct.toFixed(2)}%`, 7)} ${padLeft(`${humanBytesFromBytes(row.net_rx_bytes)} / ${humanBytesFromBytes(row.net_tx_bytes)}`, 21)} ${padLeft(`${humanBytesFromBytes(row.block_read_bytes)} / ${humanBytesFromBytes(row.block_write_bytes)}`, 21)}`
          );
        }
        if (statsRows.length === 0) lines.push("No running containers.");
        return textResult(lines.join("\n"));
      } catch (err) {
        return errorResult(`Docker error: ${err.message}`);
      }
    }
  );

  server.tool(
    "prune_system",
    "Show or perform Docker system prune summaries",
    {
      dry_run: z.boolean().default(true).describe("Preview reclaimable space without deleting data"),
      format: FORMAT_PARAM,
    },
    async ({ dry_run, format }) => {
      try {
        let result;

        if (dry_run) {
          const [imagesRaw, containersRaw, volumesRaw] = await Promise.all([
            dockerApi("GET", "/images/json?all=true"),
            dockerApi("GET", "/containers/json?all=true"),
            dockerApi("GET", "/volumes"),
          ]);

          const images = Array.isArray(imagesRaw) ? imagesRaw : [];
          const containers = Array.isArray(containersRaw) ? containersRaw : [];
          const volumes = Array.isArray(volumesRaw?.Volumes) ? volumesRaw.Volumes : [];

          const reclaimableImages = images.filter((image) => Number(image.Containers || 0) === 0);
          const reclaimableContainers = containers.filter((container) => container.State !== "running");
          const reclaimableVolumes = volumes.filter((volume) => Number(volume?.UsageData?.RefCount || 0) === 0);

          result = {
            images: {
              reclaimable_bytes: reclaimableImages.reduce((sum, image) => sum + Number(image.Size || 0), 0),
              count: reclaimableImages.length,
            },
            containers: {
              reclaimable_bytes: reclaimableContainers.reduce((sum, container) => sum + Number(container.SizeRw || 0), 0),
              count: reclaimableContainers.length,
            },
            volumes: {
              reclaimable_bytes: reclaimableVolumes.reduce((sum, volume) => sum + Number(volume?.UsageData?.Size || 0), 0),
              count: reclaimableVolumes.length,
            },
            build_cache: {
              reclaimable_bytes: 0,
            },
          };
        } else {
          const [imagesResp, containersResp, volumesResp, buildResp] = await Promise.all([
            dockerApiPost("/images/prune?all=true"),
            dockerApiPost("/containers/prune"),
            dockerApiPost("/volumes/prune"),
            dockerApiPost("/build/prune?all=true"),
          ]);

          const imagesData = parsePruneBody(imagesResp.body);
          const containersData = parsePruneBody(containersResp.body);
          const volumesData = parsePruneBody(volumesResp.body);
          const buildData = parsePruneBody(buildResp.body);

          result = {
            images: {
              reclaimable_bytes: Number(imagesData.SpaceReclaimed || 0),
              count: countPruneObjects(imagesData),
            },
            containers: {
              reclaimable_bytes: Number(containersData.SpaceReclaimed || 0),
              count: countPruneObjects(containersData),
            },
            volumes: {
              reclaimable_bytes: Number(volumesData.SpaceReclaimed || 0),
              count: countPruneObjects(volumesData),
            },
            build_cache: {
              reclaimable_bytes: Number(buildData.SpaceReclaimed || 0),
            },
          };
        }

        if (format === "json") return jsonTextResult(result);

        const rows = [
          ["images", result.images.reclaimable_bytes, result.images.count],
          ["containers", result.containers.reclaimable_bytes, result.containers.count],
          ["volumes", result.volumes.reclaimable_bytes, result.volumes.count],
          ["build_cache", result.build_cache.reclaimable_bytes, 0],
        ];
        const header = `${padRight("Category", 14)} ${padLeft("Space Reclaimable", 20)} ${padLeft("Objects", 8)}`;
        const lines = ["Docker Prune Summary", "═══════════════════════════════════════", "", header, "─".repeat(header.length)];
        for (const [category, bytes, count] of rows) {
          lines.push(`${padRight(category, 14)} ${padLeft(humanBytesFromBytes(bytes), 20)} ${padLeft(count, 8)}`);
        }
        lines.push("", dry_run ? "Dry run only — nothing removed." : "Prune completed.");
        return textResult(lines.join("\n"));
      } catch (err) {
        return errorResult(`Docker error: ${err.message}`);
      }
    }
  );
}
