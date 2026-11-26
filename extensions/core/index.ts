import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AutocompleteProviderFactory,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  formatSkillsForPrompt,
  isToolCallEventType,
  loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";
import { isRemoteExecutionActive } from "../../src/shared/execution.ts";
import { playCyberEnterAnimation } from "../../src/shared/enter-animation.ts";
import {
  showCyberModeSelector,
  showCyberProjectSelector,
} from "../../src/shared/cyber-selector.ts";
import { enterModeWithTarget } from "../../src/shared/engage.ts";
import {
  CYBER_MODES,
  CYBER_MODE_COMMANDS,
  CYBER_MODE_EVENT,
  CYBER_ONLY_COMMANDS,
  CYBER_STATUS_KEY,
  CYBER_WORKSPACE_EVENT,
  getActiveCyberMode,
  isCyberModeActive,
  isCyberModeId,
  setCyberStatusLabel,
  switchCyberMode,
  syncCyberToolSurface,
  type CyberModeId,
} from "../../src/shared/mode.ts";
import {
  CYBER_WORKSPACE_ENTRY_TYPE,
  createCyberWorkspace,
  formatWorkspacePromptSection,
  getActiveCyberWorkspace,
  getCyberWorkspaceRoot,
  isCyberWorkspaceDir,
  listCyberProjects,
  loadCyberWorkspaceFromDir,
  migrateSessionToWorkspace,
  quoteShellPath,
  readManifest,
  reconstructWorkspaceFromSession,
  resolvePathInWorkspace,
  setActiveCyberWorkspace,
  updateManifestActiveMode,
  type CyberWorkspaceState,
} from "../../src/shared/workspace.ts";

const PATH_REDIRECT_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep"]);
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../skills");
const CYBER_ONLY_COMMAND_NAMES = new Set<string>(CYBER_ONLY_COMMANDS);

const MODE_IDS = Object.keys(CYBER_MODES) as CyberModeId[];

/** Slash-command / skill suggestions that must not show for the current mode (or no mode). */
function isHiddenSuggestion(value: string, mode: CyberModeId | null): boolean {
  if (mode === null) {
    return (
      CYBER_ONLY_COMMAND_NAMES.has(value) || MODE_IDS.some((id) => value.startsWith(`skill:${id}`))
    );
  }
  const owner = CYBER_MODE_COMMANDS[value];
  if (owner && owner !== mode) return true;
  return MODE_IDS.some((id) => id !== mode && value.startsWith(`skill:${id}`));
}

const hideCyberCommands: AutocompleteProviderFactory = (provider) => {
  return {
    triggerCharacters: provider.triggerCharacters,
    getSuggestions: async (lines, cursorLine, cursorCol, options) => {
      const result = await provider.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!result) return result;
      const mode = getActiveCyberMode();
      const items = result.items.filter((item) => !isHiddenSuggestion(item.value, mode));
      return items.length === result.items.length ? result : { ...result, items };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
    shouldTriggerFileCompletion: provider.shouldTriggerFileCompletion?.bind(provider),
  };
};

/**
 * Core extension: unified `/cyber` workspace control + cross-mode path redirect / prompt.
 */
export default function (pi: ExtensionAPI) {
  let activeWorkspace: CyberWorkspaceState | null = null;
  let activeMode: CyberModeId | null = null;
  let lastCtx: ExtensionContext | null = null;
  let commandFilterInstalled = false;

  const bindWorkspace = (ctx: ExtensionContext, workspace: CyberWorkspaceState, persist: boolean) => {
    activeWorkspace = workspace;
    setActiveCyberWorkspace(workspace);
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
    setActiveCyberWorkspace(activeWorkspace);
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
    setActiveCyberWorkspace(workspace);
    if (activeMode) {
      safeSetStatus(
        activeMode,
        workspace ? basename(workspace.workspaceDir) : undefined,
      );
    }
  });

  pi.events.on(CYBER_MODE_EVENT, (data) => {
    const payload =
      data && typeof data === "object" && "mode" in data
        ? (data as { mode: CyberModeId | null; skipManifestUpdate?: boolean })
        : { mode: data as CyberModeId | null, skipManifestUpdate: false };
    const nextMode = payload.mode;
    activeMode = nextMode;
    const ws = activeWorkspace ?? getActiveCyberWorkspace();
    if (ws) {
      if (!payload.skipManifestUpdate) {
        updateManifestActiveMode(ws.workspaceDir, nextMode);
      }
      safeSetStatus(
        nextMode,
        nextMode ? basename(ws.workspaceDir) : undefined,
      );
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    if (!commandFilterInstalled && ctx.hasUI) {
      commandFilterInstalled = true;
      ctx.ui.addAutocompleteProvider(hideCyberCommands);
    }
    reconstructWorkspace(ctx);
    const atWorkspace = activeWorkspace && activeWorkspace.workspaceDir === ctx.cwd ? activeWorkspace : null;
    const manifest = atWorkspace ? readManifest(atWorkspace.workspaceDir) : null;
    if (atWorkspace && manifest?.activeMode && isCyberModeId(manifest.activeMode)) {
      await switchCyberMode(pi, ctx, manifest.activeMode, {
        engagementName: basename(atWorkspace.workspaceDir),
        silent: true,
      });
    } else {
      // The mode flag is process-wide. A session that has no mode to restore (a plain session,
      // another directory, /resume, /new) must not inherit it from the previous one.
      if (isCyberModeActive()) {
        await switchCyberMode(pi, ctx, null, { silent: true, skipManifestUpdate: true });
      }
      if (atWorkspace) {
        ctx.ui.setStatus(
          CYBER_STATUS_KEY,
          `Cyber: 工作区 (${basename(atWorkspace.workspaceDir)})`,
        );
      }
    }
    syncCyberToolSurface(pi);
  });

  pi.on("session_tree", async (_event, ctx) => {
    lastCtx = ctx;
    reconstructWorkspace(ctx);
  });

  pi.on("session_shutdown", async () => {
    lastCtx = null;
  });

  pi.on("before_agent_start", async (event) => {
    // Outside a working mode the session is a normal one: no workspace context, no skills.
    if (!activeMode) return;
    if (activeWorkspace) {
      event.systemPromptOptions.sections["cyber-workspace"] =
        formatWorkspacePromptSection(activeWorkspace);
    }
    const loaded = loadSkillsFromDir({
      dir: join(SKILLS_DIR, activeMode),
      source: "pi-cyber",
    });
    if (loaded.skills.length === 0) return;
    event.systemPromptOptions.sections["cyber-skills"] = formatSkillsForPrompt(loaded.skills, "read");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!activeMode || !activeWorkspace) return;
    if (isRemoteExecutionActive()) return;
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
      "Cyber 工作区总控: /cyber 选择项目→模式；或 [name | pentest|… | reverse <样本路径> | off]",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const raw = args.trim();
      const target = raw.toLowerCase();
      const firstWord = raw.split(/\s+/)[0] ?? "";
      const restArg = raw.slice(firstWord.length).trim();

      if (target === "off" || target === "none") {
        if (activeWorkspace) {
          updateManifestActiveMode(activeWorkspace.workspaceDir, null);
        }
        await switchCyberMode(pi, ctx, null);
        return;
      }

      if (restArg && isCyberModeId(firstWord.toLowerCase())) {
        const mode = firstWord.toLowerCase() as CyberModeId;
        if (mode !== "reverse") {
          ctx.ui.notify(
            `「${CYBER_MODES[mode].label}」模式不接受路径参数。用法: /cyber ${mode}，或 /cyber reverse <样本路径>`,
            "warning",
          );
          return;
        }
        try {
          await enterModeWithTarget(pi, ctx, mode, restArg, (ws) => bindWorkspace(ctx, ws, false));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          try {
            ctx.ui.notify(`登记逆向目标失败: ${message}`, "error");
          } catch {
            /* ignore stale ctx after successful switchSession */
          }
        }
        return;
      }

      if (isCyberModeId(target) && !CYBER_MODES[target].implemented) {
        ctx.ui.notify(`「${CYBER_MODES[target].label}」模式还没有实现。`, "warning");
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
  const launchRoot = state.activeWorkspace?.rootCwd ?? ctx.cwd;
  const projects = listCyberProjects(getCyberWorkspaceRoot(), launchRoot);

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

  const ws = loadCyberWorkspaceFromDir(projectChoice.workspaceDir, launchRoot);
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
      try {
        await playCyberEnterAnimation(newCtx, mode, workspaceName);
      } catch {
        /* animation must not fail the handoff */
      }
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
  const workspace = createCyberWorkspace(getCyberWorkspaceRoot(), engagementName, new Date(), ctx.cwd);
  if (mode) {
    updateManifestActiveMode(workspace.workspaceDir, mode);
  }
  const migratedSessionFile = migrateSessionToWorkspace(ctx.sessionManager, workspace);
  const workspaceName = basename(workspace.workspaceDir);
  const workspaceDir = workspace.workspaceDir;

  const result = await ctx.switchSession(migratedSessionFile, {
    withSession: async (newCtx: ExtensionCommandContext) => {
      if (mode) {
        try {
          await playCyberEnterAnimation(newCtx, mode, workspaceName);
        } catch {
          /* animation must not fail the handoff */
        }
      }
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
