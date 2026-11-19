import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, type BashOperations } from "@earendil-works/pi-coding-agent";
import { Client, type ConnectConfig } from "ssh2";
import { normalizeInputPath } from "./workspace.ts";

export type ExecutionEnvType = "local" | "ssh";

/** SSH authentication options (key / agent; password optional but not recommended). */
export interface SshAuthConfig {
  /** `key` = identity file; `agent` = ssh-agent; `password` = sshpass-style (discouraged). */
  method?: "key" | "agent" | "password";
  /** Username when `target` is host-only. */
  user?: string;
  /** Private key path (supports `~`). */
  identityFile?: string;
  /** Optional certificate for the identity (ssh `-o CertificateFile=`). */
  certificateFile?: string;
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
  /** Extra ssh argv before destination. */
  extraArgs?: string[];
}

export type ExecutionEnvironment = LocalExecutionEnv | SshExecutionEnv;

/** On-disk shape for global / workspace execution files. */
export interface ExecutionConfigFile {
  /** Active environment `name`. */
  active?: string | null;
  environments: ExecutionEnvironment[];
}

export interface ResolvedExecution {
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
  } catch {
    return null;
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
  if (Array.isArray(obj.extraArgs)) {
    env.extraArgs = obj.extraArgs.filter((x): x is string => typeof x === "string");
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
    if (typeof a.certificateFile === "string" && a.certificateFile.trim()) {
      auth.certificateFile = a.certificateFile.trim();
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

export function readExecutionFile(path: string): ExecutionConfigFile | null {
  const raw = readJsonFile(path);
  if (raw === null) return null;
  try {
    return normalizeExecutionFile(raw);
  } catch {
    return null;
  }
}

export function writeExecutionFile(path: string, config: ExecutionConfigFile): void {
  const normalized = normalizeExecutionFile(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
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
  const globalFile = readExecutionFile(getGlobalExecutionPath()) ?? defaultExecutionFile();
  const workspaceFile = workspaceDir ? readExecutionFile(getWorkspaceExecutionPath(workspaceDir)) : null;

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

  return { active: env.name, env, environments, source };
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

function sshDestination(env: SshExecutionEnv): string {
  if (env.target.includes("@")) return env.target;
  const user = env.auth?.user?.trim();
  return user ? `${user}@${env.target}` : env.target;
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

function buildConnectConfig(env: SshExecutionEnv, localCwd: string): ConnectConfig {
  const { host, username } = parseSshHostUser(env);
  const auth = env.auth;
  const method = auth?.method ?? (auth?.identityFile ? "key" : "agent");
  const config: ConnectConfig = {
    host,
    port: env.port && env.port > 0 ? env.port : 22,
    username,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
  };

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

const SSH_IDLE_MS = 5 * 60 * 1000;

interface PooledSshClient {
  key: string;
  client: Client;
  ready: Promise<Client>;
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
  return `${env.name}|${username}@${host}:${env.port ?? 22}|${method}|${secret}`;
}

function clearIdleTimer(entry: PooledSshClient): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
}

function scheduleIdleClose(entry: PooledSshClient): void {
  clearIdleTimer(entry);
  entry.idleTimer = setTimeout(() => {
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

async function acquireSshClient(env: SshExecutionEnv, localCwd: string): Promise<Client> {
  const key = poolKey(env);
  const existing = sshPool.get(key);
  if (existing) {
    clearIdleTimer(existing);
    try {
      return await existing.ready;
    } catch {
      dropPoolEntry(existing);
    }
  }

  const client = new Client();
  const entry: PooledSshClient = {
    key,
    client,
    ready: Promise.resolve(client),
  };

  entry.ready = new Promise<Client>((resolvePromise, reject) => {
    const onReady = () => {
      client.off("error", onConnectError);
      resolvePromise(client);
    };
    const onConnectError = (err: Error) => {
      client.off("ready", onReady);
      dropPoolEntry(entry);
      reject(err);
    };
    client.once("ready", onReady);
    client.once("error", onConnectError);
    client.on("close", () => dropPoolEntry(entry));
    client.on("end", () => dropPoolEntry(entry));
    try {
      client.connect(buildConnectConfig(env, localCwd));
    } catch (err) {
      dropPoolEntry(entry);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  sshPool.set(key, entry);
  return entry.ready;
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
        reject(err);
        return;
      }

      let timedOut = false;
      let settled = false;
      const timer =
        timeout !== undefined
          ? setTimeout(() => {
              timedOut = true;
              stream.close();
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
        stream.close();
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
        ? `cd ${JSON.stringify(env.remoteCwd)} && ${stripped}`
        : stripped;

      const run = async () => {
        const client = await acquireSshClient(env, localCwd);
        const result = await execOnClient(client, remoteBody, execOptions);
        const entry = sshPool.get(poolKey(env));
        if (entry) scheduleIdleClose(entry);
        return result;
      };

      try {
        return await run();
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message === "aborted" || err.message.startsWith("timeout:"))
        ) {
          throw err;
        }
        // Drop broken connection and retry once
        const key = poolKey(env);
        const stale = sshPool.get(key);
        if (stale) {
          dropPoolEntry(stale);
          try {
            stale.client.end();
          } catch {
            // ignore
          }
        }
        return await run();
      }
    },
  };
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
