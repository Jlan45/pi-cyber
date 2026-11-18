import { basename } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import {
  CYBER_MODES,
  CYBER_MODE_EVENT,
  CYBER_STATUS_KEY,
  CYBER_WORKSPACE_EVENT,
  isCyberModeId,
  setCyberStatusLabel,
  switchCyberMode,
  type CyberModeId,
} from "../../src/shared/mode.ts";
import {
  CYBER_WORKSPACE_ENTRY_TYPE,
  createCyberWorkspace,
  formatWorkspacePromptSection,
  formatWorkspaceSummary,
  isCyberWorkspaceDir,
  loadCyberWorkspaceFromDir,
  migrateSessionToWorkspace,
  quoteShellPath,
  readManifest,
  reconstructWorkspaceFromSession,
  resolvePathInWorkspace,
  updateManifestActiveMode,
  type CyberWorkspaceState,
} from "../../src/shared/workspace.ts";

const PATH_REDIRECT_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep"]);

/**
 * Core extension: unified `/cyber` workspace control + cross-mode path redirect / prompt.
 */
export default function (pi: ExtensionAPI) {
  let activeWorkspace: CyberWorkspaceState | null = null;
  let activeMode: CyberModeId | null = null;
  let lastCtx: ExtensionContext | null = null;

  const bindWorkspace = (ctx: ExtensionContext, workspace: CyberWorkspaceState, persist: boolean) => {
    activeWorkspace = workspace;
    lastCtx = ctx;
    if (persist) {
      pi.appendEntry(CYBER_WORKSPACE_ENTRY_TYPE, workspace);
    }
    pi.events.emit(CYBER_WORKSPACE_EVENT, workspace);
    if (activeMode) {
      setCyberStatusLabel(ctx, activeMode, basename(workspace.workspaceDir));
    }
  };

  const reconstructWorkspace = (ctx: ExtensionContext) => {
    activeWorkspace = reconstructWorkspaceFromSession(ctx.sessionManager.getBranch());
    if (!activeWorkspace && isCyberWorkspaceDir(ctx.cwd)) {
      activeWorkspace = loadCyberWorkspaceFromDir(ctx.cwd);
    }
    if (activeWorkspace) {
      pi.events.emit(CYBER_WORKSPACE_EVENT, activeWorkspace);
    }
  };

  pi.events.on(CYBER_WORKSPACE_EVENT, (data) => {
    const workspace = data as CyberWorkspaceState | null;
    activeWorkspace = workspace;
    if (lastCtx && activeMode) {
      setCyberStatusLabel(
        lastCtx,
        activeMode,
        workspace ? basename(workspace.workspaceDir) : undefined,
      );
    }
  });

  pi.events.on(CYBER_MODE_EVENT, (data) => {
    const nextMode = data as CyberModeId | null;
    activeMode = nextMode;
    if (activeWorkspace) {
      updateManifestActiveMode(activeWorkspace.workspaceDir, nextMode);
      if (lastCtx) {
        setCyberStatusLabel(
          lastCtx,
          nextMode,
          nextMode ? basename(activeWorkspace.workspaceDir) : undefined,
        );
      }
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    reconstructWorkspace(ctx);
    if (activeWorkspace && activeWorkspace.workspaceDir === ctx.cwd) {
      const manifest = readManifest(activeWorkspace.workspaceDir);
      if (manifest?.activeMode && isCyberModeId(manifest.activeMode)) {
        switchCyberMode(pi, ctx, manifest.activeMode, {
          engagementName: basename(activeWorkspace.workspaceDir),
          silent: true,
        });
      } else {
        setCyberStatusLabel(ctx, null);
        ctx.ui.setStatus(
          CYBER_STATUS_KEY,
          `Cyber: 工作区 (${basename(activeWorkspace.workspaceDir)})`,
        );
      }
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    lastCtx = ctx;
    reconstructWorkspace(ctx);
  });

  pi.on("session_shutdown", async () => {
    lastCtx = null;
  });

  pi.on("before_agent_start", async (event) => {
    if (!activeWorkspace) return;
    event.systemPromptOptions.sections["cyber-workspace"] =
      formatWorkspacePromptSection(activeWorkspace);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!activeWorkspace) return;
    if (activeWorkspace.workspaceDir === ctx.cwd) return;

    if (isToolCallEventType("bash", event)) {
      event.input.command = `cd ${quoteShellPath(activeWorkspace.workspaceDir)} && ${event.input.command}`;
      return;
    }

    if (PATH_REDIRECT_TOOLS.has(event.toolName)) {
      const input = event.input as { path?: string };
      input.path = resolvePathInWorkspace(activeWorkspace.workspaceDir, input.path);
    }
  });

  pi.registerCommand("cyber", {
    description:
      "Cyber 工作区总控: /cyber [name | pentest|reverse|attribution|remediation | off]",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const raw = args.trim();
      const target = raw.toLowerCase();

      if (target === "off" || target === "none") {
        if (activeWorkspace) {
          updateManifestActiveMode(activeWorkspace.workspaceDir, null);
        }
        switchCyberMode(pi, ctx, null);
        return;
      }

      if (isCyberModeId(target)) {
        if (!activeWorkspace) {
          if (isCyberWorkspaceDir(ctx.cwd)) {
            const ws = loadCyberWorkspaceFromDir(ctx.cwd);
            if (ws) bindWorkspace(ctx, ws, true);
          }
        }
        if (!activeWorkspace) {
          ctx.ui.notify(
            "尚未绑定 Cyber 工作区。请先使用 `/cyber <任务名>` 创建，或在工作区内打开会话。",
            "warning",
          );
          return;
        }
        switchCyberMode(pi, ctx, target, {
          engagementName: basename(activeWorkspace.workspaceDir),
        });
        return;
      }

      if (!raw) {
        if (activeWorkspace) {
          const manifest = readManifest(activeWorkspace.workspaceDir);
          const modeLabel = manifest?.activeMode
            ? CYBER_MODES[manifest.activeMode].label
            : "未设置";
          ctx.ui.notify(
            [
              `当前 Cyber 工作区: ${activeWorkspace.workspaceDir}`,
              `任务: ${activeWorkspace.engagementName}`,
              `模式: ${modeLabel}`,
              "可用: /cyber <任务名> | /cyber pentest|reverse|attribution|remediation | /cyber off",
            ].join("\n"),
            "info",
          );
          return;
        }

        if (isCyberWorkspaceDir(ctx.cwd)) {
          const ws = loadCyberWorkspaceFromDir(ctx.cwd);
          if (ws) {
            bindWorkspace(ctx, ws, true);
            ctx.ui.notify(formatWorkspaceSummary(ws), "info");
            return;
          }
        }

        const choices = [
          ...Object.values(CYBER_MODES).map((mode) => `${mode.id} — ${mode.description}`),
          "create — 创建新的 Cyber 工作区",
          "off — 退出当前工作模式",
        ];
        const selected = await ctx.ui.select("Cyber 工作区 / 模式", choices);
        if (!selected) return;

        const selectedId = selected.split(" — ")[0];
        if (selectedId === "off") {
          switchCyberMode(pi, ctx, null);
          return;
        }
        if (selectedId === "create") {
          const name = await ctx.ui.input("输入任务/工作区名称");
          if (!name?.trim()) return;
          await createAndMigrate(pi, ctx, name.trim(), bindWorkspace);
          return;
        }
        if (isCyberModeId(selectedId)) {
          ctx.ui.notify(
            "请先 `/cyber <任务名>` 创建工作区，再切换模式；或在已有工作区目录中打开会话。",
            "warning",
          );
          return;
        }
        return;
      }

      // Treat remaining args as engagement name → create + migrate
      try {
        await createAndMigrate(pi, ctx, raw, bindWorkspace);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`创建 Cyber 工作区失败: ${message}`, "error");
      }
    },
  });
}

async function createAndMigrate(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  engagementName: string,
  bindWorkspace: (
    ctx: ExtensionContext,
    workspace: CyberWorkspaceState,
    persist: boolean,
  ) => void,
): Promise<void> {
  const workspace = createCyberWorkspace(ctx.cwd, engagementName);
  const migratedSessionFile = migrateSessionToWorkspace(ctx.sessionManager, workspace);
  const workspaceName = basename(workspace.workspaceDir);
  const workspaceDir = workspace.workspaceDir;

  const result = await ctx.switchSession(migratedSessionFile, {
    withSession: async (newCtx: ExtensionCommandContext) => {
      bindWorkspace(newCtx, workspace, false);
      // Session file already contains the workspace entry from migrateSessionToWorkspace
      newCtx.ui.notify(
        `已创建并迁移会话至 Cyber 工作区: ${workspaceName} (${workspaceDir})`,
        "info",
      );
    },
  });

  if (result.cancelled) {
    // Still bind in current session so tools can use the created dir if desired
    bindWorkspace(ctx, workspace, true);
    ctx.ui.notify("会话切换被取消，Cyber 工作区已创建但未切换会话", "warning");
  }
}
