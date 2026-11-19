import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** User-editable tool locations. Non-empty values override auto-detection. */
export function getToolPathsFile(): string {
  return join(getAgentDir(), "pi-cyber", "tool-paths.json");
}

function which(name: string): string {
  const found = spawnSync("which", [name], { encoding: "utf8" });
  if (found.status !== 0) return "";
  return found.stdout.trim().split("\n")[0]?.trim() ?? "";
}

function brewPrefix(formula: string): string {
  if (!which("brew")) return "";
  const found = spawnSync("brew", ["--prefix", formula], { encoding: "utf8" });
  if (found.status !== 0) return "";
  const prefix = found.stdout.trim();
  return prefix && existsSync(prefix) ? prefix : "";
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function newestMatch(dir: string, pattern: RegExp): string {
  if (!existsSync(dir)) return "";
  const names = readdirSync(dir).filter((name) => pattern.test(name)).sort();
  const name = names.at(-1);
  return name ? join(dir, name) : "";
}

function detectToolPaths(): Record<string, string> {
  const dataDir = join(getAgentDir(), "pi-cyber");
  const uv = which("uv");
  const uvx = which("uvx") || (uv ? join(dirname(uv), "uvx") : "");
  const javaHomeFromEnv = process.env.JAVA_HOME?.trim() ?? "";
  const javaHomeFromBrew = brewPrefix("openjdk@25");
  const javaHome =
    javaHomeFromEnv && existsSync(join(javaHomeFromEnv, "bin", "java"))
      ? javaHomeFromEnv
      : javaHomeFromBrew
        ? join(javaHomeFromBrew, "libexec/openjdk.jdk/Contents/Home")
        : "";
  const javaBin = javaHome && existsSync(join(javaHome, "bin", "java"))
    ? join(javaHome, "bin", "java")
    : which("java");
  const ghidraPrefix = brewPrefix("ghidra");
  const ghidraInstallDir = ghidraPrefix ? join(ghidraPrefix, "libexec") : "";
  const cargoMcp = join(homedir(), ".cargo", "bin", "rizin-mcp");
  const binDir = uv ? dirname(uv) : dirname(which("rizin") || which("java") || "/usr/bin/true");

  return {
    uv: uv || "uv",
    uvx: uvx || "uvx",
    javaHome,
    javaBin: javaBin || "java",
    binDir,
    ghidraInstallDir,
    ghidraMcpJar: existsSync(join(dataDir, "GhidraMCP.jar")) ? join(dataDir, "GhidraMCP.jar") : "",
    rizinBin: which("rizin"),
    rizinMcp: which("rizin-mcp") || (existsSync(cargoMcp) ? cargoMcp : ""),
    jadxJar: newestMatch(dataDir, /^jadx-headless-mcp-.*-all\.jar$/),
  };
}

function readUserPaths(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const paths: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") paths[key] = expandHome(value.trim());
    }
    return paths;
  } catch {
    return {};
  }
}

/**
 * Resolved tool paths. Values in `tool-paths.json` win; missing keys are detected.
 * The file is created on first use so it can be edited.
 */
export function resolveToolPaths(): Record<string, string> {
  const file = getToolPathsFile();
  const detected = detectToolPaths();
  const user = readUserPaths(file);
  const merged = { ...detected };
  for (const [key, value] of Object.entries(user)) {
    if (value) merged[key] = value;
  }

  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const seed: Record<string, string> = {};
    for (const key of Object.keys(detected)) seed[key] = merged[key] ?? "";
    writeFileSync(file, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
  }

  return merged;
}
