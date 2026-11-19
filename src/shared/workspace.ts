import { randomUUID } from "node:crypto";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  type CustomEntry,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { CyberModeId } from "./mode.ts";

/** Minimal session reader used when migrating an existing session into a workspace. */
export type SessionReader = Pick<
  SessionManager,
  "getSessionFile" | "getLeafId" | "getEntries"
>;

export const CYBER_WORKSPACE_ENTRY_TYPE = "pi-cyber:workspace";

export const CYBER_WORKSPACE_SUBDIRS = [
  "targets",
  "notes",
  "evidence",
  "reports",
  "pentest",
  "reverse",
  "attribution",
  "remediation",
] as const;

export interface CyberTargetSummary {
  name: string;
  path: string;
  kind: "file" | "directory";
  sourcePath?: string;
  addedAt: string;
}

export interface CyberManifest {
  id: string;
  name: string;
  createdAt: string;
  activeMode: CyberModeId | null;
  targets: CyberTargetSummary[];
}

export interface CyberWorkspaceState {
  rootCwd: string;
  workspaceDir: string;
  engagementName: string;
  createdAt: string;
}

export function formatLocalDateTag(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function sanitizeWorkspaceName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "engagement";
}

export function normalizeInputPath(rawPath: string, baseCwd: string): string {
  const trimmed = rawPath.trim().replace(/^(['"])(.*)\1$/, "$2");
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith(`~${sep}`)) {
    return join(homedir(), trimmed.slice(2));
  }
  return resolve(baseCwd, trimmed);
}

function allocateWorkspaceDir(rootCwd: string, baseName: string, dateTag: string): string {
  const prefix = `${baseName}-${dateTag}`;
  let candidate = join(rootCwd, prefix);
  let suffix = 2;
  while (existsSync(candidate)) {
    candidate = join(rootCwd, `${prefix}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

export function getManifestPath(workspaceDir: string): string {
  return join(workspaceDir, ".cyber", "manifest.json");
}

export function getScopePath(workspaceDir: string): string {
  return join(workspaceDir, "scope.json");
}

export function getTargetsDir(workspaceDir: string): string {
  return join(workspaceDir, "targets");
}

/**
 * Returns true when `dir` looks like a pi-cyber engagement workspace (has `.cyber/manifest.json`).
 */
export function isCyberWorkspaceDir(dir: string): boolean {
  return existsSync(getManifestPath(dir));
}

export function readManifest(workspaceDir: string): CyberManifest | null {
  const path = getManifestPath(workspaceDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CyberManifest;
  } catch {
    return null;
  }
}

export function writeManifest(workspaceDir: string, manifest: CyberManifest): void {
  const dir = join(workspaceDir, ".cyber");
  mkdirSync(dir, { recursive: true });
  writeFileSync(getManifestPath(workspaceDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function updateManifestActiveMode(
  workspaceDir: string,
  mode: CyberModeId | null,
): CyberManifest | null {
  const manifest = readManifest(workspaceDir);
  if (!manifest) return null;
  manifest.activeMode = mode;
  writeManifest(workspaceDir, manifest);
  return manifest;
}

function ensureWorkspaceLayout(workspaceDir: string): void {
  mkdirSync(join(workspaceDir, ".cyber"), { recursive: true });
  for (const sub of CYBER_WORKSPACE_SUBDIRS) {
    mkdirSync(join(workspaceDir, sub), { recursive: true });
  }
}

/**
 * Creates a `<name>-<YYYYMMDD>` engagement workspace under `rootCwd` with standard layout.
 */
export function createCyberWorkspace(
  rootCwd: string,
  engagementName: string,
  now: Date = new Date(),
): CyberWorkspaceState {
  const trimmed = engagementName.trim();
  if (!trimmed) {
    throw new Error("请提供工作区/任务名称");
  }

  const safeName = sanitizeWorkspaceName(trimmed);
  const dateTag = formatLocalDateTag(now);
  const workspaceDir = allocateWorkspaceDir(rootCwd, safeName, dateTag);
  const createdAt = now.toISOString();

  ensureWorkspaceLayout(workspaceDir);

  const manifest: CyberManifest = {
    id: randomUUID().slice(0, 8),
    name: safeName,
    createdAt,
    activeMode: null,
    targets: [],
  };
  writeManifest(workspaceDir, manifest);

  writeFileSync(
    getScopePath(workspaceDir),
    `${JSON.stringify(
      {
        engagement: safeName,
        authorization: "explicit",
        in_scope: [],
        out_of_scope: [],
        notes: "",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    rootCwd,
    workspaceDir,
    engagementName: safeName,
    createdAt,
  };
}

/**
 * Copies a local file/directory into `targets/` and updates the workspace manifest.
 */
export function addTargetToWorkspace(
  workspace: CyberWorkspaceState,
  rawTargetPath: string,
  now: Date = new Date(),
): CyberTargetSummary {
  const sourcePath = normalizeInputPath(rawTargetPath, workspace.rootCwd);
  if (!existsSync(sourcePath)) {
    throw new Error(`目标路径不存在: ${sourcePath}`);
  }

  const stats = statSync(sourcePath);
  const kind: "file" | "directory" = stats.isDirectory() ? "directory" : "file";
  const targetEntryName = basename(sourcePath);
  const targetsDir = getTargetsDir(workspace.workspaceDir);
  mkdirSync(targetsDir, { recursive: true });

  let copiedPath = join(targetsDir, targetEntryName);
  if (existsSync(copiedPath)) {
    const parsed = parse(targetEntryName);
    let suffix = 2;
    while (existsSync(copiedPath)) {
      const nextName =
        kind === "directory" || !parsed.ext
          ? `${targetEntryName}-${suffix}`
          : `${parsed.name}-${suffix}${parsed.ext}`;
      copiedPath = join(targetsDir, nextName);
      suffix += 1;
    }
  }

  const destName = basename(copiedPath);
  if (kind === "directory") {
    cpSync(sourcePath, copiedPath, {
      recursive: true,
      filter: (src) =>
        src !== workspace.workspaceDir && !src.startsWith(`${workspace.workspaceDir}${sep}`),
    });
  } else {
    copyFileSync(sourcePath, copiedPath);
  }

  const summary: CyberTargetSummary = {
    name: destName,
    path: copiedPath,
    kind,
    sourcePath,
    addedAt: now.toISOString(),
  };

  const manifest = readManifest(workspace.workspaceDir);
  if (manifest) {
    manifest.targets.push(summary);
    writeManifest(workspace.workspaceDir, manifest);
  }

  return summary;
}

/**
 * Loads CyberWorkspaceState from an existing engagement directory (or null if not a cyber workspace).
 */
export function loadCyberWorkspaceFromDir(
  workspaceDir: string,
  rootCwd?: string,
): CyberWorkspaceState | null {
  const manifest = readManifest(workspaceDir);
  if (!manifest) return null;
  return {
    rootCwd: rootCwd ?? workspaceDir,
    workspaceDir,
    engagementName: manifest.name,
    createdAt: manifest.createdAt,
  };
}

export interface CyberProjectInfo {
  workspaceDir: string;
  name: string;
  activeMode: CyberModeId | null;
  createdAt: string;
  mtimeMs: number;
}

/**
 * Lists Cyber engagement projects under `rootCwd` (immediate children with `.cyber/manifest.json`).
 * If `rootCwd` itself is a workspace, includes it and sibling workspaces under its parent.
 */
export function listCyberProjects(rootCwd: string): CyberProjectInfo[] {
  const results: CyberProjectInfo[] = [];
  const seen = new Set<string>();

  const tryAdd = (dir: string) => {
    const resolved = resolve(dir);
    if (seen.has(resolved)) return;
    const manifest = readManifest(resolved);
    if (!manifest) return;
    seen.add(resolved);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(getManifestPath(resolved)).mtimeMs;
    } catch {
      // ignore
    }
    results.push({
      workspaceDir: resolved,
      name: manifest.name,
      activeMode: manifest.activeMode,
      createdAt: manifest.createdAt,
      mtimeMs,
    });
  };

  const scanChildren = (parent: string) => {
    try {
      for (const name of readdirSync(parent)) {
        if (name.startsWith(".")) continue;
        tryAdd(join(parent, name));
      }
    } catch {
      // ignore unreadable dirs
    }
  };

  if (isCyberWorkspaceDir(rootCwd)) {
    tryAdd(rootCwd);
    scanChildren(dirname(rootCwd));
  } else {
    scanChildren(rootCwd);
  }

  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Reconstructs the latest CyberWorkspaceState from session custom entries.
 */
export function reconstructWorkspaceFromSession(
  entries: Iterable<{ type: string; customType?: string; data?: unknown }>,
): CyberWorkspaceState | null {
  let found: CyberWorkspaceState | null = null;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === CYBER_WORKSPACE_ENTRY_TYPE) {
      found = (entry.data as CyberWorkspaceState | undefined) ?? null;
    }
  }
  return found;
}

/**
 * Resolves a tool path argument against `workspaceDir` when relative or omitted; preserves absolute paths.
 */
export function resolvePathInWorkspace(workspaceDir: string, inputPath?: string): string {
  if (!inputPath || !inputPath.trim()) {
    return workspaceDir;
  }
  return isAbsolute(inputPath) ? inputPath : resolve(workspaceDir, inputPath);
}

/**
 * Quotes a filesystem path safely for POSIX `sh`/`bash` commands.
 */
export function quoteShellPath(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Formats a short human-readable workspace summary for notifications / tool results.
 */
export function formatWorkspaceSummary(ws: CyberWorkspaceState): string {
  const manifest = readManifest(ws.workspaceDir);
  const targetLines =
    manifest && manifest.targets.length > 0
      ? manifest.targets.map((t) => `  - ${t.name} (${t.kind})`).join("\n")
      : "  (无)";

  return [
    `Cyber 工作区已就绪:`,
    `- 工作区目录: ${ws.workspaceDir}`,
    `- 任务名称: ${ws.engagementName}`,
    `- 根目录: ${ws.rootCwd}`,
    `- 目标资产:`,
    targetLines,
  ].join("\n");
}

/**
 * Prompt section describing the shared engagement workspace layout.
 */
export function formatWorkspacePromptSection(ws: CyberWorkspaceState): string {
  const manifest = readManifest(ws.workspaceDir);
  const modeLabel = manifest?.activeMode ?? "未设置";
  const targets =
    manifest && manifest.targets.length > 0
      ? manifest.targets.map((t) => `- ${t.name}: ${t.path}`).join("\n")
      : "- (尚未登记目标资产)";

  return [
    "当前处于统一 Cyber 工作区（一次任务/同一目标的上下文边界）：",
    `- 工作区 (CWD): ${ws.workspaceDir}`,
    `- 任务名称: ${ws.engagementName}`,
    `- 当前模式: ${modeLabel}`,
    `- 目录约定: targets/ notes/ evidence/ reports/ pentest/ reverse/ attribution/ remediation/`,
    `- 范围文件: scope.json`,
    "已登记目标:",
    targets,
    "所有相对路径读写、命令执行与分析产物默认在该工作区内进行；切换模式不更换目录。",
  ].join("\n");
}

/**
 * Copies the current session's full entry tree into a new session file bound to `workspace.workspaceDir`.
 */
export function migrateSessionToWorkspace(
  sourceSessionManager: SessionReader,
  workspace: CyberWorkspaceState,
): string {
  const parentSession = sourceSessionManager.getSessionFile() ?? undefined;
  const targetSm = SessionManager.create(workspace.workspaceDir, undefined, {
    parentSession,
  });
  const targetSessionFile = targetSm.getSessionFile();
  const targetHeader = targetSm.getHeader();

  if (!targetSessionFile || !targetHeader) {
    throw new Error("无法创建目标工作区的会话文件");
  }

  const existingEntries: SessionEntry[] = sourceSessionManager.getEntries();
  const workspaceEntry: CustomEntry<CyberWorkspaceState> = {
    type: "custom",
    id: randomUUID().slice(0, 8),
    parentId: sourceSessionManager.getLeafId(),
    timestamp: new Date().toISOString(),
    customType: CYBER_WORKSPACE_ENTRY_TYPE,
    data: workspace,
  };

  const lines = [
    JSON.stringify(targetHeader),
    ...existingEntries.map((entry) => JSON.stringify(entry)),
    JSON.stringify(workspaceEntry),
  ];

  writeFileSync(targetSessionFile, `${lines.join("\n")}\n`, "utf8");
  return targetSessionFile;
}
