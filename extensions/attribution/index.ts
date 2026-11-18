import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CYBER_MODES, registerModeModule } from "../../src/shared/mode.ts";

/**
 * Attribution and forensics working-mode extension.
 */
export default function (pi: ExtensionAPI) {
  registerModeModule(pi, CYBER_MODES.attribution, (api, modeCtx) => {
    api.on("before_agent_start", async () => {
      if (!modeCtx.isActive()) return;
      // TODO: Inject attribution / forensics mode system prompt
    });

    // TODO: Register attribution tools (e.g., timeline correlation, IOC extraction)
  });
}
