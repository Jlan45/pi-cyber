import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { playCyberEnterAnimation } from "./enter-animation.ts";
import { CYBER_MODES, switchCyberMode, type CyberModeId } from "./mode.ts";
import {
  CYBER_WORKSPACE_ENTRY_TYPE,
  addTargetToWorkspace,
  createCyberWorkspace,
  getCyberWorkspaceRoot,
  isCyberWorkspaceDir,
  loadCyberWorkspaceFromDir,
  migrateSessionToWorkspace,
  reconstructWorkspaceFromSession,
  sanitizeWorkspaceName,
  setActiveCyberWorkspace,
  updateManifestActiveMode,
  type CyberWorkspaceState,
} from "./workspace.ts";

/**
 * One-step entry: register `targetPath` as a target of the current (or a new) Cyber workspace and
 * enter `mode`. Without a workspace, one is created under the fixed workspace root and the session
 * is migrated into it.
 */
export async function enterModeWithTarget(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  mode: CyberModeId,
  targetPath: string,
  onBound: (workspace: CyberWorkspaceState) => void,
): Promise<void> {
  const label = CYBER_MODES[mode].label;
  let workspace =
    reconstructWorkspaceFromSession(ctx.sessionManager.getBranch()) ??
    (isCyberWorkspaceDir(ctx.cwd) ? loadCyberWorkspaceFromDir(ctx.cwd) : null);

  if (workspace && workspace.workspaceDir === ctx.cwd) {
    const summary = await addTargetToWorkspace(workspace, targetPath);
    setActiveCyberWorkspace(workspace);
    onBound(workspace);
    await switchCyberMode(pi, ctx, mode, {
      engagementName: basename(workspace.workspaceDir),
    });
    ctx.ui.notify(`已登记${label}目标至当前工作区: ${summary.name} → ${summary.path}`, "info");
    return;
  }

  const createdNew = !workspace;
  if (!workspace) {
    const baseName = sanitizeWorkspaceName(basename(targetPath.replace(/[\\/]+$/, "") || "target"));
    workspace = createCyberWorkspace(getCyberWorkspaceRoot(), baseName, new Date(), ctx.cwd);
  }

  const summary = await addTargetToWorkspace(workspace, targetPath);
  // Persist mode on disk so the replacement session_start restores it.
  // Do not call switchCyberMode / pi.* inside withSession — old pi is stale.
  updateManifestActiveMode(workspace.workspaceDir, mode);
  const migratedSessionFile = migrateSessionToWorkspace(ctx.sessionManager, workspace);
  const workspaceName = basename(workspace.workspaceDir);
  const workspaceDir = workspace.workspaceDir;
  const boundWorkspace = workspace;

  const result = await ctx.switchSession(migratedSessionFile, {
    withSession: async (newCtx: ExtensionCommandContext) => {
      try {
        await playCyberEnterAnimation(newCtx, mode, workspaceName);
      } catch {
        /* animation must not fail the handoff */
      }
      newCtx.ui.notify(
        createdNew
          ? `已创建 Cyber 工作区并登记${label}目标: ${summary.name}\n工作区: ${workspaceName} (${workspaceDir})`
          : `已登记${label}目标并切换至工作区: ${summary.name}\n工作区: ${workspaceName} (${workspaceDir})`,
        "info",
      );
    },
  });

  if (result.cancelled) {
    onBound(boundWorkspace);
    pi.appendEntry(CYBER_WORKSPACE_ENTRY_TYPE, boundWorkspace);
    await switchCyberMode(pi, ctx, mode, { engagementName: workspaceName });
    ctx.ui.notify("会话切换被取消，目标已登记但未切换会话", "warning");
  }
}
