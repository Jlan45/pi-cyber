import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { showSearchSelect } from "./cyber-selector.ts";
import {
  formatEnvironmentSummary,
  type ExecutionEnvironment,
  type ResolvedExecution,
} from "./execution.ts";

const RUNTIME_SELECT_LIST_LAYOUT = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 28,
};

/** Sentinel value for the "add new environment" list item. */
export const RUNTIME_ADD_ACTION = "__add__";

export type RuntimeSelectorResult =
  | { action: "select"; name: string }
  | { action: "add" }
  | { action: "cancel" };

function envDescription(env: ExecutionEnvironment): string {
  if (env.type === "local") {
    return env.description?.trim() || "本机执行";
  }
  const auth = env.auth?.method ? `auth=${env.auth.method}` : "";
  const user = env.auth?.user ? `${env.auth.user}@` : "";
  const target = env.target.includes("@") ? env.target : `${user}${env.target}`;
  const port = env.port && env.port !== 22 ? `:${env.port}` : "";
  const cwd = env.remoteCwd ? `cwd=${env.remoteCwd}` : "";
  const bits = [`ssh ${target}${port}`, cwd, auth].filter(Boolean);
  const base = bits.join(" · ");
  return env.description?.trim() ? `${base} · ${env.description}` : base;
}

function buildItems(resolved: ResolvedExecution): SelectItem[] {
  const items: SelectItem[] = resolved.environments.map((env) => {
    const active = env.name === resolved.active;
    return {
      value: env.name,
      label: active ? `✓ ${env.name}` : `  ${env.name}`,
      description: envDescription(env),
    };
  });
  items.push({
    value: RUNTIME_ADD_ACTION,
    label: "+ 新增环境",
    description: "添加 SSH / local 执行环境",
  });
  return items;
}

function toResult(value: string | null | undefined): RuntimeSelectorResult {
  if (!value) return { action: "cancel" };
  if (value === RUNTIME_ADD_ACTION || value.startsWith("+ 新增")) {
    return { action: "add" };
  }
  const name = value.split(" — ")[0]?.replace(/ \(active\)$/, "").trim();
  if (!name || name === RUNTIME_ADD_ACTION) return { action: "cancel" };
  return { action: "select", name };
}

/**
 * Open a model-style runtime picker.
 */
export async function showRuntimeSelector(
  ctx: ExtensionContext,
  resolved: ResolvedExecution,
): Promise<RuntimeSelectorResult> {
  const items = buildItems(resolved);
  const fallbackLabels = [
    ...resolved.environments.map((e) =>
      e.name === resolved.active
        ? `${e.name} (active) — ${envDescription(e)}`
        : `${e.name} — ${envDescription(e)}`,
    ),
    "+ 新增环境 — 添加 SSH / local 执行环境",
  ];
  const value = await showSearchSelect(ctx, {
    title: "Select Runtime",
    subtitle: `当前: ${formatEnvironmentSummary(resolved.env)} [${resolved.source}]`,
    items,
    preselect: resolved.active,
    fallbackLabels,
    listLayout: RUNTIME_SELECT_LIST_LAYOUT,
  });
  return toResult(value);
}
