import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadInspectorSettings } from "../src/settings.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "pi-inspector-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agent);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  return {
    agent,
    cwd,
    global(value: unknown) {
      writeFileSync(join(agent, "settings.json"), JSON.stringify(value));
    },
    project(value: unknown) {
      writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(value));
    },
  };
}

test("safe defaults, global LAN configuration, trusted project field overrides", (t) => {
  const f = fixture(t);
  assert.deepEqual(loadInspectorSettings(f.agent, f.cwd, true), { host: "127.0.0.1", port: 0 });
  f.global({ "pi-inspector": { host: "0.0.0.0", port: 34287 }, unrelated: true });
  f.project({ "pi-inspector": { port: 12345 } });
  assert.deepEqual(loadInspectorSettings(f.agent, f.cwd, true), { host: "0.0.0.0", port: 12345 });
  assert.deepEqual(loadInspectorSettings(f.agent, f.cwd, false), { host: "0.0.0.0", port: 34287 });
  f.global({ "pi-inspector": { host: "::1" } });
  assert.deepEqual(loadInspectorSettings(f.agent, f.cwd, false), { host: "::1", port: 0 });
});

test("BOM-prefixed settings preserve per-field overrides and explicit project trust", (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.agent, "settings.json"),
    "\uFEFF" + JSON.stringify({ "pi-inspector": { host: "127.0.0.1", port: 34287 } }),
  );
  writeFileSync(
    join(f.cwd, ".pi", "settings.json"),
    "\uFEFF" + JSON.stringify({ "pi-inspector": { host: "0.0.0.0" } }),
  );
  assert.deepEqual(loadInspectorSettings(f.agent, f.cwd, false), {
    host: "127.0.0.1",
    port: 34287,
  });
  assert.deepEqual(loadInspectorSettings(f.agent, f.cwd, true), { host: "0.0.0.0", port: 34287 });
  assert.deepEqual(loadInspectorSettings(f.agent, f.cwd, false), {
    host: "127.0.0.1",
    port: 34287,
  });
});

test("settings load errors prevent fallback and recover after correction", (t) => {
  const f = fixture(t);
  f.project({ "pi-inspector": { host: "0.0.0.0" } });
  const globalPath = join(f.agent, "settings.json");
  writeFileSync(globalPath, "{broken");
  for (const trusted of [false, true]) {
    assert.throws(
      () => loadInspectorSettings(f.agent, f.cwd, trusted),
      (error: Error) => {
        assert.ok(error.message.includes(globalPath));
        assert.ok(error.cause instanceof SyntaxError);
        return true;
      },
    );
  }
  rmSync(globalPath);
  mkdirSync(globalPath);
  assert.throws(
    () => loadInspectorSettings(f.agent, f.cwd, true),
    /invalid settings.*settings.json/,
  );
  rmSync(globalPath, { recursive: true });
  f.global({ "pi-inspector": { port: 12345 } });
  assert.deepEqual(loadInspectorSettings(f.agent, f.cwd, true), { host: "0.0.0.0", port: 12345 });
});

test("invalid inspector sections are rejected before merging", (t) => {
  const f = fixture(t);
  for (const value of [null, [], "0.0.0.0"]) {
    f.global({ "pi-inspector": value });
    f.project({ "pi-inspector": { host: "127.0.0.1", port: 12345 } });
    assert.throws(() => loadInspectorSettings(f.agent, f.cwd, true), /must be an object/);
    f.global({ "pi-inspector": { host: "127.0.0.1" } });
    f.project({ "pi-inspector": value });
    assert.throws(() => loadInspectorSettings(f.agent, f.cwd, true), /must be an object/);
    assert.deepEqual(loadInspectorSettings(f.agent, f.cwd, false), { host: "127.0.0.1", port: 0 });
  }
});

test("malformed untrusted project settings are not read", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, ".pi", "settings.json"), "{broken");
  assert.deepEqual(loadInspectorSettings(f.agent, f.cwd, false), { host: "127.0.0.1", port: 0 });
  assert.throws(
    () => loadInspectorSettings(f.agent, f.cwd, true),
    /invalid settings.*settings.json/,
  );
});

test("invalid settings fail closed with actionable errors and recover on correction", (t) => {
  const f = fixture(t);
  for (const value of [null, [], "0.0.0.0"]) {
    f.global({ "pi-inspector": value });
    assert.throws(() => loadInspectorSettings(f.agent, f.cwd, false), /must be an object/);
  }
  for (const host of [null, 123, "", "http://0.0.0.0", "0.0.0.0:34287", "[::1]", " 0.0.0.0 "]) {
    f.global({ "pi-inspector": { host } });
    assert.throws(() => loadInspectorSettings(f.agent, f.cwd, false), /pi-inspector.host/);
  }
  for (const port of [null, "34287", -1, 65536, 12.5]) {
    f.global({ "pi-inspector": { port } });
    assert.throws(() => loadInspectorSettings(f.agent, f.cwd, false), /pi-inspector.port/);
  }
  f.global({ "pi-inspector": { bind: "0.0.0.0" } });
  assert.throws(() => loadInspectorSettings(f.agent, f.cwd, false), /unknown setting "bind"/);
  f.global({ "pi-inspector": { host: "localhost", port: 65535 } });
  assert.deepEqual(loadInspectorSettings(f.agent, f.cwd, false), {
    host: "localhost",
    port: 65535,
  });
});
