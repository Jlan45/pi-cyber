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
import { playCyberEnterAnimation } from "../../src/shared/enter-animation.ts";
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
  updateManifestActiveMode,
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
    // Registration is not connection — wait for Pi to finish connect/fail, then sync lights.
    toolManager.scheduleReconcile(() => {
      if (lastCtx) updateToolsStatusUI(lastCtx);
    });
    updateToolsStatusUI(ctx);
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
            await switchCyberMode(api, ctx, "reverse", {
              engagementName: activeWorkspace
                ? basename(activeWorkspace.workspaceDir)
                : undefined,
              skipAnimation: true,
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
          "归一化管理插件配置的逆向工具（如 Ghidra、IDA Pro、Rizin 等）：status / start / stop / reload。",
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

      let ghidraNotReady = false;
      let ghidraAutoResumeSent = false;
      let ghidraWaitInProgress = false;

      const GHIDRA_PROBE_TOOL = "mcp__ghidra__get_program_info";

      const textOf = (content: { type: string; text?: string }[]): string =>
        content
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text ?? "")
          .join("\n");

      const looksNotReady = (text: string): boolean =>
        /NOT_READY|\(analyzing\)|still analyzing/i.test(text);

      const sleep = (ms: number, signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, ms);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });

      api.registerTool({
        name: "ghidra_wait_ready",
        label: "Wait Ghidra Analysis",
        description:
          "阻塞等待当前 Ghidra headless 初步自动分析完成。遇到 MCP [NOT_READY]/analyzing 时调用一次；完成后返回 get_program_info。不要改让用户干等。",
        parameters: Type.Object({
          timeout_sec: Type.Optional(
            Type.Number({
              description: "最长等待秒数，默认 1800，最大 3600",
              minimum: 30,
              maximum: 3600,
            }),
          ),
        }),
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          if (!modeCtx.isActive()) {
            throw new Error("请先进入逆向模式（/reverse）并启动 ghidra MCP。");
          }
          const timeoutMs = Math.min(Math.max((params.timeout_sec ?? 1800) * 1000, 30_000), 3_600_000);
          const started = Date.now();
          let interval = 8_000;
          ghidraWaitInProgress = true;
          try {
            const probeName =
              ctx.tools?.find((tool) => tool.name === GHIDRA_PROBE_TOOL)?.name ??
              ctx.tools?.find(
                (tool) =>
                  tool.name.startsWith("mcp__ghidra__") && tool.name.includes("get_program_info"),
              )?.name ??
              GHIDRA_PROBE_TOOL;

            while (Date.now() - started < timeoutMs) {
              if (signal?.aborted) throw new Error("aborted");
              const outcome = await ctx.executeTool(probeName, {});
              const text = textOf(outcome.result?.content ?? []);
              const missing =
                outcome.isError &&
                /unknown tool|disabled|no longer available|still starting/i.test(text);
              if (missing) {
                throw new Error("Ghidra MCP 未就绪。请先 /reverse-tools start ghidra（需已登记 target）。");
              }
              if (text && !looksNotReady(text) && !outcome.isError) {
                ghidraNotReady = false;
                ghidraAutoResumeSent = false;
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `Ghidra 初步分析已完成（等待 ${Math.round((Date.now() - started) / 1000)}s）。\n${text}`,
                    },
                  ],
                  details: { ready: true, elapsedMs: Date.now() - started },
                };
              }
              const elapsed = Math.round((Date.now() - started) / 1000);
              onUpdate?.({
                content: [{ type: "text", text: `Ghidra 分析中… ${elapsed}s` }],
                details: { ready: false, elapsedMs: Date.now() - started },
              });
              await sleep(interval, signal);
              interval = Math.min(interval + 2_000, 20_000);
            }
            throw new Error(
              `等待 Ghidra 初步分析超时（${Math.round(timeoutMs / 1000)}s）。可再次调用 ghidra_wait_ready。`,
            );
          } finally {
            ghidraWaitInProgress = false;
          }
        },
      });

      api.on("tool_result", async (event) => {
        if (!modeCtx.isActive()) return;
        if (!event.toolName.startsWith("mcp__ghidra__")) return;
        const text = textOf(event.content);
        if (!looksNotReady(text)) return;
        ghidraNotReady = true;
        ghidraAutoResumeSent = false;
        return {
          content: [
            ...event.content,
            {
              type: "text" as const,
              text: "\n[pi-cyber] 分析尚未完成。请立刻调用 ghidra_wait_ready，不要结束本回合，也不要询问用户是否继续。",
            },
          ],
        };
      });

      api.on("agent_end", async () => {
        if (!modeCtx.isActive()) return;
        if (!ghidraNotReady || ghidraAutoResumeSent || ghidraWaitInProgress) return;
        ghidraAutoResumeSent = true;
        pi.sendUserMessage(
          "Ghidra 仍在自动分析。请调用 ghidra_wait_ready 直到初步分析完成，然后从上次中断处继续逆向，不要再向用户确认。",
          { deliverAs: "followUp" },
        );
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

        event.systemPromptOptions.sections["reverse-tools"] = [
          toolManager.formatPromptSection(),
          "",
          "Ghidra MCP 就绪约定：",
          "- 返回 `[NOT_READY] ... (analyzing)` 时，立刻调用一次 `ghidra_wait_ready`，不要向用户询问是否继续，也不要自己空转轮询。",
          "- `ghidra_wait_ready` 会阻塞到初步分析完成（或超时）再返回；返回后再调用 get_program_info / decompile。",
          "- 若本回合已经结束，插件会自动发起下一回合，要求调用 `ghidra_wait_ready` 后继续。",
          "- 工程目录持久化在 `.cyber-tools/ghidra/projects/<targetName>/`；同一样本再次启动通常可复用已分析结果。",
          "按样本类型选择 MCP（都需先 `/reverse-tools start <name>`，默认不自动启动）：",
          "- 原生二进制（ELF/PE/Mach-O）：ghidra、rizin 或 ida-pro。ida-pro 是官方 Hex-Rays MCP，启动时已打开样本；用 reference 查 API，用 execute_python 做反编译，不要找社区版的 decompile 工具。",
          "- Android APK：apk 看 smali/manifest/资源；jadx 看 Java 反编译（启动后调用 load_apk，path 传 APK）。",
          "- iOS IPA 或 .app：ipa。用 parse_ipa_tool 或 full_static_analysis，参数 path 传目标路径。",
        ].join("\n");

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
      // Outside an existing cyber cwd, /reverse <path> will switchSession — defer boot animation
      // until withSession on the fresh ctx. Inside a workspace, animate on the normal mode switch.
      resolveSwitchOptions: (args, ctx) =>
        args.trim() && !isCyberWorkspaceDir(ctx.cwd) ? { skipAnimation: true } : undefined,
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
          try {
            ctx.ui.notify(`登记逆向目标失败: ${message}`, "error");
          } catch {
            /* ignore stale ctx after successful switchSession */
          }
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
    await switchCyberMode(pi, ctx, "reverse", {
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
  // Persist mode on disk so the replacement session_start restores it.
  // Do not call switchCyberMode / pi.* inside withSession — old pi is stale.
  updateManifestActiveMode(workspace.workspaceDir, "reverse");
  const migratedSessionFile = migrateSessionToWorkspace(ctx.sessionManager, workspace);
  const workspaceName = basename(workspace.workspaceDir);
  const workspaceDir = workspace.workspaceDir;
  const boundWorkspace = workspace;

  const result = await ctx.switchSession(migratedSessionFile, {
    withSession: async (newCtx: ExtensionCommandContext) => {
      try {
        await playCyberEnterAnimation(newCtx, "reverse", workspaceName);
      } catch {
        /* animation must not fail the handoff */
      }
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
    await switchCyberMode(pi, ctx, "reverse", {
      engagementName: workspaceName,
    });
    ctx.ui.notify("会话切换被取消，目标已登记但未切换会话", "warning");
  }
}
