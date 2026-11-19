import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { applyCyberEditorStyle } from "./editor-style.ts";
import { playCyberEnterAnimation } from "./enter-animation.ts";

export type CyberModeId = "pentest" | "reverse" | "attribution" | "remediation";

/**
 * Pi loads each extension as its own module instance, so a file-level variable
 * is not shared. The footer is updated by whichever copy ran switchCyberMode,
 * while /runtime and /reverse-tools read another copy and think the mode is off.
 */
const CYBER_MODE_STATE_KEY = "__piCyberActiveMode";

function readBroadcastMode(): CyberModeId | null {
  const value = (globalThis as Record<string, unknown>)[CYBER_MODE_STATE_KEY];
  return value === "pentest" || value === "reverse" || value === "attribution" || value === "remediation"
    ? value
    : null;
}

function writeBroadcastMode(mode: CyberModeId | null): void {
  (globalThis as Record<string, unknown>)[CYBER_MODE_STATE_KEY] = mode;
}

/** Slash commands that stay hidden until a working mode is active. `/cyber` is the only entry. */
export const CYBER_ONLY_COMMANDS = [
  "pentest",
  "reverse",
  "attribution",
  "remediation",
  "runtime",
  "pentest-tools",
  "reverse-tools",
] as const;

/** LLM tools declared only while a working mode is active. */
export const CYBER_ONLY_TOOLS = [
  "pentest_set_scope",
  "pentest_check_scope",
  "pentest_add_target",
  "pentest_tool",
  "pentest_set_execution",
  "reverse_add_target",
  "reverse_tool",
  "ghidra_wait_ready",
] as const;

export function isCyberModeActive(): boolean {
  return readBroadcastMode() !== null;
}

export function refuseOutsideCyberMode(ctx: { ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } }): boolean {
  if (isCyberModeActive()) return false;
  ctx.ui.notify("请使用 /cyber 进入工作模式。", "warning");
  return true;
}

/** Show or hide cyber tools in the model tool list. Other active tools stay as they are. */
export function syncCyberToolSurface(pi: ExtensionAPI): void {
  const active = new Set(pi.getActiveTools());
  const enabled = isCyberModeActive();
  for (const name of CYBER_ONLY_TOOLS) {
    if (enabled) active.add(name);
    else active.delete(name);
  }
  pi.setActiveTools([...active]);
}

export interface CyberModeMeta {
  id: CyberModeId;
  label: string;
  description: string;
  command: string;
}

export const CYBER_MODE_EVENT = "pi-cyber:mode-change";
export const CYBER_STATUS_KEY = "pi-cyber-mode";
/** Event payload when a shared engagement workspace is bound / cleared. */
export const CYBER_WORKSPACE_EVENT = "pi-cyber:workspace-change";

export const CYBER_MODES: Record<CyberModeId, CyberModeMeta> = {
  pentest: {
    id: "pentest",
    label: "渗透",
    description: "渗透测试模式：信息收集、漏洞验证与安全评估",
    command: "pentest",
  },
  reverse: {
    id: "reverse",
    label: "逆向",
    description: "逆向工程模式：二进制分析、反编译与协议还原",
    command: "reverse",
  },
  attribution: {
    id: "attribution",
    label: "溯源",
    description: "溯源取证模式：日志分析、攻击链还原与 IOC 关联",
    command: "attribution",
  },
  remediation: {
    id: "remediation",
    label: "漏洞修复",
    description: "漏洞修复模式：补丁生成、安全加固与回归验证",
    command: "remediation",
  },
};

export function isCyberModeId(value: string): value is CyberModeId {
  return value in CYBER_MODES;
}

export interface ModeModuleContext {
  isActive: () => boolean;
}

export interface ModeModuleOptions {
  onCommand?: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  /** Optional per-invocation switch options (e.g. skip boot animation before a session migrate). */
  resolveSwitchOptions?: (
    args: string,
    ctx: ExtensionCommandContext,
  ) => SwitchCyberModeOptions | undefined;
}

/**
 * Registers a cyber working-mode extension with a shared mode-switch command and active state tracking.
 */
export function registerModeModule(
  pi: ExtensionAPI,
  meta: CyberModeMeta,
  setup?: (pi: ExtensionAPI, modeCtx: ModeModuleContext) => void,
  options?: ModeModuleOptions,
): void {
  let active = false;

  pi.events.on(CYBER_MODE_EVENT, (data) => {
    active = (data as CyberModeId | null) === meta.id;
  });

  pi.registerCommand(meta.command, {
    description: meta.description,
    handler: async (args, ctx) => {
      if (refuseOutsideCyberMode(ctx)) return;
      await switchCyberMode(pi, ctx, meta.id, options?.resolveSwitchOptions?.(args, ctx));
      await options?.onCommand?.(args, ctx);
    },
  });

  setup?.(pi, { isActive: () => active });
}

export interface SwitchCyberModeOptions {
  /** Engagement / workspace name shown in footer, e.g. `acme-web-20261118`. */
  engagementName?: string;
  /** Suppress the toast notification (useful during session restore). */
  silent?: boolean;
  /** Skip the enter-mode boot overlay (e.g. tool auto-activate during agent turns). */
  skipAnimation?: boolean;
}

/**
 * Broadcasts a working-mode change across loaded pi-cyber extensions and updates the footer status.
 * When entering a different mode in TUI (and not silent), plays a short boot overlay.
 */
export async function switchCyberMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  mode: CyberModeId | null,
  options?: SwitchCyberModeOptions,
): Promise<void> {
  const modeChanged = mode !== readBroadcastMode();
  writeBroadcastMode(mode);
  pi.events.emit(CYBER_MODE_EVENT, mode);

  if (mode === null) {
    applyCyberEditorStyle(ctx, false);
    ctx.ui.setStatus(CYBER_STATUS_KEY, undefined);
    syncCyberToolSurface(pi);
    if (!options?.silent) {
      ctx.ui.notify("已退出网络安全工作模式", "info");
    }
    return;
  }

  const meta = CYBER_MODES[mode];
  const suffix = options?.engagementName ? ` (${options.engagementName})` : ` (${meta.id})`;
  ctx.ui.setStatus(CYBER_STATUS_KEY, `Cyber: ${meta.label}${suffix}`);
  applyCyberEditorStyle(ctx, true);

  const shouldAnimate =
    modeChanged && !options?.silent && !options?.skipAnimation && ctx.mode === "tui";
  if (shouldAnimate) {
    try {
      await playCyberEnterAnimation(ctx, mode, options?.engagementName);
    } catch {
      // Animation must never take down the session / mode switch.
      try {
        ctx.ui.setWidget("pi-cyber-enter", undefined);
      } catch {
        /* ignore */
      }
    }
  }

  syncCyberToolSurface(pi);

  if (!options?.silent) {
    ctx.ui.notify(`已切换至「${meta.label}」工作模式`, "info");
  }
}

/**
 * Updates footer status text for the current mode with an engagement name.
 */
export function setCyberStatusLabel(
  ctx: ExtensionContext,
  mode: CyberModeId | null,
  engagementName?: string,
): void {
  if (mode === null) {
    ctx.ui.setStatus(CYBER_STATUS_KEY, undefined);
    return;
  }
  const meta = CYBER_MODES[mode];
  const suffix = engagementName ? ` (${engagementName})` : ` (${meta.id})`;
  ctx.ui.setStatus(CYBER_STATUS_KEY, `Cyber: ${meta.label}${suffix}`);
}
