import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CYBER_MODES, registerModeModule } from "../../src/shared/mode.ts";

/**
 * Vulnerability remediation working-mode extension.
 */
export default function (pi: ExtensionAPI) {
  registerModeModule(pi, CYBER_MODES.remediation, (api, modeCtx) => {
    api.on("before_agent_start", async () => {
      if (!modeCtx.isActive()) return;
      // TODO: Inject remediation mode system prompt / patch verification workflow
    });

    // TODO: Register remediation tools (e.g., patch validation, regression test runner)
  });
}
