import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CYBER_MODE_EVENT,
  CYBER_MODES,
  CYBER_WORKSPACE_EVENT,
  registerModeModule,
  switchCyberMode,
} from "../../src/shared/mode.ts";
import {
  CyberToolManager,
  formatToolsStatusIndicator,
  formatToolsStatusText,
  type CyberToolRuntimeContext,
  type CyberToolStatusInfo,
} from "../../src/shared/tools.ts";
import {
  CYBER_WORKSPACE_ENTRY_TYPE,
  addTargetToWorkspace,
  createCyberWorkspace,
  isCyberWorkspaceDir,
  loadCyberWorkspaceFromDir,
  migrateSessionToWorkspace,
  readManifest,
  reconstructWorkspaceFromSession,
  sanitizeWorkspaceName,
  type CyberWorkspaceState,
} from "../../src/shared/workspace.ts";

const TOOLS_STATUS_KEY = "pi-cyber-reverse-tools";
const TOOLS_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "tools.json");

/**
 * Reverse engineering working-mode extension (shared Cyber workspace).
 */
export default function (pi: ExtensionAPI) {
  let activeWorkspace: CyberWorkspaceState | null = null;
  let lastCtx: ExtensionContext | null = null;
  const toolManager = new CyberToolManager(pi, TOOLS_CONFIG_PATH, {
    label: "逆向",
    toolCommandName: "reverse_tool",
    configHint: "extensions/reverse/tools.json",
  });

  const updateToolsStatusUI = (ctx: ExtensionContext) => {
    lastCtx = ctx;
    const text = formatToolsStatusIndicator(toolManager.getStatusList(), ctx.ui?.theme);
    ctx.ui.setStatus(TOOLS_STATUS_KEY, text);
  };

  const clearToolsStatusUI = (ctx?: ExtensionContext | null) => {
    ctx?.ui.setStatus(TOOLS_STATUS_KEY, undefined);
  };

  const syncWorkspace = (ctx: ExtensionContext) => {
    lastCtx = ctx;
    activeWorkspace = reconstructWorkspaceFromSession(ctx.sessionManager.getBranch());
    if (!activeWorkspace && isCyberWorkspaceDir(ctx.cwd)) {
      activeWorkspace = loadCyberWorkspaceFromDir(ctx.cwd);
    }
  };

  const buildToolRuntimeContext = (ctx: ExtensionContext): CyberToolRuntimeContext => {
    const manifest = activeWorkspace ? readManifest(activeWorkspace.workspaceDir) : null;
    const primary = manifest?.targets[manifest.targets.length - 1] ?? manifest?.targets[0];
    return {
      cwd: ctx.cwd,
      workspaceDir: activeWorkspace?.workspaceDir ?? ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      targetPath: primary?.path,
      targetName: primary?.name,
    };
  };

  const requireWorkspace = (): CyberWorkspaceState => {
    if (!activeWorkspace) {
      throw new Error("尚未绑定 Cyber 工作区。请先使用 `/cyber <任务名>` 或 `/reverse <目标路径>`。");
    }
    return activeWorkspace;
  };

  pi.events.on(CYBER_WORKSPACE_EVENT, (data) => {
    activeWorkspace = data as CyberWorkspaceState | null;
  });

  pi.events.on(CYBER_MODE_EVENT, (data) => {
    const nextMode = data as string | null;
    if (nextMode !== "reverse") {
      toolManager.stopAll();
      clearToolsStatusUI(lastCtx);
    } else if (lastCtx) {
      updateToolsStatusUI(lastCtx);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    syncWorkspace(ctx);
    if (activeWorkspace && activeWorkspace.workspaceDir === ctx.cwd) {
      const manifest = readManifest(activeWorkspace.workspaceDir);
      if (manifest?.activeMode === "reverse") {
        toolManager.autoLoad(buildToolRuntimeContext(ctx));
        updateToolsStatusUI(ctx);
      }
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    syncWorkspace(ctx);
  });

  pi.on("mcp_servers_change", async (_event, ctx) => {
    lastCtx = ctx;
    if (
      activeWorkspace?.workspaceDir === ctx.cwd ||
      toolManager.getStatusList().some((t) => t.mcpRegistered)
    ) {
      updateToolsStatusUI(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    toolManager.stopAll();
    clearToolsStatusUI(ctx);
    lastCtx = null;
  });

  registerModeModule(
    pi,
    CYBER_MODES.reverse,
    (api, modeCtx) => {
      api.registerTool({
        name: "reverse_add_target",
        label: "Add Reverse Target",
        description:
          "将待逆向的二进制文件或目录包复制到当前 Cyber 工作区的 targets/ 并登记，供逆向工具使用。",
        parameters: Type.Object({
          target_path: Type.String({
            description: "待逆向的二进制文件或目录包路径（支持绝对路径、相对路径或 ~/ 路径）",
          }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          if (!modeCtx.isActive()) {
            switchCyberMode(api, ctx, "reverse", {
              engagementName: activeWorkspace
                ? basename(activeWorkspace.workspaceDir)
                : undefined,
            });
          }
          const workspace = requireWorkspace();
          const summary = addTargetToWorkspace(workspace, params.target_path);
          toolManager.autoLoad(buildToolRuntimeContext(ctx));
          updateToolsStatusUI(ctx);
          return {
            content: [
              {
                type: "text",
                text: [
                  `已登记逆向目标:`,
                  `- 名称: ${summary.name}`,
                  `- 工作区副本: ${summary.path}`,
                  `- 原始路径: ${summary.sourcePath}`,
                  `- 类型: ${summary.kind}`,
                ].join("\n"),
              },
            ],
            details: summary,
          };
        },
      });

      api.registerTool({
        name: "reverse_tool",
        label: "Reverse Tool Lifecycle",
        description:
          "归一化管理插件配置的逆向工具（如 Ghidra、IDA Pro、radare2 等）：status / start / stop / reload。",
        parameters: Type.Object({
          action: Type.Union(
            [
              Type.Literal("status"),
              Type.Literal("start"),
              Type.Literal("stop"),
              Type.Literal("reload"),
            ],
            { description: "操作类型：status | start | stop | reload" },
          ),
          name: Type.Optional(
            Type.String({
              description: "工具名称（start / stop 时必填；status / reload 时可选）",
            }),
          ),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const runtimeCtx = buildToolRuntimeContext(ctx);
          let items: CyberToolStatusInfo[] = [];

          switch (params.action) {
            case "status":
              items = toolManager.getStatusList(params.name);
              break;
            case "start":
              if (!params.name) {
                throw new Error("action=start 时必须指定工具名称 name");
              }
              items = [toolManager.start(params.name, runtimeCtx)];
              break;
            case "stop":
              if (!params.name) {
                throw new Error("action=stop 时必须指定工具名称 name");
              }
              items = [toolManager.stop(params.name)];
              break;
            case "reload":
              items = toolManager.reload(runtimeCtx, params.name);
              break;
            default:
              throw new Error(`未知 action: ${String(params.action)}`);
          }

          updateToolsStatusUI(ctx);
          return {
            content: [{ type: "text", text: formatToolsStatusText(items) }],
            details: { tools: items },
          };
        },
      });

      api.registerCommand("reverse-tools", {
        description:
          "管理逆向工具 MCP 注入: /reverse-tools [status | start <name> | stop <name> | reload [name]]",
        handler: async (args, ctx) => {
          const [sub = "status", name] = args.trim().split(/\s+/);
          const runtimeCtx = buildToolRuntimeContext(ctx);
          try {
            if (sub === "status") {
              updateToolsStatusUI(ctx);
              ctx.ui.notify(formatToolsStatusText(toolManager.getStatusList(name)), "info");
            } else if (sub === "start" && name) {
              const info = toolManager.start(name, runtimeCtx);
              updateToolsStatusUI(ctx);
              ctx.ui.notify(`已启动并注入 MCP: ${info.name} (status=${info.status})`, "info");
            } else if (sub === "stop" && name) {
              const info = toolManager.stop(name);
              updateToolsStatusUI(ctx);
              ctx.ui.notify(`已停止并卸载 MCP: ${info.name} (status=${info.status})`, "info");
            } else if (sub === "reload") {
              const items = toolManager.reload(runtimeCtx, name);
              updateToolsStatusUI(ctx);
              ctx.ui.notify(`已重载逆向工具配置:\n${formatToolsStatusText(items)}`, "info");
            } else {
              ctx.ui.notify(
                "用法: /reverse-tools [status | start <name> | stop <name> | reload [name]]",
                "warning",
              );
            }
          } catch (error) {
            updateToolsStatusUI(ctx);
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`逆向工具操作失败: ${message}`, "error");
          }
        },
      });

      api.on("before_agent_start", async (event) => {
        if (!modeCtx.isActive()) return;

        event.systemPromptOptions.sections["reverse-tools"] = toolManager.formatPromptSection();

        if (activeWorkspace) {
          const manifest = readManifest(activeWorkspace.workspaceDir);
          const targets =
            manifest && manifest.targets.length > 0
              ? manifest.targets.map((t) => `- ${t.name}: ${t.path}`).join("\n")
              : "- (尚未登记目标，可用 `reverse_add_target` 或 `/reverse <路径>`)";

          event.systemPromptOptions.sections["reverse-workspace"] = [
            "当前处于「逆向工程」工作模式，已绑定统一 Cyber 工作区：",
            `- 工作区 (CWD): ${activeWorkspace.workspaceDir}`,
            `- 逆向产物目录: ${join(activeWorkspace.workspaceDir, "reverse")}`,
            `- 目标资产 (targets/):`,
            targets,
            "反编译脚本、符号笔记、报告等默认写入工作区（优先 reverse/ notes/ reports/）。",
          ].join("\n");
        } else {
          event.systemPromptOptions.sections["reverse-workspace"] = [
            "当前处于「逆向工程」工作模式，但尚未绑定 Cyber 工作区。",
            "请使用 `/cyber <任务名>` 创建工作区，或 `/reverse <二进制或包路径>` 自动创建工作区并登记目标。",
          ].join("\n");
        }
      });
    },
    {
      onCommand: async (args, ctx) => {
        const target = args.trim();
        syncWorkspace(ctx);

        if (!target) {
          toolManager.autoLoad(buildToolRuntimeContext(ctx));
          updateToolsStatusUI(ctx);
          if (activeWorkspace) {
            ctx.ui.notify(`当前 Cyber 工作区: ${activeWorkspace.workspaceDir}`, "info");
          } else {
            ctx.ui.notify(
              "提示: 可使用 `/cyber <任务名>` 创建工作区，或 `/reverse <二进制或包路径>` 创建工作区并登记目标",
              "info",
            );
          }
          return;
        }

        try {
          await ensureWorkspaceAndAddTarget(pi, ctx, target, (workspace) => {
            activeWorkspace = workspace;
            pi.events.emit(CYBER_WORKSPACE_EVENT, workspace);
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`登记逆向目标失败: ${message}`, "error");
        }
      },
    },
  );
}

async function ensureWorkspaceAndAddTarget(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  targetPath: string,
  onBound: (workspace: CyberWorkspaceState) => void,
): Promise<void> {
  let workspace =
    reconstructWorkspaceFromSession(ctx.sessionManager.getBranch()) ??
    (isCyberWorkspaceDir(ctx.cwd) ? loadCyberWorkspaceFromDir(ctx.cwd) : null);

  if (workspace && workspace.workspaceDir === ctx.cwd) {
    const summary = addTargetToWorkspace(workspace, targetPath);
    onBound(workspace);
    switchCyberMode(pi, ctx, "reverse", {
      engagementName: basename(workspace.workspaceDir),
    });
    ctx.ui.notify(
      `已登记逆向目标至当前工作区: ${summary.name} → ${summary.path}`,
      "info",
    );
    return;
  }

  const createdNew = !workspace;
  if (!workspace) {
    const baseName = sanitizeWorkspaceName(basename(targetPath.replace(/\/+$/, "") || "target"));
    workspace = createCyberWorkspace(ctx.cwd, baseName);
  }

  const summary = addTargetToWorkspace(workspace, targetPath);
  const migratedSessionFile = migrateSessionToWorkspace(ctx.sessionManager, workspace);
  const workspaceName = basename(workspace.workspaceDir);
  const workspaceDir = workspace.workspaceDir;
  const boundWorkspace = workspace;

  const result = await ctx.switchSession(migratedSessionFile, {
    withSession: async (newCtx: ExtensionCommandContext) => {
      onBound(boundWorkspace);
      switchCyberMode(pi, newCtx, "reverse", {
        engagementName: workspaceName,
        silent: true,
      });
      newCtx.ui.notify(
        createdNew
          ? `已创建 Cyber 工作区并登记逆向目标: ${summary.name}\n工作区: ${workspaceName} (${workspaceDir})`
          : `已登记逆向目标并切换至工作区: ${summary.name}\n工作区: ${workspaceName} (${workspaceDir})`,
        "info",
      );
    },
  });

  if (result.cancelled) {
    onBound(boundWorkspace);
    pi.appendEntry(CYBER_WORKSPACE_ENTRY_TYPE, boundWorkspace);
    switchCyberMode(pi, ctx, "reverse", {
      engagementName: workspaceName,
    });
    ctx.ui.notify("会话切换被取消，目标已登记但未切换会话", "warning");
  }
}
