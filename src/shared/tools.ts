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
    timeout?: number;
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
  private readonly states = new Map<
    string,
    { status: CyberToolStatus; toolDir?: string; resolvedCommand?: string; lastError?: string }
  >();
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

  /**
   * Align local status with Pi's real MCP connection:
   * registered + tools → running; registered + no tools → starting/error; else stopped.
   */
  reconcileStatuses(options?: { failIfStillStarting?: boolean }): void {
    const registered = this.getRegisteredServerNames();
    for (const cfg of this.configs) {
      const prev = this.states.get(cfg.name) ?? { status: "stopped" as CyberToolStatus };
      const isRegistered = registered.has(cfg.name);
      if (!isRegistered) {
        if (prev.status === "stopped" && !prev.lastError) continue;
        // Keep explicit start() errors; clear transient starting/running when unregistered.
        if (prev.status === "error" && prev.lastError) continue;
        this.states.set(cfg.name, {
          ...prev,
          status: "stopped",
          lastError: undefined,
        });
        continue;
      }

      if (this.hasLiveMcpTools(cfg.name)) {
        this.states.set(cfg.name, {
          ...prev,
          status: "running",
          lastError: undefined,
        });
        continue;
      }

      if (options?.failIfStillStarting && (prev.status === "starting" || prev.status === "running")) {
        this.states.set(cfg.name, {
          ...prev,
          status: "error",
          lastError: "MCP 连接失败或已断开（以 /mcp 为准）",
        });
        continue;
      }

      if (prev.status !== "error") {
        this.states.set(cfg.name, {
          ...prev,
          status: "starting",
          lastError: undefined,
        });
      }
    }
  }

  /** Debounced multi-attempt reconcile after Pi finishes connecting registered servers. */
  scheduleReconcile(onUpdate?: () => void): void {
    const generation = ++this.reconcileGeneration;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);

    const delays = [400, 1200, 3000, 6000];
    let step = 0;

    const tick = () => {
      if (generation !== this.reconcileGeneration) return;
      const isLast = step >= delays.length - 1;
      this.reconcileStatuses({ failIfStillStarting: isLast });
      onUpdate?.();
      step += 1;
      if (!isLast) {
        this.reconcileTimer = setTimeout(tick, delays[step]! - delays[step - 1]!);
      }
    };

    this.reconcileTimer = setTimeout(tick, delays[0]!);
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

  start(name: string, runtimeCtx: CyberToolRuntimeContext): CyberToolStatusInfo {
    const entry = this.configs.find((c) => c.name === name);
    if (!entry) {
      throw new Error(`未找到名为 "${name}" 的${this.label}工具配置`);
    }

    this.states.set(name, { status: "starting", lastError: undefined });
    try {
      const { mcpConfig, toolDir, resolvedCommand } = this.buildMcpConfig(entry, runtimeCtx);
      if (this.getRegisteredServerNames().has(name)) {
        this.pi.unregisterMcpServer(name);
      }
      this.pi.registerMcpServer(name, mcpConfig);
      // Stay "starting" until Pi actually connects and exposes mcp__<name>__* tools.
      this.states.set(name, { status: "starting", toolDir, resolvedCommand });
      this.scheduleReconcile();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.states.set(name, { status: "error", lastError: message });
      throw error;
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
      return [this.start(name, runtimeCtx)];
    }

    const targets = this.configs.filter(
      (cfg) => previouslyRunning.has(cfg.name) || cfg.autoStart === true,
    );
    for (const cfg of targets) {
      try {
        this.start(cfg.name, runtimeCtx);
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
