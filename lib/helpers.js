import { readFile } from "fs/promises";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);

export const DOCKER_SOCKET = process.env.DOCKER_HOST || "/var/run/docker.sock";
export const DOCKER_API = "v1.43";

export const TIMEOUT_SYSTEM = 10_000;
export const TIMEOUT_DOCKER = 15_000;
export const TIMEOUT_LOGS = 30_000;

export let dockerDownSince = 0;
export const DOCKER_CACHE_TTL = 30_000;

export function markDockerDown() {
  dockerDownSince = Date.now();
}

export function markDockerUp() {
  dockerDownSince = 0;
}

export function assertDockerMaybeUp() {
  if (dockerDownSince > 0 && Date.now() - dockerDownSince < DOCKER_CACHE_TTL) {
    throw new Error(
      `Docker socket not available at ${DOCKER_SOCKET} (cached — last checked ${Math.round((Date.now() - dockerDownSince) / 1000)}s ago). Is Docker running?`
    );
  }
}

export function humanBytes(kb) {
  const n = Number(kb);
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} GB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} MB`;
  return `${n} KB`;
}

export function humanUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

export function padRight(s, n) {
  return String(s).padEnd(n);
}

export function padLeft(s, n) {
  return String(s).padStart(n);
}

export function textResult(text) {
  return { content: [{ type: "text", text }] };
}

export function jsonTextResult(data) {
  return textResult(JSON.stringify(data, null, 2));
}

export function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

export async function readProc(path) {
  return (await readFile(path, "utf-8")).trim();
}

export async function execWithTimeout(cmd, args, timeoutMs) {
  return execFile(cmd, args, { timeout: timeoutMs });
}

export async function dockerApi(method, path, timeoutMs = TIMEOUT_DOCKER) {
  assertDockerMaybeUp();
  const url = `http://localhost/${DOCKER_API}${path}`;
  const args = ["--unix-socket", DOCKER_SOCKET, "-s", "-X", method, url];
  try {
    const { stdout } = await execWithTimeout("curl", args, timeoutMs);
    markDockerUp();
    return JSON.parse(stdout);
  } catch (err) {
    if (err.code === "ENOENT") throw new Error("curl not found on system");
    try {
      await readFile(DOCKER_SOCKET);
    } catch {
      markDockerDown();
      throw new Error(`Docker socket not found at ${DOCKER_SOCKET}. Is Docker running?`);
    }
    throw err;
  }
}

export async function dockerApiRaw(method, path, timeoutMs = TIMEOUT_DOCKER) {
  assertDockerMaybeUp();
  const url = `http://localhost/${DOCKER_API}${path}`;
  const args = ["--unix-socket", DOCKER_SOCKET, "-s", "-X", method, url];
  try {
    const { stdout } = await execWithTimeout("curl", args, timeoutMs);
    markDockerUp();
    return stdout;
  } catch (err) {
    try {
      await readFile(DOCKER_SOCKET);
    } catch {
      markDockerDown();
      throw new Error(`Docker socket not found at ${DOCKER_SOCKET}. Is Docker running?`);
    }
    throw err;
  }
}

export async function dockerApiPost(path, timeoutMs = TIMEOUT_DOCKER) {
  assertDockerMaybeUp();
  const url = `http://localhost/${DOCKER_API}${path}`;
  const args = [
    "--unix-socket", DOCKER_SOCKET, "-s",
    "-X", "POST",
    "-w", "\n%{http_code}",
    url,
  ];
  try {
    const { stdout } = await execWithTimeout("curl", args, timeoutMs);
    markDockerUp();
    const lines = stdout.trimEnd().split("\n");
    const statusCode = parseInt(lines.pop(), 10);
    const body = lines.join("\n");
    return { statusCode, body };
  } catch (err) {
    try {
      await readFile(DOCKER_SOCKET);
    } catch {
      markDockerDown();
      throw new Error(`Docker socket not found at ${DOCKER_SOCKET}. Is Docker running?`);
    }
    throw err;
  }
}

export function containerSummary(c) {
  const name = (c.Names?.[0] || "").replace(/^\//, "");
  const id = c.Id?.slice(0, 12) || "";
  const image = c.Image || "";
  const state = c.State || "";
  const status = c.Status || "";
  return { id, name, image, state, status };
}

export function containerTable(containers) {
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
