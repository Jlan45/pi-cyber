import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  normalizeExecutionFile,
  quoteRemotePath,
  readExecutionFile,
  stripLeadingLocalCd,
} from "../src/shared/execution.ts";

test("remote paths keep ~ working and cannot inject shell", () => {
  assert.equal(quoteRemotePath("/srv/scan"), "'/srv/scan'");
  assert.equal(quoteRemotePath("~/work dir"), `"$HOME"/'work dir'`);
  assert.equal(quoteRemotePath("~"), `"$HOME"`);
  assert.equal(quoteRemotePath("/x$(id)'; rm -rf /"), `'/x$(id)'\\''; rm -rf /'`);
});

test("an invalid execution file is an error, never a silent fallback to local", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cyber-exec-"));
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ not json");
  assert.throws(() => readExecutionFile(broken), /不是有效的 JSON/);

  const dup = join(dir, "dup.json");
  writeFileSync(
    dup,
    JSON.stringify({
      environments: [
        { name: "a", type: "ssh", target: "h1" },
        { name: "a", type: "ssh", target: "h2" },
      ],
    }),
  );
  assert.throws(() => readExecutionFile(dup), /重复/);
  assert.equal(readExecutionFile(join(dir, "missing.json")), null);
});

test("hostKeyCheck is kept only for valid values", () => {
  const file = normalizeExecutionFile({
    environments: [
      { name: "a", type: "ssh", target: "h", hostKeyCheck: "strict" },
      { name: "b", type: "ssh", target: "h", hostKeyCheck: "whatever" },
    ],
  });
  const byName = Object.fromEntries(file.environments.map((e) => [e.name, e]));
  assert.equal((byName.a as { hostKeyCheck?: string }).hostKeyCheck, "strict");
  assert.equal((byName.b as { hostKeyCheck?: string }).hostKeyCheck, undefined);
});

test("the local cd added by the core redirect is stripped for remote runs", () => {
  assert.equal(stripLeadingLocalCd("cd '/w/ws' && nmap x", ["/w/ws"]), "nmap x");
  assert.equal(stripLeadingLocalCd("cd /other && nmap x", ["/w/ws"]), "cd /other && nmap x");
});
