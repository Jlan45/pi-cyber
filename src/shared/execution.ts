import { createHash, createHmac } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { getAgentDir, type BashOperations } from "@earendil-works/pi-coding-agent";
import { Client, type ConnectConfig } from "ssh2";
import { normalizeInputPath, quoteShellPath } from "./workspace.ts";

export type ExecutionEnvType = "local" | "ssh";

/** SSH authentication options (key / agent; password optional but not recommended). */
export interface SshAuthConfig {
  /** `key` = identity file; `agent` = ssh-agent; `password` = sshpass-style (discouraged). */
  method?: "key" | "agent" | "password";
  /** Username when `target` is host-only. */
  user?: string;
  /** Private key path (supports `~`). */
  identityFile?: string;
  /** Passphrase for an encrypted key (stored in plaintext — avoid when possible). */
  passphrase?: string;
  /** Account password when method=password (stored in plaintext — avoid when possible). */
  password?: string;
}

export interface LocalExecutionEnv {
  name: string;
  type: "local";
  description?: string;
}

export interface SshExecutionEnv {
  name: string;
  type: "ssh";
  description?: string;
  /** Host or `user@host`. */
  target: string;
  port?: number;
  remoteCwd?: string;
  auth?: SshAuthConfig;
  /**
   * Host key policy. `accept-new` (default): trust a host on first contact, then pin it; a changed key
   * is refused. `strict`: only hosts already in known_hosts. `off`: no verification (not recommended).
   */
  hostKeyCheck?: "strict" | "accept-new" | "off";
}

export type ExecutionEnvironment = LocalExecutionEnv | SshExecutionEnv;

/** On-disk shape for global / workspace execution files. */
export interface ExecutionConfigFile {
  /** Active environment `name`. */
  active?: string | null;
  environments: ExecutionEnvironment[];
}

export interface ResolvedExecution {
  /** Set when an execution file exists but cannot be read. Shell commands must be refused, not run locally. */
  error?: string;
  active: string;
  env: ExecutionEnvironment;
  /** Merged catalogue (workspace entries override global by name). */
  environments: ExecutionEnvironment[];
  source: "workspace" | "global" | "default";
}

const LOCAL_ENV: LocalExecutionEnv = { name: "local", type: "local", description: "本机执行" };

export function getGlobalExecutionPath(): string {
  return join(getAgentDir(), "pi-cyber", "execution.json");
}

export function getWorkspaceExecutionPath(workspaceDir: string): string {
  return join(workspaceDir, ".cyber", "execution.json");
}

export function defaultExecutionFile(): ExecutionConfigFile {
  return {
    active: "local",
    environments: [{ ...LOCAL_ENV }],
  };
}

function readJsonFile(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} 不是有效的 JSON: ${message}`);
  }
}

/**
 * Normalize one environment entry. Throws on invalid SSH entries.
 */
export function normalizeEnvironment(raw: unknown): ExecutionEnvironment {
  if (!raw || typeof raw !== "object") {
    throw new Error("执行环境必须是对象");
  }
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) throw new Error("执行环境缺少 name");

  const type = obj.type === "ssh" ? "ssh" : obj.type === "local" ? "local" : null;
  if (!type) throw new Error(`执行环境 "${name}" 的 type 必须是 local 或 ssh`);

  const description =
    typeof obj.description === "string" && obj.description.trim()
      ? obj.description.trim()
      : undefined;

  if (type === "local") {
    return { name, type: "local", description };
  }

  const target = typeof obj.target === "string" ? obj.target.trim() : "";
  if (!target) throw new Error(`SSH 环境 "${name}" 缺少 target`);

  const env: SshExecutionEnv = { name, type: "ssh", target, description };

  if (typeof obj.port === "number" && Number.isFinite(obj.port) && obj.port > 0) {
    env.port = Math.floor(obj.port);
  }
  if (typeof obj.remoteCwd === "string" && obj.remoteCwd.trim()) {
    env.remoteCwd = obj.remoteCwd.trim();
  }
  if (obj.hostKeyCheck === "strict" || obj.hostKeyCheck === "accept-new" || obj.hostKeyCheck === "off") {
    env.hostKeyCheck = obj.hostKeyCheck;
  }

  const authRaw = obj.auth;
  if (authRaw && typeof authRaw === "object") {
    const a = authRaw as Record<string, unknown>;
    const auth: SshAuthConfig = {};
    if (a.method === "key" || a.method === "agent" || a.method === "password") {
      auth.method = a.method;
    }
    if (typeof a.user === "string" && a.user.trim()) auth.user = a.user.trim();
    if (typeof a.identityFile === "string" && a.identityFile.trim()) {
      auth.identityFile = a.identityFile.trim();
    }
    if (typeof a.passphrase === "string" && a.passphrase) auth.passphrase = a.passphrase;
    if (typeof a.password === "string" && a.password) auth.password = a.password;
    if (Object.keys(auth).length > 0) env.auth = auth;
  }

  // Legacy flat identityFile on the env object
  if (!env.auth?.identityFile && typeof obj.identityFile === "string" && obj.identityFile.trim()) {
    env.auth = { ...(env.auth ?? {}), method: env.auth?.method ?? "key", identityFile: obj.identityFile.trim() };
  }

  return env;
}

/**
 * Accepts new list format or legacy `{ backend, ssh }` and returns a normalized file.
 */
export function normalizeExecutionFile(raw: unknown): ExecutionConfigFile {
  if (!raw || typeof raw !== "object") return defaultExecutionFile();
  const obj = raw as Record<string, unknown>;

  // Legacy single-backend format
  if ("backend" in obj && !("environments" in obj)) {
    const backend = obj.backend === "ssh" ? "ssh" : "local";
    if (backend === "local") return defaultExecutionFile();
    const ssh = (obj.ssh ?? {}) as Record<string, unknown>;
    const migrated = normalizeEnvironment({
      name: "ssh-default",
      type: "ssh",
      target: ssh.target,
      port: ssh.port,
      remoteCwd: ssh.remoteCwd,
      identityFile: ssh.identityFile,
      extraArgs: ssh.extraArgs,
      auth: {
        method: "key",
        identityFile: typeof ssh.identityFile === "string" ? ssh.identityFile : undefined,
      },
    });
    return {
      active: migrated.name,
      environments: [{ ...LOCAL_ENV }, migrated],
    };
  }

  const listRaw = Array.isArray(obj.environments) ? obj.environments : [];
  const environments: ExecutionEnvironment[] = [];
  const seen = new Set<string>();
  for (const item of listRaw) {
    const env = normalizeEnvironment(item);
    if (seen.has(env.name)) {
      throw new Error(`执行环境 name 重复: ${env.name}`);
    }
    seen.add(env.name);
    environments.push(env);
  }

  if (!environments.some((e) => e.type === "local" && e.name === "local")) {
    environments.unshift({ ...LOCAL_ENV });
  }
  if (environments.length === 0) {
    environments.push({ ...LOCAL_ENV });
  }

  let active =
    typeof obj.active === "string" && obj.active.trim() ? obj.active.trim() : null;
  if (active && !environments.some((e) => e.name === active)) {
    active = environments[0]!.name;
  }
  if (!active) active = environments.find((e) => e.type === "local")?.name ?? environments[0]!.name;

  return { active, environments };
}

/**
 * Reads an execution file. Returns null only when the file does not exist.
 * Throws when it exists but is invalid, so a typo can never silently turn into "run locally"
 * (or get overwritten by a default file).
 */
export function readExecutionFile(path: string): ExecutionConfigFile | null {
  const raw = readJsonFile(path);
  if (raw === null) return null;
  try {
    return normalizeExecutionFile(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} 配置无效: ${message}`);
  }
}

/** Execution files may hold passwords or passphrases: keep them private to the user. */
export function writeExecutionFile(path: string, config: ExecutionConfigFile): void {
  const normalized = normalizeExecutionFile(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort (e.g. Windows)
  }
}

function mergeEnvironments(
  globalEnvs: ExecutionEnvironment[],
  workspaceEnvs: ExecutionEnvironment[],
): ExecutionEnvironment[] {
  const map = new Map<string, ExecutionEnvironment>();
  for (const env of globalEnvs) map.set(env.name, env);
  for (const env of workspaceEnvs) map.set(env.name, env); // workspace wins
  const merged = [...map.values()];
  if (!merged.some((e) => e.name === "local" && e.type === "local")) {
    merged.unshift({ ...LOCAL_ENV });
  }
  return merged;
}

/**
 * Resolve effective execution: global defaults, workspace overrides by name, workspace `active` wins.
 */
export function resolveExecution(workspaceDir?: string | null): ResolvedExecution {
  let error: string | undefined;
  const tryRead = (path: string): ExecutionConfigFile | null => {
    try {
      return readExecutionFile(path);
    } catch (err) {
      error = [error, err instanceof Error ? err.message : String(err)].filter(Boolean).join("；");
      return null;
    }
  };
  const globalFile = tryRead(getGlobalExecutionPath()) ?? defaultExecutionFile();
  const workspaceFile = workspaceDir ? tryRead(getWorkspaceExecutionPath(workspaceDir)) : null;

  const environments = mergeEnvironments(
    globalFile.environments,
    workspaceFile?.environments ?? [],
  );

  const activeName =
    (workspaceFile && workspaceFile.active !== undefined && workspaceFile.active !== null
      ? workspaceFile.active
      : globalFile.active) ?? "local";

  const env = environments.find((e) => e.name === activeName) ?? environments.find((e) => e.type === "local") ?? LOCAL_ENV;

  let source: ResolvedExecution["source"] = "default";
  if (workspaceFile?.active === env.name || workspaceFile?.environments.some((e) => e.name === env.name)) {
    source = "workspace";
  } else if (globalFile.environments.some((e) => e.name === env.name) || globalFile.active === env.name) {
    source = "global";
  }

  return { active: env.name, env, environments, source, ...(error ? { error } : {}) };
}

const REMOTE_EXEC_ACTIVE_KEY = "__piCyberRemoteExecActive";

/** Tracks whether the active pentest runtime routes bash over SSH (shared across extension modules). */
export function setRemoteExecutionActive(active: boolean): void {
  (globalThis as Record<string, unknown>)[REMOTE_EXEC_ACTIVE_KEY] = active;
}

export function isRemoteExecutionActive(): boolean {
  return (globalThis as Record<string, unknown>)[REMOTE_EXEC_ACTIVE_KEY] === true;
}

export function isSshEnvironment(env: ExecutionEnvironment): env is SshExecutionEnv {
  return env.type === "ssh";
}

export function formatEnvironmentSummary(env: ExecutionEnvironment): string {
  if (env.type === "local") return `${env.name} (local)`;
  const auth = env.auth?.method ? ` auth=${env.auth.method}` : "";
  const user = env.auth?.user ? `${env.auth.user}@` : "";
  const target = env.target.includes("@") ? env.target : `${user}${env.target}`;
  const port = env.port && env.port !== 22 ? `:${env.port}` : "";
  const cwd = env.remoteCwd ? ` cwd=${env.remoteCwd}` : "";
  return `${env.name} (ssh ${target}${port}${cwd}${auth})`;
}

export function formatExecutionSummary(resolved: ResolvedExecution): string {
  return `${formatEnvironmentSummary(resolved.env)} [${resolved.source}]`;
}

export function formatExecutionPromptSection(resolved: ResolvedExecution): string {
  const lines: string[] = [];

  if (resolved.error) {
    lines.push(
      "【阻断】执行环境配置无效，bash 工具和用户 `!` 命令已被禁用，不会回退到本机。",
      `原因: ${resolved.error}`,
      "请让用户修正该文件（或用 /runtime 重新配置）后再继续，不要尝试绕过。",
    );
    return lines.join("\n");
  }

  if (isSshEnvironment(resolved.env)) {
    const user = resolved.env.auth?.user?.trim();
    const host = resolved.env.target.includes("@")
      ? resolved.env.target
      : user
        ? `${user}@${resolved.env.target}`
        : resolved.env.target;
    const port = resolved.env.port && resolved.env.port !== 22 ? `:${resolved.env.port}` : "";
    const cwd = resolved.env.remoteCwd ? `，远程工作目录 ${resolved.env.remoteCwd}` : "";
    lines.push(
      "【强制】当前 Runtime = 远程 SSH，不是本机。",
      `所有 bash 工具调用与用户 \`!\` / \`!!\` 命令一律在远程主机 ${host}${port} 上执行${cwd}（来源: ${resolved.source}，环境名: ${resolved.env.name}）。`,
      "禁止假设命令在本机运行；本机路径、本机 localhost、本机进程与本机网络均不适用。",
      "read / write / edit / MCP 仍在本机；只有 shell 命令通道走远程。",
      "远程命令写出的文件（nmap -oA、截图、抓包等）在远端磁盘上，本机 read 看不到。需要留证时调用 `pentest_fetch` 把远端文件或目录拉回本机 evidence/，再 read。",
      "远程连接经 ssh2 复用，空闲约 5 分钟断开。",
    );
  } else {
    lines.push(
      "【强制】当前 Runtime = 本机 local。",
      `所有 bash 工具调用与用户 \`!\` / \`!!\` 命令在本机执行（来源: ${resolved.source}，环境名: ${resolved.env.name}）。`,
    );
  }

  lines.push(
    `当前执行环境摘要: ${formatEnvironmentSummary(resolved.env)}`,
    "可用环境:",
    ...resolved.environments.map(
      (e) => `  - ${formatEnvironmentSummary(e)}${e.name === resolved.active ? " ← active" : ""}`,
    ),
    "切换: /runtime（选择器）| use <name> | local | 新增 SSH 等。切到远程后本段声明必须以远程为准。",
  );

  return lines.join("\n");
}

export function resolveIdentityFile(identityFile: string, baseCwd: string): string {
  return normalizeInputPath(identityFile, baseCwd);
}

function parseSshHostUser(env: SshExecutionEnv): { host: string; username: string } {
  let host = env.target.trim();
  let username = env.auth?.user?.trim() || process.env.USER || "root";
  if (host.includes("@")) {
    const idx = host.lastIndexOf("@");
    const maybeUser = host.slice(0, idx).trim();
    host = host.slice(idx + 1).trim();
    if (maybeUser) username = maybeUser;
  }
  return { host, username };
}

// ---------------------------------------------------------------------------
// Host key verification
// ---------------------------------------------------------------------------

function pinnedHostsPath(): string {
  return join(getAgentDir(), "pi-cyber", "known_hosts");
}

function knownHostsFiles(): string[] {
  return [join(homedir(), ".ssh", "known_hosts"), pinnedHostsPath()];
}

function hostLabel(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function hostFieldMatches(field: string, label: string): boolean {
  for (const entry of field.split(",")) {
    if (entry.startsWith("|1|")) {
      const [, , salt, hash] = entry.split("|");
      if (!salt || !hash) continue;
      const digest = createHmac("sha1", Buffer.from(salt, "base64")).update(label).digest("base64");
      if (digest === hash) return true;
    } else if (entry === label) {
      return true;
    }
  }
  return false;
}

function keyTypeOf(key: Buffer): string {
  try {
    const len = key.readUInt32BE(0);
    return key.subarray(4, 4 + len).toString("utf8");
  } catch {
    return "";
  }
}

type KnownHostResult = "match" | "mismatch" | "unknown";

/** `mismatch` only when the host is pinned with the same key type but a different key. */
function lookupKnownHost(host: string, port: number, key: Buffer): KnownHostResult {
  const label = hostLabel(host, port);
  const type = keyTypeOf(key);
  const b64 = key.toString("base64");
  let mismatch = false;
  for (const file of knownHostsFiles()) {
    if (!existsSync(file)) continue;
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("@")) continue;
      const [hosts, entryType, entryKey] = trimmed.split(/\s+/);
      if (!hosts || !entryType || !entryKey) continue;
      if (!hostFieldMatches(hosts, label)) continue;
      if (entryType !== type) continue;
      if (entryKey === b64) return "match";
      mismatch = true;
    }
  }
  return mismatch ? "mismatch" : "unknown";
}

function pinHost(host: string, port: number, key: Buffer): void {
  const file = pinnedHostsPath();
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${hostLabel(host, port)} ${keyTypeOf(key)} ${key.toString("base64")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

interface ConnectState {
  hostKeyError?: string;
}

function buildConnectConfig(
  env: SshExecutionEnv,
  localCwd: string,
  state: ConnectState,
): ConnectConfig {
  const { host, username } = parseSshHostUser(env);
  const auth = env.auth;
  const method = auth?.method ?? (auth?.identityFile ? "key" : "agent");
  const port = env.port && env.port > 0 ? env.port : 22;
  const config: ConnectConfig = {
    host,
    port,
    username,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
  };

  const policy = env.hostKeyCheck ?? "accept-new";
  if (policy !== "off") {
    config.hostVerifier = (key: Buffer) => {
      const result = lookupKnownHost(host, port, key);
      if (result === "match") return true;
      const fingerprint = fingerprintOf(key);
      if (result === "mismatch") {
        state.hostKeyError =
          `主机 ${hostLabel(host, port)} 的密钥与已记录的不一致（${fingerprint}），可能被中间人劫持。` +
          `确认该主机确实重装过后，再从 ~/.ssh/known_hosts 或 ${pinnedHostsPath()} 删除旧记录。`;
        return false;
      }
      if (policy === "strict") {
        state.hostKeyError =
          `主机 ${hostLabel(host, port)} 不在 known_hosts 中（${fingerprint}）。` +
          `先用 ssh 连一次确认指纹，或把该环境的 hostKeyCheck 改成 accept-new。`;
        return false;
      }
      try {
        pinHost(host, port, key);
      } catch {
        // pinning is best effort; the connection itself is still allowed under accept-new
      }
      return true;
    };
  }

  if (method === "password") {
    if (!auth?.password) throw new Error(`SSH 环境 "${env.name}" 缺少 password`);
    config.password = auth.password;
  } else if (method === "key" || auth?.identityFile) {
    if (!auth?.identityFile) throw new Error(`SSH 环境 "${env.name}" 缺少 identityFile`);
    const keyPath = resolveIdentityFile(auth.identityFile, localCwd);
    config.privateKey = readFileSync(keyPath);
    if (auth.passphrase) config.passphrase = auth.passphrase;
  } else {
    const sock = process.env.SSH_AUTH_SOCK;
    if (!sock) {
      throw new Error(`SSH 环境 "${env.name}" 使用 agent 认证，但未设置 SSH_AUTH_SOCK`);
    }
    config.agent = sock;
  }

  return config;
}

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------

const SSH_IDLE_MS = 5 * 60 * 1000;

interface PooledSshClient {
  key: string;
  client: Client;
  ready: Promise<Client>;
  /** Commands / transfers currently using this connection. It is never idle-closed while busy. */
  active: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const sshPool = new Map<string, PooledSshClient>();

function poolKey(env: SshExecutionEnv): string {
  const { host, username } = parseSshHostUser(env);
  const auth = env.auth;
  const method = auth?.method ?? (auth?.identityFile ? "key" : "agent");
  const secret =
    method === "password"
      ? `pw:${auth?.password ?? ""}`
      : method === "key"
        ? `key:${auth?.identityFile ?? ""}:${auth?.passphrase ?? ""}`
        : "agent";
  return `${env.name}|${username}@${host}:${env.port ?? 22}|${method}|${env.hostKeyCheck ?? ""}|${secret}`;
}

function clearIdleTimer(entry: PooledSshClient): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
}

function scheduleIdleClose(entry: PooledSshClient): void {
  clearIdleTimer(entry);
  if (entry.active > 0) return;
  entry.idleTimer = setTimeout(() => {
    if (entry.active > 0) return;
    if (sshPool.get(entry.key) === entry) sshPool.delete(entry.key);
    try {
      entry.client.end();
    } catch {
      // ignore
    }
  }, SSH_IDLE_MS);
  entry.idleTimer.unref?.();
}

function dropPoolEntry(entry: PooledSshClient): void {
  clearIdleTimer(entry);
  if (sshPool.get(entry.key) === entry) sshPool.delete(entry.key);
}

/** Close all pooled SSH connections (e.g. on runtime switch / mode exit). */
export function closeAllSshConnections(): void {
  for (const entry of [...sshPool.values()]) {
    dropPoolEntry(entry);
    try {
      entry.client.end();
    } catch {
      // ignore
    }
  }
  sshPool.clear();
}

async function acquireSshEntry(env: SshExecutionEnv, localCwd: string): Promise<PooledSshClient> {
  const key = poolKey(env);
  const existing = sshPool.get(key);
  if (existing) {
    clearIdleTimer(existing);
    try {
      await existing.ready;
      return existing;
    } catch {
      dropPoolEntry(existing);
    }
  }

  const client = new Client();
  const entry: PooledSshClient = {
    key,
    client,
    ready: Promise.resolve(client),
    active: 0,
  };
  const state: ConnectState = {};

  entry.ready = new Promise<Client>((resolvePromise, reject) => {
    const onReady = () => {
      client.off("error", onConnectError);
      resolvePromise(client);
    };
    const onConnectError = (err: Error) => {
      client.off("ready", onReady);
      dropPoolEntry(entry);
      reject(state.hostKeyError ? new Error(state.hostKeyError) : err);
    };
    client.once("ready", onReady);
    client.once("error", onConnectError);
    client.on("close", () => dropPoolEntry(entry));
    client.on("end", () => dropPoolEntry(entry));
    try {
      client.connect(buildConnectConfig(env, localCwd, state));
    } catch (err) {
      dropPoolEntry(entry);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  sshPool.set(key, entry);
  await entry.ready;
  return entry;
}

/** Run `fn` on a pooled connection and keep it from idle-closing while `fn` runs. */
async function withSshClient<T>(
  env: SshExecutionEnv,
  localCwd: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const entry = await acquireSshEntry(env, localCwd);
  entry.active += 1;
  clearIdleTimer(entry);
  try {
    return await fn(entry.client);
  } finally {
    entry.active -= 1;
    if (entry.active === 0 && sshPool.get(entry.key) === entry) scheduleIdleClose(entry);
  }
}

function discardPooled(env: SshExecutionEnv): void {
  const stale = sshPool.get(poolKey(env));
  if (!stale) return;
  dropPoolEntry(stale);
  try {
    stale.client.end();
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Remote commands
// ---------------------------------------------------------------------------

/** Quote a remote path for sh, keeping a leading `~` working. */
export function quoteRemotePath(value: string): string {
  if (value === "~") return `"$HOME"`;
  if (value.startsWith("~/")) return `"$HOME"/${quoteShellPath(value.slice(2))}`;
  return quoteShellPath(value);
}

export function stripLeadingLocalCd(command: string, localDirs: string[]): string {
  const match = command.match(/^cd\s+(?:'([^']+)'|"([^"]+)"|([^\s&|;]+))\s*&&\s*([\s\S]+)$/);
  if (!match) return command;
  const dir = match[1] ?? match[2] ?? match[3] ?? "";
  const rest = match[4] ?? command;
  let resolvedDir: string;
  try {
    resolvedDir = resolve(normalizeInputPath(dir, process.cwd()));
  } catch {
    return command;
  }
  const known = new Set(localDirs.map((d) => resolve(d)));
  if (known.has(resolvedDir)) return rest;
  return command;
}

/** The channel could not be opened, so the command never started and a retry is safe. */
class SshSetupError extends Error {
  constructor(cause: Error) {
    super(cause.message);
    this.name = "SshSetupError";
  }
}

function execOnClient(
  client: Client,
  remoteBody: string,
  options: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
  },
): Promise<{ exitCode: number | null }> {
  const { onData, signal, timeout } = options;
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    client.exec(remoteBody, (err, stream) => {
      if (err) {
        reject(new SshSetupError(err));
        return;
      }

      let timedOut = false;
      let settled = false;

      /** Ask the remote process to stop (OpenSSH 7.9+), then drop the channel. */
      const terminate = () => {
        try {
          stream.signal("TERM");
        } catch {
          // server may not support signals
        }
        stream.close();
      };

      const timer =
        timeout !== undefined
          ? setTimeout(() => {
              timedOut = true;
              terminate();
            }, timeout * 1000)
          : undefined;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };

      const onAbort = () => {
        terminate();
        finish(() => reject(new Error("aborted")));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      stream.on("data", onData);
      stream.stderr.on("data", onData);
      stream.on("close", (code: number | null) => {
        if (signal?.aborted) {
          finish(() => reject(new Error("aborted")));
        } else if (timedOut) {
          finish(() => reject(new Error(`timeout:${timeout}`)));
        } else {
          finish(() => resolvePromise({ exitCode: code }));
        }
      });
      stream.on("error", (streamErr: Error) => {
        finish(() => reject(streamErr));
      });
    });
  });
}

/**
 * BashOperations backed by ssh2 with connection reuse (one Client per env, idle close 5m).
 * A command is retried only when its channel could not be opened; once it started it never runs twice.
 */
export function createSshBashOperations(
  env: SshExecutionEnv,
  options?: {
    localWorkspaceDirs?: string[];
    localCwd?: string;
  },
): BashOperations {
  const localDirs = options?.localWorkspaceDirs ?? [];
  const localCwd = options?.localCwd ?? process.cwd();

  return {
    exec: async (command, _cwd, execOptions) => {
      const stripped = stripLeadingLocalCd(command, localDirs);
      const remoteBody = env.remoteCwd
        ? `cd ${quoteRemotePath(env.remoteCwd)} && ${stripped}`
        : stripped;

      const attempt = () =>
        withSshClient(env, localCwd, (client) => execOnClient(client, remoteBody, execOptions));

      try {
        return await attempt();
      } catch (err) {
        if (!(err instanceof SshSetupError)) throw err;
        discardPooled(env);
        return await attempt();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Fetching remote artifacts (SFTP)
// ---------------------------------------------------------------------------

export interface FetchResult {
  files: number;
  bytes: number;
  localPath: string;
}

const FETCH_MAX_FILES = 5000;
const FETCH_MAX_BYTES = 1024 * 1024 * 1024;

function sftpCall<T>(
  fn: (done: (err: Error | null | undefined, value?: T) => void) => void,
): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    fn((err, value) => (err ? reject(err) : resolvePromise(value as T)));
  });
}

/**
 * Copy a remote file or directory to `localDest` over SFTP. Relative remote paths resolve against the
 * environment's `remoteCwd` (or the login directory). Symlinks are skipped; names sent by the server
 * are validated so they cannot escape `localDest`.
 */
export async function fetchRemotePath(
  env: SshExecutionEnv,
  remotePath: string,
  localDest: string,
  options?: { localCwd?: string; signal?: AbortSignal },
): Promise<FetchResult> {
  const localCwd = options?.localCwd ?? process.cwd();
  return withSshClient(env, localCwd, async (client) => {
    const sftp = await sftpCall<import("ssh2").SFTPWrapper>((done) => client.sftp(done));
    try {
      const home = await sftpCall<string>((done) => sftp.realpath(".", done));
      const expand = (p: string) =>
        p === "~" ? home : p.startsWith("~/") ? posix.join(home, p.slice(2)) : p;
      const base = expand(env.remoteCwd ?? home);
      const start = posix.isAbsolute(expand(remotePath))
        ? posix.normalize(expand(remotePath))
        : posix.join(base, expand(remotePath));

      let files = 0;
      let bytes = 0;
      const checkLimits = (size: number) => {
        files += 1;
        bytes += size;
        if (files > FETCH_MAX_FILES) throw new Error(`文件数超过上限 ${FETCH_MAX_FILES}，请缩小范围或先在远端打包`);
        if (bytes > FETCH_MAX_BYTES) throw new Error("总大小超过 1 GiB，请缩小范围或先在远端打包");
      };

      const copyFile = async (remote: string, local: string, size: number) => {
        if (options?.signal?.aborted) throw new Error("aborted");
        checkLimits(size);
        mkdirSync(dirname(local), { recursive: true });
        await sftpCall<void>((done) => sftp.fastGet(remote, local, (err) => done(err)));
      };

      const copyDir = async (remote: string, local: string): Promise<void> => {
        mkdirSync(local, { recursive: true });
        const entries = await sftpCall<import("ssh2").FileEntryWithStats[]>((done) =>
          sftp.readdir(remote, done),
        );
        for (const entry of entries) {
          const name = entry.filename;
          if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) continue;
          if (entry.attrs.isSymbolicLink()) continue;
          const remoteChild = posix.join(remote, name);
          const localChild = join(local, name);
          if (entry.attrs.isDirectory()) await copyDir(remoteChild, localChild);
          else if (entry.attrs.isFile()) await copyFile(remoteChild, localChild, entry.attrs.size);
        }
      };

      const stats = await sftpCall<import("ssh2").Stats>((done) => sftp.stat(start, done));
      if (stats.isDirectory()) await copyDir(start, localDest);
      else await copyFile(start, localDest, stats.size);
      return { files, bytes, localPath: localDest };
    } finally {
      try {
        sftp.end();
      } catch {
        // ignore
      }
    }
  });
}

/** Upsert an environment into a config file and optionally set it active. */
export function upsertEnvironment(
  file: ExecutionConfigFile,
  env: ExecutionEnvironment,
  options?: { activate?: boolean },
): ExecutionConfigFile {
  const environments = file.environments.filter((e) => e.name !== env.name);
  environments.push(env);
  if (!environments.some((e) => e.name === "local" && e.type === "local")) {
    environments.unshift({ ...LOCAL_ENV });
  }
  const active = options?.activate === false ? file.active : env.name;
  return normalizeExecutionFile({ active, environments });
}

export function setActiveEnvironment(
  file: ExecutionConfigFile,
  name: string,
): ExecutionConfigFile {
  if (!file.environments.some((e) => e.name === name)) {
    throw new Error(`未知执行环境: ${name}`);
  }
  return normalizeExecutionFile({ ...file, active: name });
}
