import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createSnapshotUpdates,
  type SnapshotUpdate,
} from "../src/web/src/utils/snapshotUpdates.ts";

function deferred() {
  let resolve!: (update: SnapshotUpdate) => void;
  const promise = new Promise<SnapshotUpdate>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const [name, streamed, stale] of [
  ["recovery", { capturedAt: 2 }, { error: { message: "old error" } }],
  ["serialization error", { error: { message: "current error" } }, { capturedAt: 1 }],
  ["newer snapshot", { capturedAt: 2 }, { capturedAt: 1 }],
] as const) {
  test(`late HTTP response cannot replace SSE ${name}`, async () => {
    const applied: SnapshotUpdate[] = [];
    const updates = createSnapshotUpdates((update) => applied.push(update));
    const pending = deferred();
    const refresh = updates.refresh(() => pending.promise);
    updates.receive(streamed);
    pending.resolve(stale);
    await refresh;
    assert.deepEqual(applied, [streamed]);
  });
}

test("newer HTTP refresh supersedes an older request", async () => {
  const applied: SnapshotUpdate[] = [];
  const updates = createSnapshotUpdates((update) => applied.push(update));
  const old = deferred();
  const first = updates.refresh(() => old.promise);
  await updates.refresh(async () => ({ capturedAt: 2 }));
  old.resolve({ capturedAt: 1 });
  await first;
  assert.deepEqual(applied, [{ capturedAt: 2 }]);
});

test("cleanup invalidates pending refreshes without blocking a later subscription", async () => {
  const applied: SnapshotUpdate[] = [];
  const updates = createSnapshotUpdates((update) => applied.push(update));
  const pending = deferred();
  const refresh = updates.refresh(() => pending.promise);
  updates.cancel();
  pending.resolve({ capturedAt: 1 });
  await refresh;
  assert.deepEqual(applied, []);
  await updates.refresh(async () => ({ capturedAt: 2 }));
  assert.deepEqual(applied, [{ capturedAt: 2 }]);
});
