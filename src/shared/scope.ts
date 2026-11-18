import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getScopePath } from "./workspace.ts";

export interface CyberScope {
  engagement: string;
  authorization: "explicit" | "assumed" | "unknown";
  in_scope: string[];
  out_of_scope: string[];
  notes: string;
}

export type ScopeCheckResult =
  | { ok: true; matchedBy?: string }
  | { ok: false; reason: string };

const DEFAULT_SCOPE = (engagement = ""): CyberScope => ({
  engagement,
  authorization: "explicit",
  in_scope: [],
  out_of_scope: [],
  notes: "",
});

/**
 * Loads scope.json from a cyber workspace; returns a default empty scope if missing/invalid.
 */
export function readScope(workspaceDir: string): CyberScope {
  const path = getScopePath(workspaceDir);
  if (!existsSync(path)) {
    return DEFAULT_SCOPE();
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CyberScope>;
    return {
      engagement: typeof parsed.engagement === "string" ? parsed.engagement : "",
      authorization:
        parsed.authorization === "assumed" || parsed.authorization === "unknown"
          ? parsed.authorization
          : "explicit",
      in_scope: Array.isArray(parsed.in_scope)
        ? parsed.in_scope.filter((x): x is string => typeof x === "string")
        : [],
      out_of_scope: Array.isArray(parsed.out_of_scope)
        ? parsed.out_of_scope.filter((x): x is string => typeof x === "string")
        : [],
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
    };
  } catch {
    return DEFAULT_SCOPE();
  }
}

export function writeScope(workspaceDir: string, scope: CyberScope): void {
  writeFileSync(getScopePath(workspaceDir), `${JSON.stringify(scope, null, 2)}\n`, "utf8");
}

/**
 * Extracts a hostname / IP-like token from a free-form target (URL, host:port, raw host).
 */
export function extractHost(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) return "";

  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
      return new URL(trimmed).hostname.toLowerCase();
    }
  } catch {
    // fall through
  }

  const withoutPath = trimmed.split("/")[0] ?? trimmed;
  const withoutPort = withoutPath.includes("]")
    ? withoutPath.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1")
    : withoutPath.replace(/:\d+$/, "");
  return withoutPort.toLowerCase();
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    value = (value << 8) + n;
  }
  return value >>> 0;
}

function matchCidr(host: string, cidr: string): boolean {
  const [network, bitsRaw] = cidr.split("/");
  if (!network || bitsRaw === undefined) return false;
  const hostInt = ipv4ToInt(host);
  const netInt = ipv4ToInt(network);
  const bits = Number(bitsRaw);
  if (hostInt === null || netInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (hostInt & mask) === (netInt & mask);
}

function matchPattern(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;

  if (p.includes("/")) {
    // CIDR or URL-like pattern
    if (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(p)) {
      return matchCidr(host, p);
    }
    const patternHost = extractHost(p);
    if (!patternHost) return false;
    return matchHostGlob(host, patternHost);
  }

  return matchHostGlob(host, p);
}

function matchHostGlob(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return host === pattern.slice(2) || host.endsWith(suffix);
  }
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(host);
  }
  return host === pattern;
}

/**
 * Checks whether a host/URL/IP is allowed by scope. Out-of-scope wins; empty in_scope denies all.
 */
export function checkScope(scope: CyberScope, target: string): ScopeCheckResult {
  const host = extractHost(target);
  if (!host) {
    return { ok: false, reason: "无法从目标中解析主机名或 IP" };
  }

  for (const pattern of scope.out_of_scope) {
    if (matchPattern(host, pattern) || matchPattern(target.toLowerCase(), pattern.toLowerCase())) {
      return { ok: false, reason: `目标 "${target}" 匹配 out_of_scope: ${pattern}` };
    }
  }

  if (scope.in_scope.length === 0) {
    return { ok: false, reason: "scope.json 的 in_scope 为空，请先配置授权范围" };
  }

  for (const pattern of scope.in_scope) {
    if (matchPattern(host, pattern) || matchPattern(target.toLowerCase(), pattern.toLowerCase())) {
      return { ok: true, matchedBy: pattern };
    }
  }

  return { ok: false, reason: `目标 "${target}" 不在 in_scope 内` };
}

export function isInScope(scope: CyberScope, target: string): boolean {
  return checkScope(scope, target).ok;
}

/**
 * Best-effort extraction of host-like tokens from a shell command for scope guardrails.
 */
export function extractHostsFromCommand(command: string): string[] {
  const found = new Set<string>();

  const urlRe = /https?:\/\/[^\s'"`]+/gi;
  for (const match of command.matchAll(urlRe)) {
    const host = extractHost(match[0]);
    if (host) found.add(host);
  }

  const hostRe =
    /(?:^|[\s"'`=])((?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?=[\s"'`/]|$)/g;
  for (const match of command.matchAll(hostRe)) {
    const host = extractHost(match[1]);
    if (host && !isLikelyLocalToken(host)) found.add(host);
  }

  return [...found];
}

function isLikelyLocalToken(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".local") ||
    host.endsWith(".md") ||
    host.endsWith(".json") ||
    host.endsWith(".ts") ||
    host.endsWith(".js")
  );
}

export function formatScopePromptSection(scope: CyberScope | null): string {
  if (!scope || (scope.in_scope.length === 0 && scope.out_of_scope.length === 0)) {
    return [
      "当前渗透范围尚未配置。",
      "请先调用 `pentest_set_scope` 写入 scope.json（in_scope / out_of_scope），确认授权后再开展信息收集与安全评估。",
      "所有探测目标必须落在 in_scope 内，且不得触碰 out_of_scope。",
    ].join("\n");
  }

  return [
    "当前渗透测试授权范围（scope.json）：",
    `- engagement: ${scope.engagement || "(未命名)"}`,
    `- authorization: ${scope.authorization}`,
    `- in_scope: ${scope.in_scope.length > 0 ? scope.in_scope.join(", ") : "(空)"}`,
    `- out_of_scope: ${scope.out_of_scope.length > 0 ? scope.out_of_scope.join(", ") : "(无)"}`,
    scope.notes ? `- notes: ${scope.notes}` : "- notes: (无)",
    "工作流：授权确认 → 信息收集 → 漏洞验证/安全评估 → 证据与报告落盘（notes/ evidence/ reports/ pentest/）。",
    "严禁对 out_of_scope 或未授权目标进行探测；产物以评估与复现说明为主。",
  ].join("\n");
}
