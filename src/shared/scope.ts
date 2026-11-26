import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isIPv6 } from "node:net";
import { getScopePath } from "./workspace.ts";

export interface CyberScope {
  engagement: string;
  authorization: "explicit" | "assumed" | "unknown";
  in_scope: string[];
  out_of_scope: string[];
  notes: string;
  /**
   * Hosts the guard never blocks: package mirrors, github, tool download sites. They are not
   * targets. Edit scope.json by hand; `pentest_set_scope` keeps the list as it is.
   */
  allow_always?: string[];
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
      ...(Array.isArray(parsed.allow_always)
        ? {
            allow_always: parsed.allow_always.filter((x): x is string => typeof x === "string"),
          }
        : {}),
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
function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function extractHost(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) return "";

  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
      return stripBrackets(new URL(trimmed).hostname.toLowerCase());
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

interface Cidr {
  base: number;
  bits: number;
}

function parseCidr(value: string): Cidr | null {
  const m = value.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!m) return null;
  const base = ipv4ToInt(m[1]!);
  const bits = Number(m[2]);
  if (base === null || bits < 0 || bits > 32) return null;
  return { base: (base & maskOf(bits)) >>> 0, bits };
}

function maskOf(bits: number): number {
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

/** Pattern from scope as an IPv4 range: a bare IP is /32. */
function patternRange(pattern: string): Cidr | null {
  const p = pattern.trim();
  const cidr = parseCidr(p);
  if (cidr) return cidr;
  const ip = ipv4ToInt(p);
  return ip === null ? null : { base: ip, bits: 32 };
}

function cidrContains(outer: Cidr, inner: Cidr): boolean {
  return outer.bits <= inner.bits && ((inner.base & maskOf(outer.bits)) >>> 0) === outer.base;
}

function cidrOverlaps(a: Cidr, b: Cidr): boolean {
  return cidrContains(a, b) || cidrContains(b, a);
}

function matchCidr(host: string, cidr: string): boolean {
  const range = parseCidr(cidr);
  const hostInt = ipv4ToInt(host);
  if (!range || hostInt === null) return false;
  return cidrContains(range, { base: hostInt, bits: 32 });
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
 * Checks whether a host/URL/IP/CIDR is allowed by scope. Out-of-scope wins; empty in_scope denies all.
 * A CIDR target is only allowed when the whole range sits inside one in_scope entry, and is denied
 * when it overlaps any out_of_scope IP/CIDR.
 */
export function checkScope(scope: CyberScope, target: string): ScopeCheckResult {
  const cidrTarget = parseCidr(target);
  if (cidrTarget) return checkCidrScope(scope, target.trim(), cidrTarget);

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

function checkCidrScope(scope: CyberScope, label: string, target: Cidr): ScopeCheckResult {
  for (const pattern of scope.out_of_scope) {
    const range = patternRange(pattern);
    if (range && cidrOverlaps(range, target)) {
      return { ok: false, reason: `网段 "${label}" 与 out_of_scope 重叠: ${pattern}` };
    }
  }
  if (scope.in_scope.length === 0) {
    return { ok: false, reason: "scope.json 的 in_scope 为空，请先配置授权范围" };
  }
  for (const pattern of scope.in_scope) {
    const range = patternRange(pattern);
    if (range && cidrContains(range, target)) return { ok: true, matchedBy: pattern };
  }
  return { ok: false, reason: `网段 "${label}" 没有完整落在任何一条 in_scope 内` };
}

export function isInScope(scope: CyberScope, target: string): boolean {
  return checkScope(scope, target).ok;
}

/**
 * Last labels that are really file extensions. Hosts ending in these are treated as file names,
 * not targets. A few collide with country TLDs (.py .sh .md .rs .so); a host on those is still
 * checked when written as a URL (http://x.sh/).
 */
const FILE_EXTENSIONS = new Set([
  "py", "pyc", "sh", "bash", "zsh", "md", "txt", "json", "jsonl", "ts", "tsx", "js", "mjs", "cjs",
  "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "html", "htm", "css", "csv", "tsv",
  "log", "out", "err", "lst", "list", "dic", "wl", "tmp", "bak", "old", "sample", "lock",
  "php", "asp", "aspx", "jsp", "pl", "rb", "go", "rs", "c", "h", "cc", "cpp", "java", "class", "jar",
  "so", "dll", "dylib", "exe", "bin", "elf", "o", "a", "apk", "ipa", "dex", "zip", "gz", "tgz", "bz2",
  "xz", "7z", "rar", "tar", "png", "jpg", "jpeg", "gif", "svg", "pdf", "doc", "docx", "xls", "xlsx",
  "ppt", "pptx", "db", "sqlite", "sql", "pem", "key", "crt", "cer", "pcap", "pcapng", "nmap", "gnmap",
  "xmlx", "gpg", "asc", "sig", "diff", "patch", "ps1", "bat", "cmd", "swift", "kt", "smali",
]);

function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

function isFileLike(host: string): boolean {
  const tld = host.split(".").pop() ?? "";
  return FILE_EXTENSIONS.has(tld);
}

/**
 * Best-effort extraction of network targets from a shell command for scope guardrails.
 * Returns hostnames, IPv4/IPv6 addresses, CIDR blocks (as `a.b.c.d/n`) and both ends of IPv4 ranges
 * (`a.b.c.d-e`). Loopback and file-looking tokens are skipped. Shell variables and command
 * substitution cannot be resolved and are not seen.
 */
export function extractHostsFromCommand(command: string): string[] {
  const found = new Set<string>();
  const add = (host: string) => {
    const h = host.toLowerCase();
    if (h && !isLoopback(h)) found.add(h);
  };
  let rest = command;
  const mask = (re: RegExp, onMatch: (m: RegExpMatchArray) => void) => {
    rest = rest.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpMatchArray;
      onMatch(m);
      return " ".repeat(String(args[0]).length);
    });
  };

  // URLs first (scheme makes the host unambiguous, even for .py/.sh TLDs).
  mask(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"`<>|;&)]+/g, (m) => add(extractHost(m[0])));

  // user@host (ssh, scp, rsync): the part after @ is a target even if it looks like a file.
  mask(/(?<=[\s"'`]|^)[\w.-]+@((?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}|(?:\d{1,3}\.){3}\d{1,3})(?::[^\s]*)?/g, (m) =>
    add(m[1]!),
  );

  // IPv4 ranges: a.b.c.d-e, a.b.c.d-w.x.y.z
  mask(/(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})-(\d{1,3}(?:\.\d{1,3}){0,3})(?![\w.])/g, (m) => {
    const start = m[1]!;
    const endRaw = m[2]!;
    add(start);
    const endParts = endRaw.split(".");
    const startParts = start.split(".");
    add([...startParts.slice(0, 4 - endParts.length), ...endParts].join("."));
  });

  // CIDR blocks.
  mask(/(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})(?![\w.])/g, (m) => {
    if (parseCidr(m[1]!)) found.add(m[1]!);
  });

  // IPv6 literals (validated, so times like 12:30:45 are ignored).
  mask(/(?<![\w:.])\[?((?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4})\]?(?![\w:.])/g, (m) => {
    if (isIPv6(m[1]!)) add(m[1]!);
  });

  // Plain IPv4 and hostnames. Tokens preceded by `/` are paths (evidence/scan.nmap), not hosts.
  const hostRe =
    /(?<![\w.\/-])((?:\d{1,3}\.){3}\d{1,3}|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})(?::\d+)?(?![\w-])(?!\.[a-zA-Z0-9])/g;
  for (const match of rest.matchAll(hostRe)) {
    const host = match[1]!.toLowerCase();
    if (/^\d/.test(host)) {
      if (ipv4ToInt(host) !== null) add(host);
      continue;
    }
    if (!isFileLike(host)) add(host);
  }

  return [...found];
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
