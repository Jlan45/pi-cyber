import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type CyberModeId = "pentest" | "reverse" | "attribution" | "remediation";

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
      switchCyberMode(pi, ctx, meta.id);
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
}

/**
 * Broadcasts a working-mode change across loaded pi-cyber extensions and updates the footer status.
 */
export function switchCyberMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  mode: CyberModeId | null,
  options?: SwitchCyberModeOptions,
): void {
  pi.events.emit(CYBER_MODE_EVENT, mode);

  if (mode === null) {
    ctx.ui.setStatus(CYBER_STATUS_KEY, undefined);
    if (!options?.silent) {
      ctx.ui.notify("已退出网络安全工作模式", "info");
    }
    return;
  }

  const meta = CYBER_MODES[mode];
  const suffix = options?.engagementName ? ` (${options.engagementName})` : ` (${meta.id})`;
  ctx.ui.setStatus(CYBER_STATUS_KEY, `Cyber: ${meta.label}${suffix}`);
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
