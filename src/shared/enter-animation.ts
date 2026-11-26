import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CYBER_MODES, type CyberModeId } from "./mode.ts";

const LOGO = [
  " ██████╗██╗   ██╗██████╗ ███████╗██████╗ ",
  "██╔════╝╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗",
  "██║      ╚████╔╝ ██████╔╝█████╗  ██████╔╝",
  "██║       ╚██╔╝  ██╔══██╗██╔══╝  ██╔══██╗",
  "╚██████╗   ██║   ██████╔╝███████╗██║  ██║",
  " ╚═════╝   ╚═╝   ╚═════╝ ╚══════╝╚═╝  ╚═╝",
];

const BOOT_LINES = [
  "establishing encrypted channel",
  "loading engagement workspace",
  "mounting analysis toolkit",
  "arming mode modules",
];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MATRIX = "01<>|/\\*+#@:;=+-";
const GLITCH = "░▒▓█#@*&%";

const TOTAL_FRAMES = 48;
const FRAME_MS = 1000 / 24;

/**
 * Full-screen-ish cyber boot overlay when entering a working mode (TUI only).
 * Esc / Enter / Ctrl+C skips. Falls back silently outside TUI or if custom() fails.
 */
export async function playCyberEnterAnimation(
  ctx: ExtensionContext,
  mode: CyberModeId,
  engagementName?: string,
): Promise<void> {
  if (ctx.mode !== "tui") return;

  try {
    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => new CyberBootOverlay(tui, theme, mode, engagementName, done),
      {
        overlay: true,
        overlayOptions: {
          width: "92%",
          maxHeight: "90%",
          minWidth: 48,
          anchor: "center",
          margin: 1,
        },
      },
    );
  } catch {
    // custom() unavailable (RPC) or host rejected overlay — ignore.
  }
}

type TuiHandle = { requestRender: () => void };

class CyberBootOverlay {
  private readonly tui: TuiHandle;
  private readonly theme: Theme;
  private readonly mode: CyberModeId;
  private readonly engagementName?: string;
  private readonly done: (result: void) => void;

  private frame = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private finished = false;
  private seed = (Date.now() ^ 0x9e3779b9) >>> 0;
  private cachedWidth = -1;
  private cachedLines: string[] | undefined;

  constructor(
    tui: TuiHandle,
    theme: Theme,
    mode: CyberModeId,
    engagementName: string | undefined,
    done: (result: void) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.mode = mode;
    this.engagementName = engagementName;
    this.done = done;
    this.interval = setInterval(() => this.tick(), FRAME_MS);
  }

  private tick(): void {
    if (this.finished) return;
    this.frame++;
    this.cachedWidth = -1;
    this.cachedLines = undefined;
    if (this.frame >= TOTAL_FRAMES) {
      this.finish();
      return;
    }
    this.tui.requestRender();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.dispose();
    // Defer done() so we never resolve custom() mid-render.
    setTimeout(() => {
      try {
        this.done();
      } catch {
        /* ignore */
      }
    }, 0);
  }

  handleInput(data: string): void {
    // Avoid importing pi-tui key helpers (dual-package risk). Raw escapes are enough.
    if (
      data === "\x1b" ||
      data === "\x03" ||
      data === "\r" ||
      data === "\n" ||
      data === " "
    ) {
      this.finish();
    }
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = undefined;
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const th = this.theme;
    const innerW = Math.max(40, width - 2);
    const meta = CYBER_MODES[this.mode];
    const lines: string[] = [];

    const border = (c: string) => th.fg("border", c);
    const row = (content: string) =>
      border("│") + padVisible(content, innerW) + border("│");

    lines.push(border(`╭${"─".repeat(innerW)}╮`));
    lines.push(row(this.rainStrip(innerW)));
    lines.push(row(""));

    const reveal = Math.min(1, this.frame / 12);
    for (let r = 0; r < LOGO.length; r++) {
      lines.push(row(center(this.logoLine(LOGO[r]!, reveal, r, th), innerW)));
    }

    lines.push(row(""));

    const subtitle = `MODE // ${meta.label.toUpperCase()} (${meta.id})`;
    const typed = Math.min(subtitle.length, Math.max(0, this.frame - 8));
    const cursor = typed < subtitle.length && this.frame % 2 === 0 ? "▌" : "";
    lines.push(row(center(th.fg("accent", subtitle.slice(0, typed) + cursor), innerW)));
    lines.push(row(""));

    for (let i = 0; i < BOOT_LINES.length; i++) {
      const start = 14 + i * 5;
      if (this.frame < start) {
        lines.push(row(""));
        continue;
      }
      const done = this.frame >= start + 3;
      const mark = done
        ? th.fg("success", "✔")
        : th.fg("warning", SPINNER[this.frame % SPINNER.length]!);
      const text = done
        ? th.fg("dim", BOOT_LINES[i]!)
        : th.fg("accent", `${BOOT_LINES[i]!}…`);
      lines.push(row(` ${mark} ${text}`));
    }

    lines.push(row(""));

    if (this.frame < TOTAL_FRAMES - 8) {
      lines.push(
        row(
          center(
            th.fg("warning", `${SPINNER[this.frame % SPINNER.length]} initializing ${meta.id}…`),
            innerW,
          ),
        ),
      );
    } else {
      const eng = this.engagementName ? ` · ${this.engagementName}` : "";
      lines.push(row(center(th.fg("success", `● ONLINE — ${meta.label}${eng}`), innerW)));
    }

    lines.push(row(th.fg("dim", center("Esc / Enter 跳过", innerW))));
    lines.push(row(this.rainStrip(innerW)));
    lines.push(border(`╰${"─".repeat(innerW)}╯`));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private logoLine(line: string, reveal: number, row: number, th: Theme): string {
    const cols = Math.floor(line.length * reveal);
    let out = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (i >= cols || ch === " ") {
        out += " ";
        continue;
      }
      const glitch = rand(this.seed, row * 97 + i + this.frame) < Math.max(0, 0.32 - this.frame * 0.012);
      if (glitch) {
        const g = GLITCH[Math.floor(rand(this.seed, row + i * 13 + this.frame) * GLITCH.length)]!;
        out += ansiRgb(0, 255, 190, g);
      } else {
        out += th.fg("accent", ch);
      }
    }
    return out;
  }

  private rainStrip(width: number): string {
    let out = "";
    for (let i = 0; i < width; i++) {
      const phase = (this.frame + i * 3) % 16;
      if (phase < 2) {
        out += ansiRgb(160, 255, 220, MATRIX[Math.floor(rand(this.seed, i * 31 + this.frame) * MATRIX.length)]!);
      } else if (phase < 6) {
        out += ansiRgb(0, 120, 90, MATRIX[Math.floor(rand(this.seed, i * 17 + this.frame * 3) * MATRIX.length)]!);
      } else {
        out += " ";
      }
    }
    return out;
  }
}

/** Display width aware (CJK counts as 2 columns, ANSI codes as 0). */
function padVisible(content: string, width: number): string {
  const vis = visibleWidth(content);
  if (vis >= width) return truncateToWidth(content, width, "");
  return content + " ".repeat(width - vis);
}

function center(content: string, width: number): string {
  const vis = visibleWidth(content);
  if (vis >= width) return truncateToWidth(content, width, "");
  const left = Math.floor((width - vis) / 2);
  return " ".repeat(left) + content;
}

function ansiRgb(r: number, g: number, b: number, text: string): string {
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

function rand(seed: number, n: number): number {
  let x = (seed ^ (n * 374761393)) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177) >>> 0;
  return (x >>> 0) / 4294967296;
}
