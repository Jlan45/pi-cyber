import assert from "node:assert/strict";
import { test } from "node:test";
import { CYBER_MODES, registerModeModule } from "../src/shared/mode.ts";
import { isRemoteExecutionActive, setRemoteExecutionActive } from "../src/shared/execution.ts";
import { getActiveCyberWorkspace, setActiveCyberWorkspace } from "../src/shared/workspace.ts";

test("unimplemented mode commands refuse to switch", async () => {
  let registeredHandler: ((args: string, ctx: unknown) => Promise<void>) | null = null;
  const notices: Array<{ message: string; type?: string }> = [];

  const fakePi = {
    events: { on: () => {}, emit: () => {} },
    registerCommand: (_name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      registeredHandler = opts.handler;
    },
  };

  registerModeModule(fakePi as never, CYBER_MODES.attribution);
  assert.ok(registeredHandler);

  await (registeredHandler as (args: string, ctx: unknown) => Promise<void>)("", {
    ui: {
      notify: (message: string, type?: string) => {
        notices.push({ message, type });
      },
    },
  });

  assert.equal(notices.length, 1);
  assert.match(notices[0]!.message, /还没有实现/);
  assert.equal(notices[0]!.type, "warning");
});

test("shared workspace and remote execution flags round-trip", () => {
  setActiveCyberWorkspace(null);
  assert.equal(getActiveCyberWorkspace(), null);

  const ws = {
    rootCwd: "/tmp",
    workspaceDir: "/tmp/demo-20261126",
    engagementName: "demo",
    createdAt: "2026-11-26T00:00:00.000Z",
  };
  setActiveCyberWorkspace(ws);
  assert.equal(getActiveCyberWorkspace()?.workspaceDir, ws.workspaceDir);
  setActiveCyberWorkspace(null);

  setRemoteExecutionActive(true);
  assert.equal(isRemoteExecutionActive(), true);
  setRemoteExecutionActive(false);
  assert.equal(isRemoteExecutionActive(), false);
});
