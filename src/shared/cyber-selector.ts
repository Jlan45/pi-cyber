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
import { basename } from "node:path";
import { CYBER_MODES, type CyberModeId, isCyberModeId } from "./mode.ts";
import type { CyberProjectInfo } from "./workspace.ts";

const SELECT_LIST_LAYOUT = {
  minPrimaryColumnWidth: 14,
  maxPrimaryColumnWidth: 36,
};

const CREATE_ACTION = "__create__";
const OFF_ACTION = "__off__";

export type CyberProjectChoice =
  | { action: "existing"; workspaceDir: string; name: string }
  | { action: "create" }
  | { action: "off" }
  | { action: "cancel" };

export type CyberModeChoice =
  | { action: "mode"; mode: CyberModeId }
  | { action: "cancel" };

class SearchSelectComponent extends Container implements Focusable {
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
    title: string,
    subtitle: string | undefined,
    items: SelectItem[],
    preselect: string | undefined,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.allItems = items;

    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(new Text(title, 0, 0));
    if (subtitle) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(subtitle, 0, 0));
    }
    this.addChild(new Spacer(1));

    this.searchInput = new Input();
    this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.selectList = this.buildSelectList(this.allItems, preselect);
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
      SELECT_LIST_LAYOUT,
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
      ? fuzzyFilter(this.allItems, query, (item) => `${item.value} ${item.label} ${item.description ?? ""}`)
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

async function showSearchSelect(
  ctx: ExtensionContext,
  options: {
    title: string;
    subtitle?: string;
    items: SelectItem[];
    preselect?: string;
    fallbackLabels: string[];
  },
): Promise<string | null> {
  if (ctx.mode !== "tui") {
    const picked = await ctx.ui.select(options.title, options.fallbackLabels);
    if (!picked) return null;
    // Prefer matching by leading token before " — "
    const token = picked.split(" — ")[0]?.replace(/^[✓*]\s*/, "").trim();
    const byLabel = options.items.find(
      (i) => i.label.trim() === picked || i.label.includes(token ?? ""),
    );
    if (byLabel) return byLabel.value;
    if (picked.includes("新建") || picked.startsWith("+")) return CREATE_ACTION;
    if (picked.includes("退出") || token === "off") return OFF_ACTION;
    return token || null;
  }

  return ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
    const component = new SearchSelectComponent(
      options.title,
      options.subtitle,
      options.items,
      options.preselect,
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
}

/**
 * Step 1: pick an engagement project (or create / off).
 */
export async function showCyberProjectSelector(
  ctx: ExtensionContext,
  projects: CyberProjectInfo[],
  options?: {
    currentWorkspaceDir?: string | null;
    modeActive?: boolean;
  },
): Promise<CyberProjectChoice> {
  const currentDir = options?.currentWorkspaceDir
    ? basename(options.currentWorkspaceDir)
    : undefined;

  const items: SelectItem[] = projects.map((p) => {
    const dirName = basename(p.workspaceDir);
    const isCurrent = options?.currentWorkspaceDir === p.workspaceDir;
    const mode = p.activeMode ? CYBER_MODES[p.activeMode].label : "无模式";
    return {
      value: p.workspaceDir,
      label: isCurrent ? `✓ ${dirName}` : `  ${dirName}`,
      description: `${p.name} · ${mode}`,
    };
  });

  items.push({
    value: CREATE_ACTION,
    label: "+ 新建项目",
    description: "创建新的 Cyber 工作区并迁移会话",
  });

  if (options?.modeActive) {
    items.push({
      value: OFF_ACTION,
      label: "  off",
      description: "退出当前工作模式（保留目录）",
    });
  }

  const subtitle = currentDir
    ? `当前: ${currentDir}`
    : projects.length === 0
      ? "尚未发现项目，可新建"
      : undefined;

  const value = await showSearchSelect(ctx, {
    title: "Select Cyber Project",
    subtitle,
    items,
    preselect: options?.currentWorkspaceDir ?? undefined,
    fallbackLabels: [
      ...projects.map((p) => {
        const dirName = basename(p.workspaceDir);
        const mode = p.activeMode ? CYBER_MODES[p.activeMode].label : "无模式";
        const mark = options?.currentWorkspaceDir === p.workspaceDir ? "✓ " : "";
        return `${mark}${dirName} — ${p.name} · ${mode}`;
      }),
      "+ 新建项目 — 创建新的 Cyber 工作区并迁移会话",
      ...(options?.modeActive ? ["off — 退出当前工作模式（保留目录）"] : []),
    ],
  });

  if (!value) return { action: "cancel" };
  if (value === CREATE_ACTION) return { action: "create" };
  if (value === OFF_ACTION) return { action: "off" };

  const project = projects.find((p) => p.workspaceDir === value);
  if (!project) return { action: "cancel" };
  return { action: "existing", workspaceDir: project.workspaceDir, name: project.name };
}

/**
 * Step 2: pick a working mode for the chosen project.
 */
export async function showCyberModeSelector(
  ctx: ExtensionContext,
  options?: {
    projectLabel?: string;
    currentMode?: CyberModeId | null;
  },
): Promise<CyberModeChoice> {
  const items: SelectItem[] = Object.values(CYBER_MODES).map((meta) => {
    const active = options?.currentMode === meta.id;
    return {
      value: meta.id,
      label: active ? `✓ ${meta.id}` : `  ${meta.id}`,
      description: `${meta.label} — ${meta.description}`,
    };
  });

  const value = await showSearchSelect(ctx, {
    title: "Select Cyber Mode",
    subtitle: options?.projectLabel ? `项目: ${options.projectLabel}` : undefined,
    items,
    preselect: options?.currentMode ?? undefined,
    fallbackLabels: Object.values(CYBER_MODES).map((meta) => {
      const mark = options?.currentMode === meta.id ? "✓ " : "";
      return `${mark}${meta.id} — ${meta.label} — ${meta.description}`;
    }),
  });

  if (!value || !isCyberModeId(value)) return { action: "cancel" };
  return { action: "mode", mode: value };
}
