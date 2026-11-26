import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { getToolPathsFile, resolveToolPaths } from "./tool-paths.ts";

export type CyberToolStatus = "stopped" | "starting" | "running" | "error";
export type CyberToolAction = "status" | "start" | "stop" | "reload";

export interface CyberToolConfig {
  name: string;
  description: string;
  startCommand?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  autoStart?: boolean;
  mcp?: {
    exposure?: "direct" | "codemode" | "deferred" | "hidden";
    toolExposure?: Record<string, "direct" | "codemode" | "deferred" | "hidden">;
    /** Per-request timeout in SECONDS (Pi's `timeout`). */
    timeout?: number;
    /** How long a start may take before it counts as failed, in seconds. Default 180. */
    startupTimeoutSec?: number;
  };
}

interface CyberToolsFile {
  tools?: CyberToolConfig[];
}

export interface CyberToolRuntimeContext {
  cwd: string;
  workspaceDir: string;
  sessionId: string;
  targetPath?: string;
  targetName?: string;
}

const DEFAULT_STARTUP_TIMEOUT_SEC = 180;

interface CyberToolState {
  status: CyberToolStatus;
  toolDir?: string;
  resolvedCommand?: string;
  lastError?: string;
  /** When the current start began (ms since epoch). */
  startedAt?: number;
  /** Identity of the registered config, so a repeated start of the same thing is a no-op. */
  signature?: string;
}

export interface CyberToolStatusInfo {
  name: string;
  description: string;
  startCommand: string;
  status: CyberToolStatus;
  autoStart: boolean;
  mcpRegistered: boolean;
  toolDir?: string;
  lastError?: string;
}

function buildTemplateVars(
  toolName: string,
  runtimeCtx: CyberToolRuntimeContext,
  toolDir: string,
  configDir: string,
): Record<string, string> {
  return {
    cwd: runtimeCtx.cwd,
    workspaceDir: runtimeCtx.workspaceDir,
    sessionId: runtimeCtx.sessionId,
    toolDir,
    configDir,
    targetPath: runtimeCtx.targetPath ?? "",
    targetName: runtimeCtx.targetName ?? "",
    toolName,
  };
}

function expandTemplate(
  template: string,
  vars: Record<string, string>,
  paths: Record<string, string>,
  toolName: string,
  requireTarget: boolean,
): string {
  const withPaths = template.replace(/\$\{path:([A-Za-z0-9_]+)\}/g, (_match, key: string) => {
    const value = paths[key];
    if (!value) {
      throw new Error(
        `工具 "${toolName}" 缺少路径 ${key}。请编辑 ${getToolPathsFile()}`,
      );
    }
    return value;
  });
  return withPaths.replace(
    /\$\{(cwd|workspaceDir|sessionId|toolDir|configDir|targetPath|targetName|toolName)\}/g,
    (_match, key: string) => {
      const val = vars[key];
      if (requireTarget && !val && (key === "targetPath" || key === "targetName")) {
        throw new Error(
          `工具 "${toolName}" 需要使用 \${${key}}，请先将目标登记到工作区 targets/`,
        );
      }
      return val ?? "";
    },
  );
}

/**
 * Splits a command string into `[executable, ...args]`, respecting single and double quotes.
 */
export function parseStartCommand(entry: CyberToolConfig): {
  command: string;
  args: string[];
  displayCommand: string;
} {
  if (entry.command) {
    const args = entry.args ?? [];
    return {
      command: entry.command,
      args,
      displayCommand: [entry.command, ...args].join(" "),
    };
  }

  const raw = (entry.startCommand ?? "").trim();
  if (!raw) {
    throw new Error(`工具 "${entry.name}" 缺少 command 或 startCommand 配置`);
  }

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (quote) {
    throw new Error(`工具 "${entry.name}" 的 startCommand 引号未闭合: ${raw}`);
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    throw new Error(`工具 "${entry.name}" 的 startCommand 为空`);
  }

  return {
    command: tokens[0],
    args: entry.args ?? tokens.slice(1),
    displayCommand: raw,
  };
}

export interface StatusThemeLike {
  fg: (
    color: "success" | "warning" | "error" | "dim" | "muted" | "toolTitle" | "accent",
    text: string,
  ) => string;
}

const STATUS_LIGHT_MAP: Record<
  CyberToolStatus,
  {
    symbol: string;
    lightColor: "success" | "warning" | "error" | "dim";
    nameColor: "toolTitle" | "warning" | "error" | "muted";
  }
> = {
  running: { symbol: "●", lightColor: "success", nameColor: "toolTitle" },
  starting: { symbol: "●", lightColor: "warning", nameColor: "warning" },
  error: { symbol: "●", lightColor: "error", nameColor: "error" },
  stopped: { symbol: "○", lightColor: "dim", nameColor: "muted" },
};

/**
 * Formats MCP tool statuses with colored status lights + tool names for Pi's footer/status UI.
 */
export function formatToolsStatusIndicator(
  items: CyberToolStatusInfo[],
  theme?: StatusThemeLike,
): string | undefined {
  if (items.length === 0) {
    return undefined;
  }

  const paint = (
    color: "success" | "warning" | "error" | "dim" | "muted" | "toolTitle" | "accent",
    text: string,
  ) => (theme ? theme.fg(color, text) : text);

  const badges = items.map((item) => {
    const style = STATUS_LIGHT_MAP[item.status];
    return `${paint(style.lightColor, style.symbol)} ${paint(style.nameColor, item.name)}`;
  });

  return `${paint("muted", "MCP:")} ${badges.join("  ")}`;
}

export function loadCyberToolsConfig(configPath: string): CyberToolConfig[] {
  if (!existsSync(configPath)) {
    return [];
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as CyberToolsFile;
  if (!Array.isArray(parsed.tools)) {
    return [];
  }

  return parsed.tools.filter(
    (item): item is CyberToolConfig =>
      Boolean(item && typeof item.name === "string" && item.name.trim().length > 0),
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("已取消"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One-line result for a start that has finished connecting or failed. */
export function formatStartOutcome(item: CyberToolStatusInfo, toolNames: string[]): string {
  if (item.status === "running") {
    const listed = toolNames.length > 0 ? toolNames.join("、") : "（已连接，但没有列出工具名）";
    return `${item.name} 启动成功。MCP 已连接。可用工具：${listed}`;
  }
  const reason = item.lastError ?? "MCP 没有在时限内连上";
  return `${item.name} 启动失败。${reason}`;
}

export function formatToolsStatusText(items: CyberToolStatusInfo[]): string {
  if (items.length === 0) {
    return "未配置任何工具。";
  }
  return items
    .map((item) => {
      const err = item.lastError ? ` (error: ${item.lastError})` : "";
      return `- ${item.name}: status=${item.status}, mcp=${item.mcpRegistered ? "injected" : "none"}, cmd="${item.startCommand}" — ${item.description}${err}`;
    })
    .join("\n");
}

export interface CyberToolManagerOptions {
  /** Human label used in error / prompt messages, e.g. "逆向" or "渗透". */
  label?: string;
  /** Tool lifecycle command name shown in prompt, e.g. "reverse_tool". */
  toolCommandName?: string;
  /** Relative config path hint shown when empty, e.g. "extensions/reverse/tools.json". */
  configHint?: string;
}

/**
 * Manages normalized tool lifecycles and dynamic MCP server injection via `pi.registerMcpServer`.
 */
export class CyberToolManager {
  private readonly pi: ExtensionAPI;
  private readonly configPath: string;
  private readonly label: string;
  private readonly toolCommandName: string;
  private readonly configHint: string;
  private configs: CyberToolConfig[] = [];
  private readonly states = new Map<string, CyberToolState>();
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private reconcileGeneration = 0;

  constructor(
    pi: ExtensionAPI,
    configPath: string,
    options: CyberToolManagerOptions = {},
  ) {
    this.pi = pi;
    this.configPath = configPath;
    this.label = options.label ?? "Cyber";
    this.toolCommandName = options.toolCommandName ?? "cyber_tool";
    this.configHint = options.configHint ?? configPath;
    this.reloadConfigOnly();
  }

  /** True when Pi has registered live MCP tools for this server (connection succeeded). */
  private hasLiveMcpTools(serverName: string): boolean {
    const prefix = `mcp__${serverName}__`;
    try {
      return this.pi.getAllTools().some((tool) => tool.name.startsWith(prefix));
    } catch {
      return false;
    }
  }

  private startupMs(name: string): number {
    const cfg = this.configs.find((c) => c.name === name);
    return (cfg?.mcp?.startupTimeoutSec ?? DEFAULT_STARTUP_TIMEOUT_SEC) * 1000;
  }

  /**
   * Align local status with Pi's real MCP connection:
   * registered + tools → running; registered + no tools → starting (until its startup timeout),
   * then error; running but tools gone → error; not registered → stopped.
   */
  reconcileStatuses(): void {
    const registered = this.getRegisteredServerNames();
    const now = Date.now();
    for (const cfg of this.configs) {
      const prev: CyberToolState = this.states.get(cfg.name) ?? { status: "stopped" };
      const isRegistered = registered.has(cfg.name);
      if (!isRegistered) {
        if (prev.status === "stopped" && !prev.lastError) continue;
        // Keep explicit start() errors; clear transient starting/running when unregistered.
        if (prev.status === "error" && prev.lastError) continue;
        this.states.set(cfg.name, {
          ...prev,
          status: "stopped",
          lastError: undefined,
          startedAt: undefined,
        });
        continue;
      }

      if (this.hasLiveMcpTools(cfg.name)) {
        this.states.set(cfg.name, {
          ...prev,
          status: "running",
          lastError: undefined,
          startedAt: undefined,
        });
        continue;
      }

      if (prev.status === "running") {
        this.states.set(cfg.name, {
          ...prev,
          status: "error",
          lastError: "MCP 连接已断开（工具列表里已没有它的工具，以 /mcp 为准）",
        });
        continue;
      }

      if (prev.status === "error") continue;

      const startedAt = prev.startedAt ?? now;
      if (now - startedAt > this.startupMs(cfg.name)) {
        this.states.set(cfg.name, {
          ...prev,
          status: "error",
          startedAt,
          lastError: `启动超时（${Math.round(this.startupMs(cfg.name) / 1000)}s 内没有出现 MCP 工具）`,
        });
        continue;
      }
      this.states.set(cfg.name, { ...prev, status: "starting", startedAt, lastError: undefined });
    }
  }

  /** Poll until nothing is "starting" any more (Pi connects servers in the background). */
  scheduleReconcile(onUpdate?: () => void): void {
    const generation = ++this.reconcileGeneration;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);

    const delays = [400, 1200, 3000, 6000];
    const began = Date.now();
    let step = 0;

    const tick = () => {
      if (generation !== this.reconcileGeneration) return;
      this.reconcileStatuses();
      onUpdate?.();
      const pending = [...this.states.values()].some((state) => state.status === "starting");
      if (!pending || Date.now() - began > 20 * 60_000) return;
      const next = step + 1 < delays.length ? delays[step + 1]! - delays[step]! : 5000;
      step += 1;
      this.reconcileTimer = setTimeout(tick, next);
      this.reconcileTimer.unref?.();
    };

    this.reconcileTimer = setTimeout(tick, delays[0]!);
    this.reconcileTimer.unref?.();
  }

  reloadConfigOnly(): void {
    this.configs = loadCyberToolsConfig(this.configPath);
    const validNames = new Set(this.configs.map((c) => c.name));
    for (const name of this.states.keys()) {
      if (!validNames.has(name)) {
        this.states.delete(name);
      }
    }
    for (const cfg of this.configs) {
      if (!this.states.has(cfg.name)) {
        this.states.set(cfg.name, { status: "stopped" });
      }
    }
  }

  private getRegisteredServerNames(): Set<string> {
    return new Set(this.pi.getMcpServers().map((s) => s.name));
  }

  private buildMcpConfig(
    entry: CyberToolConfig,
    runtimeCtx: CyberToolRuntimeContext,
  ): { mcpConfig: McpServerConfig; toolDir: string; resolvedCommand: string } {
    const toolDir = join(runtimeCtx.workspaceDir, ".cyber-tools", entry.name);
    mkdirSync(toolDir, { recursive: true });

    const vars = buildTemplateVars(entry.name, runtimeCtx, toolDir, dirname(this.configPath));
    const paths = resolveToolPaths();
    const parsed = parseStartCommand(entry);
    const requireTarget =
      parsed.command.includes("${targetPath}") ||
      parsed.command.includes("${targetName}") ||
      parsed.args.some((a) => a.includes("${targetPath}") || a.includes("${targetName}")) ||
      Object.values(entry.env ?? {}).some(
        (v) => v.includes("${targetPath}") || v.includes("${targetName}"),
      );

    const command = expandTemplate(parsed.command, vars, paths, entry.name, requireTarget);
    const args = parsed.args.map((arg) => expandTemplate(arg, vars, paths, entry.name, requireTarget));

    let env: Record<string, string> | undefined;
    if (entry.env) {
      env = {};
      for (const [key, val] of Object.entries(entry.env)) {
        env[key] = expandTemplate(val, vars, paths, entry.name, requireTarget);
      }
    }

    const cwd = entry.cwd
      ? expandTemplate(entry.cwd, vars, paths, entry.name, requireTarget)
      : runtimeCtx.workspaceDir;

    return {
      mcpConfig: {
        command,
        args,
        env,
        cwd,
        description: entry.description,
        enabled: true,
        exposure: entry.mcp?.exposure ?? "direct",
        toolExposure: entry.mcp?.toolExposure,
        timeout: entry.mcp?.timeout,
      },
      toolDir,
      resolvedCommand: [command, ...args].join(" "),
    };
  }

  /**
   * Register the MCP server. Returns "already" when the same config is already registered and
   * starting or running, so a repeated start never kills a running analysis. `force` restarts.
   */
  private launch(
    name: string,
    runtimeCtx: CyberToolRuntimeContext,
    force = false,
  ): "started" | "already" {
    const entry = this.configs.find((c) => c.name === name);
    if (!entry) {
      throw new Error(`未找到名为 "${name}" 的${this.label}工具配置`);
    }

    let built: ReturnType<CyberToolManager["buildMcpConfig"]>;
    try {
      built = this.buildMcpConfig(entry, runtimeCtx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.states.set(name, { status: "error", lastError: message });
      throw error;
    }

    const signature = JSON.stringify(built.mcpConfig);
    this.reconcileStatuses();
    const prev = this.states.get(name);
    const registered = this.getRegisteredServerNames().has(name);
    if (
      !force &&
      registered &&
      prev?.signature === signature &&
      (prev.status === "running" || prev.status === "starting")
    ) {
      return "already";
    }

    this.states.set(name, { status: "starting", lastError: undefined, startedAt: Date.now() });
    try {
      if (registered) {
        this.pi.unregisterMcpServer(name);
      }
      this.pi.registerMcpServer(name, built.mcpConfig);
      // Stay "starting" until Pi actually connects and exposes mcp__<name>__* tools.
      this.states.set(name, {
        status: "starting",
        toolDir: built.toolDir,
        resolvedCommand: built.resolvedCommand,
        startedAt: Date.now(),
        signature,
      });
      return "started";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.states.set(name, { status: "error", lastError: message });
      throw error;
    }
  }

  start(
    name: string,
    runtimeCtx: CyberToolRuntimeContext,
    options: { force?: boolean } = {},
  ): CyberToolStatusInfo {
    const outcome = this.launch(name, runtimeCtx, options.force === true);
    if (outcome === "started") this.scheduleReconcile();
    return this.getStatusList(name)[0];
  }

  /** Names of MCP tools Pi has exposed for this server. */
  liveToolNames(name: string): string[] {
    const prefix = `mcp__${name}__`;
    try {
      return this.pi.getAllTools().map((tool) => tool.name).filter((toolName) => toolName.startsWith(prefix));
    } catch {
      return [];
    }
  }

  /**
   * Register the server and block until its MCP tools appear, or the start fails or times out.
   * Slash-command start stays non-blocking; tool calls use this so the model gets a final result.
   * A repeated call for an already running server returns immediately without restarting it.
   */
  async startAndWait(
    name: string,
    runtimeCtx: CyberToolRuntimeContext,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      onUpdate?: (message: string) => void;
      force?: boolean;
    } = {},
  ): Promise<CyberToolStatusInfo> {
    const timeoutMs = options.timeoutMs ?? this.startupMs(name);
    this.launch(name, runtimeCtx, options.force === true);
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      if (options.signal?.aborted) {
        throw new Error("已取消");
      }
      this.reconcileStatuses();
      const current = this.states.get(name);
      if (current?.status === "running") return this.getStatusList(name)[0];
      if (current?.status === "error") return this.getStatusList(name)[0];
      if (!this.getRegisteredServerNames().has(name)) {
        this.states.set(name, {
          ...current,
          status: "error",
          lastError: current?.lastError ?? "MCP 注册被移除，没有连上",
        });
        return this.getStatusList(name)[0];
      }
      const elapsed = Math.round((Date.now() - started) / 1000);
      options.onUpdate?.(`${name} 启动中，已等待 ${elapsed}s（上限 ${Math.round(timeoutMs / 1000)}s）`);
      await sleep(1000, options.signal);
    }

    this.reconcileStatuses();
    const current = this.states.get(name);
    if (current?.status !== "running") {
      this.states.set(name, {
        ...current,
        status: "error",
        lastError: `启动超时（${Math.round(timeoutMs / 1000)}s 内没有出现 MCP 工具）。可能是依赖还在下载、路径配置不对或进程已退出；在终端手动运行该命令可看到具体报错。`,
      });
    }
    return this.getStatusList(name)[0];
  }

  stop(name: string): CyberToolStatusInfo {
    const entry = this.configs.find((c) => c.name === name);
    if (!entry) {
      throw new Error(`未找到名为 "${name}" 的${this.label}工具配置`);
    }

    if (this.getRegisteredServerNames().has(name)) {
      this.pi.unregisterMcpServer(name);
    }
    this.states.set(name, { status: "stopped" });
    return this.getStatusList(name)[0];
  }

  stopAll(): void {
    const registered = this.getRegisteredServerNames();
    for (const cfg of this.configs) {
      if (registered.has(cfg.name)) {
        this.pi.unregisterMcpServer(cfg.name);
      }
      this.states.set(cfg.name, { status: "stopped" });
    }
  }

  reload(runtimeCtx: CyberToolRuntimeContext, name?: string): CyberToolStatusInfo[] {
    const previouslyRunning = new Set(
      this.getStatusList()
        .filter((item) => item.status === "running")
        .map((item) => item.name),
    );

    this.reloadConfigOnly();

    if (name) {
      return [this.start(name, runtimeCtx, { force: true })];
    }

    const targets = this.configs.filter(
      (cfg) => previouslyRunning.has(cfg.name) || cfg.autoStart === true,
    );
    for (const cfg of targets) {
      try {
        this.start(cfg.name, runtimeCtx, { force: true });
      } catch {
        // Error state is recorded in `this.states` for status inspection.
      }
    }
    return this.getStatusList();
  }

  autoLoad(runtimeCtx: CyberToolRuntimeContext): CyberToolStatusInfo[] {
    const loaded: CyberToolStatusInfo[] = [];
    for (const cfg of this.configs) {
      if (!cfg.autoStart) continue;
      const current = this.states.get(cfg.name);
      if (current?.status === "running") continue;
      try {
        loaded.push(this.start(cfg.name, runtimeCtx));
      } catch {
        // Error state is recorded in `this.states`.
      }
    }
    return loaded;
  }

  getStatusList(name?: string): CyberToolStatusInfo[] {
    // Cheap live sync before reporting (no fail-yet — use scheduleReconcile for that).
    this.reconcileStatuses();
    const registered = this.getRegisteredServerNames();
    const list = name ? this.configs.filter((c) => c.name === name) : this.configs;

    return list.map((cfg) => {
      const state = this.states.get(cfg.name) ?? { status: "stopped" as CyberToolStatus };
      const mcpRegistered = registered.has(cfg.name);
      let displayCommand = state.resolvedCommand ?? cfg.startCommand ?? cfg.command ?? "";
      if (!state.resolvedCommand) {
        try {
          displayCommand = parseStartCommand(cfg).displayCommand;
        } catch {
          // Keep raw fallback string if invalid.
        }
      }

      return {
        name: cfg.name,
        description: cfg.description,
        startCommand: displayCommand,
        status: state.status,
        autoStart: Boolean(cfg.autoStart),
        mcpRegistered,
        toolDir: state.toolDir,
        lastError: state.lastError,
      };
    });
  }

  formatPromptSection(): string {
    const items = this.getStatusList();
    if (items.length === 0) {
      return `当前未配置${this.label}工具（可在 \`${this.configHint}\` 中添加）。`;
    }

    const lines = [
      `已配置的${this.label}工具（可通过 \`${this.toolCommandName}\` 执行 \`start\` / \`status\` / \`reload\` / \`stop\`，启动后自动注入为 MCP 工具）：`,
    ];
    for (const item of items) {
      const errSuffix = item.lastError ? ` | error: ${item.lastError}` : "";
      lines.push(
        `- ${item.name} [status: ${item.status}] — ${item.description} (cmd: \`${item.startCommand}\`)${errSuffix}`,
      );
    }
    return lines.join("\n");
  }
}

/** Shared execution logic for `<mode>_tool` lifecycle tools. */
export async function executeToolLifecycleAction(
  manager: CyberToolManager,
  action: CyberToolAction,
  name: string | undefined,
  runtimeCtx: CyberToolRuntimeContext,
  options?: {
    signal?: AbortSignal;
    onUpdate?: (message: string) => void;
    onStop?: (name: string) => void;
  },
): Promise<{ text: string; tools: CyberToolStatusInfo[] }> {
  switch (action) {
    case "status": {
      const tools = manager.getStatusList(name);
      return { tools, text: formatToolsStatusText(tools) };
    }
    case "start": {
      if (!name) throw new Error("action=start 时必须指定工具名称 name");
      const info = await manager.startAndWait(name, runtimeCtx, {
        signal: options?.signal,
        onUpdate: options?.onUpdate,
      });
      return {
        tools: [info],
        text: formatStartOutcome(info, manager.liveToolNames(name)),
      };
    }
    case "stop": {
      if (!name) throw new Error("action=stop 时必须指定工具名称 name");
      options?.onStop?.(name);
      const info = manager.stop(name);
      return { tools: [info], text: `${name} 已停止。` };
    }
    case "reload": {
      const tools = manager.reload(runtimeCtx, name);
      return { tools, text: formatToolsStatusText(tools) };
    }
    default:
      throw new Error(`未知 action: ${String(action)}`);
  }
}

/** Shared slash-command handler for `/pentest-tools` and `/reverse-tools`. */
export function handleToolsSlashCommand(
  manager: CyberToolManager,
  args: string,
  runtimeCtx: CyberToolRuntimeContext,
  options: {
    commandName: string;
    label: string;
    notify: (message: string, type?: "info" | "warning" | "error") => void;
    onAfter?: () => void;
  },
): void {
  const [sub = "status", name] = args.trim().split(/\s+/);
  try {
    if (sub === "status") {
      options.onAfter?.();
      options.notify(formatToolsStatusText(manager.getStatusList(name)), "info");
    } else if (sub === "start" && name) {
      const info = manager.start(name, runtimeCtx);
      options.onAfter?.();
      options.notify(`已启动并注入 MCP: ${info.name} (status=${info.status})`, "info");
    } else if (sub === "stop" && name) {
      const info = manager.stop(name);
      options.onAfter?.();
      options.notify(`已停止并卸载 MCP: ${info.name} (status=${info.status})`, "info");
    } else if (sub === "reload") {
      const items = manager.reload(runtimeCtx, name);
      options.onAfter?.();
      options.notify(`已重载${options.label}工具配置:\n${formatToolsStatusText(items)}`, "info");
    } else {
      options.notify(
        `用法: /${options.commandName} [status | start <name> | stop <name> | reload [name]]`,
        "warning",
      );
    }
  } catch (error) {
    options.onAfter?.();
    const message = error instanceof Error ? error.message : String(error);
    options.notify(`${options.label}工具操作失败: ${message}`, "error");
  }
}
