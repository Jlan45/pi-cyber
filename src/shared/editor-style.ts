import {
  CustomEditor,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parseColor } from "@earendil-works/pi-tui";

/** Muted terminal green for cyber-mode input border. */
const CYBER_EDITOR_GREEN = parseColor("#3a7a3a");

type CustomEditorArgs = ConstructorParameters<typeof CustomEditor>;

/**
 * Custom editor that keeps a locked border color so Pi's thinking/bash
 * border overrides cannot wipe the cyber green chrome.
 */
class CyberEditor extends CustomEditor {
  private lockedBorder = false;
  private _borderColor?: (text: string) => string;

  constructor(
    tui: CustomEditorArgs[0],
    theme: CustomEditorArgs[1],
    keybindings: CustomEditorArgs[2],
  ) {
    super(tui, theme, keybindings);
    delete (this as { borderColor?: (text: string) => string }).borderColor;
    Object.defineProperty(this, "borderColor", {
      get: () => this._borderColor ?? ((text: string) => text),
      set: (value: (text: string) => string) => {
        if (this.lockedBorder) return;
        this._borderColor = value;
      },
      configurable: true,
      enumerable: true,
    });
  }

  lockBorderColor(): void {
    this.lockedBorder = true;
  }
}

/**
 * When cyber working mode is active, paint the main input border green.
 * Pass `enabled: false` to restore the default editor.
 */
export function applyCyberEditorStyle(ctx: ExtensionContext, enabled: boolean): void {
  if (ctx.mode !== "tui") return;
  try {
    if (!enabled) {
      ctx.ui.setEditorComponent(undefined);
      return;
    }
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new CyberEditor(tui, theme, keybindings);
      editor.borderColor = (text) =>
        ctx.ui.theme.style(text, { fg: CYBER_EDITOR_GREEN });
      editor.lockBorderColor();
      return editor;
    });
  } catch {
    // Editor chrome must never break mode switching.
  }
}
