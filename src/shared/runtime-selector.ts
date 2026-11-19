import {
  DynamicBorder,
  getSelectListTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  SelectList,
  Spacer,
  Text,
  type Focusable,
  type SelectItem,
} from "@earendil-works/pi-tui";
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

/**
 * Searchable SelectList UI matching Pi thinking / model selector chrome.
 */
class RuntimeSelectorComponent extends Container implements Focusable {
  private searchInput: Input;
  private selectList: SelectList;
  private selectListChildIndex: number;
  private allItems: SelectItem[];
  private onSelect: (value: string) => void;
  private onCancel: () => void;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    resolved: ResolvedExecution,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.allItems = buildItems(resolved);

    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(new Text("Select Runtime", 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        `当前: ${formatEnvironmentSummary(resolved.env)} [${resolved.source}]`,
        0,
        0,
      ),
    );
    this.addChild(new Spacer(1));

    this.searchInput = new Input();
    this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.selectList = this.buildSelectList(this.allItems, resolved.active);
    this.selectListChildIndex = this.children.length;
    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
    this.addChild(new Text("  enter 选择 · esc 取消 · 输入可搜索", 0, 0));
    this.addChild(new DynamicBorder());
  }

  private buildSelectList(items: SelectItem[], preselect: string | undefined): SelectList {
    const list = new SelectList(
      items,
      Math.min(Math.max(1, items.length), 12),
      getSelectListTheme(),
      RUNTIME_SELECT_LIST_LAYOUT,
    );
    const currentIndex = items.findIndex((item) => item.value === preselect);
    if (currentIndex !== -1) {
      list.setSelectedIndex(currentIndex);
    }
    list.onSelect = (item) => this.onSelect(item.value);
    list.onCancel = () => this.onCancel();
    return list;
  }

  private applyFilter(query: string): void {
    const filtered = query
      ? fuzzyFilter(this.allItems, query, (item) => `${item.value} ${item.description ?? ""}`)
      : this.allItems;
    const selectedValue = this.selectList.getSelectedItem()?.value;
    const newList = this.buildSelectList(filtered, selectedValue);
    this.children[this.selectListChildIndex] = newList;
    this.selectList = newList;
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    const isNav =
      kb.matches(keyData, "tui.select.up") ||
      kb.matches(keyData, "tui.select.down") ||
      kb.matches(keyData, "tui.select.pageUp") ||
      kb.matches(keyData, "tui.select.pageDown") ||
      kb.matches(keyData, "tui.select.confirm") ||
      kb.matches(keyData, "tui.select.cancel");
    if (isNav) {
      this.selectList.handleInput(keyData);
      return;
    }
    this.searchInput.handleInput(keyData);
    this.applyFilter(this.searchInput.getValue());
  }

  getSelectList(): SelectList {
    return this.selectList;
  }
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
  if (ctx.mode !== "tui") {
    const labels = [
      ...resolved.environments.map((e) =>
        e.name === resolved.active
          ? `${e.name} (active) — ${envDescription(e)}`
          : `${e.name} — ${envDescription(e)}`,
      ),
      "+ 新增环境 — 添加 SSH / local 执行环境",
    ];
    const picked = await ctx.ui.select("Select Runtime", labels);
    return toResult(picked);
  }

  const value = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
    const component = new RuntimeSelectorComponent(
      resolved,
      (v) => done(v),
      () => done(null),
    );
    component.focused = true;
    return {
      capturesViewportInput: component.getSelectList().capturesViewportInput,
      render(width: number) {
        return component.render(width);
      },
      invalidate() {
        component.invalidate();
      },
      handleInput(data: string) {
        component.handleInput(data);
        tui.requestRender();
      },
    };
  });

  return toResult(value);
}
