import { basename } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import {
  showCyberModeSelector,
  showCyberProjectSelector,
} from "../../src/shared/cyber-selector.ts";
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
  isCyberWorkspaceDir,
  listCyberProjects,
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

  const safeSetStatus = (
    mode: CyberModeId | null,
    engagementName?: string,
  ) => {
    if (!lastCtx) return;
    try {
      if (mode) {
        setCyberStatusLabel(lastCtx, mode, engagementName);
      } else {
        setCyberStatusLabel(lastCtx, null);
      }
    } catch {
      // ctx may be stale across session replacement; drop it
      lastCtx = null;
    }
  };

  pi.events.on(CYBER_WORKSPACE_EVENT, (data) => {
    const workspace = data as CyberWorkspaceState | null;
    activeWorkspace = workspace;
    if (activeMode) {
      safeSetStatus(
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
      safeSetStatus(
        nextMode,
        nextMode ? basename(activeWorkspace.workspaceDir) : undefined,
      );
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    reconstructWorkspace(ctx);
    if (activeWorkspace && activeWorkspace.workspaceDir === ctx.cwd) {
      const manifest = readManifest(activeWorkspace.workspaceDir);
      if (manifest?.activeMode && isCyberModeId(manifest.activeMode)) {
        await switchCyberMode(pi, ctx, manifest.activeMode, {
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
      "Cyber 工作区总控: /cyber 选择项目→模式；或 [name | pentest|… | off]",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const raw = args.trim();
      const target = raw.toLowerCase();

      if (target === "off" || target === "none") {
        if (activeWorkspace) {
          updateManifestActiveMode(activeWorkspace.workspaceDir, null);
        }
        await switchCyberMode(pi, ctx, null);
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
          ctx.ui.notify("尚未绑定 Cyber 工作区。请先 `/cyber` 选择或新建项目。", "warning");
          return;
        }
        await switchCyberMode(pi, ctx, target, {
          engagementName: basename(activeWorkspace.workspaceDir),
        });
        return;
      }

      if (!raw) {
        await openCyberWizard(pi, ctx, {
          activeWorkspace,
          activeMode,
          bindWorkspace,
        });
        return;
      }

      // Treat remaining args as engagement name → create + migrate
      try {
        await createAndMigrate(pi, ctx, raw, bindWorkspace);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          ctx.ui.notify(`创建 Cyber 工作区失败: ${message}`, "error");
        } catch {
          /* ignore stale ctx */
        }
      }
    },
  });
}

async function openCyberWizard(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: {
    activeWorkspace: CyberWorkspaceState | null;
    activeMode: CyberModeId | null;
    bindWorkspace: (
      ctx: ExtensionContext,
      workspace: CyberWorkspaceState,
      persist: boolean,
    ) => void;
  },
): Promise<void> {
  const scanRoot = state.activeWorkspace?.rootCwd ?? ctx.cwd;
  const projects = listCyberProjects(scanRoot);

  const projectChoice = await showCyberProjectSelector(ctx, projects, {
    currentWorkspaceDir: state.activeWorkspace?.workspaceDir ?? null,
    modeActive: state.activeMode !== null,
  });

  if (projectChoice.action === "cancel") return;

  if (projectChoice.action === "off") {
    if (state.activeWorkspace) {
      updateManifestActiveMode(state.activeWorkspace.workspaceDir, null);
    }
    await switchCyberMode(pi, ctx, null);
    return;
  }

  if (projectChoice.action === "create") {
    const name = (await ctx.ui.input("新建项目名称", "engagement"))?.trim();
    if (!name) return;
    const modeChoice = await showCyberModeSelector(ctx, {
      projectLabel: name,
      currentMode: null,
    });
    if (modeChoice.action === "cancel") return;
    try {
      await createAndMigrate(pi, ctx, name, state.bindWorkspace, modeChoice.mode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        ctx.ui.notify(`创建 Cyber 工作区失败: ${message}`, "error");
      } catch {
        /* ignore stale ctx */
      }
    }
    return;
  }

  const ws =
    loadCyberWorkspaceFromDir(projectChoice.workspaceDir, scanRoot) ??
    loadCyberWorkspaceFromDir(projectChoice.workspaceDir);
  if (!ws) {
    ctx.ui.notify(`无法加载项目: ${projectChoice.workspaceDir}`, "error");
    return;
  }
  const manifest = readManifest(ws.workspaceDir);
  const modeChoice = await showCyberModeSelector(ctx, {
    projectLabel: basename(ws.workspaceDir),
    currentMode: manifest?.activeMode ?? null,
  });
  if (modeChoice.action === "cancel") return;

  try {
    await openExistingProject(pi, ctx, ws, modeChoice.mode, state.bindWorkspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      ctx.ui.notify(`打开 Cyber 项目失败: ${message}`, "error");
    } catch {
      /* ignore stale ctx */
    }
  }
}

async function openExistingProject(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  workspace: CyberWorkspaceState,
  mode: CyberModeId,
  bindWorkspace: (
    ctx: ExtensionContext,
    workspace: CyberWorkspaceState,
    persist: boolean,
  ) => void,
): Promise<void> {
  updateManifestActiveMode(workspace.workspaceDir, mode);
  const workspaceName = basename(workspace.workspaceDir);

  if (ctx.cwd === workspace.workspaceDir) {
    bindWorkspace(ctx, workspace, true);
    await switchCyberMode(pi, ctx, mode, { engagementName: workspaceName });
    return;
  }

  // Prefer writing activeMode before switchSession; the replacement instance
  // restores mode from manifest in session_start (old `pi` is stale after switch).
  const migratedSessionFile = migrateSessionToWorkspace(ctx.sessionManager, workspace);
  const result = await ctx.switchSession(migratedSessionFile, {
    withSession: async (newCtx: ExtensionCommandContext) => {
      newCtx.ui.notify(
        `已切换至 Cyber 项目: ${workspaceName} · ${CYBER_MODES[mode].label}`,
        "info",
      );
    },
  });

  if (result.cancelled) {
    bindWorkspace(ctx, workspace, true);
    await switchCyberMode(pi, ctx, mode, { engagementName: workspaceName });
    ctx.ui.notify("会话切换被取消，已在当前会话绑定该项目", "warning");
  }
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
  mode?: CyberModeId,
): Promise<void> {
  const workspace = createCyberWorkspace(ctx.cwd, engagementName);
  if (mode) {
    updateManifestActiveMode(workspace.workspaceDir, mode);
  }
  const migratedSessionFile = migrateSessionToWorkspace(ctx.sessionManager, workspace);
  const workspaceName = basename(workspace.workspaceDir);
  const workspaceDir = workspace.workspaceDir;

  const result = await ctx.switchSession(migratedSessionFile, {
    withSession: async (newCtx: ExtensionCommandContext) => {
      newCtx.ui.notify(
        mode
          ? `已创建并进入: ${workspaceName} · ${CYBER_MODES[mode].label} (${workspaceDir})`
          : `已创建并迁移会话至 Cyber 工作区: ${workspaceName} (${workspaceDir})`,
        "info",
      );
    },
  });

  if (result.cancelled) {
    bindWorkspace(ctx, workspace, true);
    if (mode) {
      await switchCyberMode(pi, ctx, mode, { engagementName: workspaceName });
    }
    ctx.ui.notify("会话切换被取消，Cyber 工作区已创建但未切换会话", "warning");
  }
}
