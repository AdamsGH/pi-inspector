import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SessionEntry } from "../src/web/src/types.ts";
import { computeTreeLayout } from "../src/web/src/hooks/useTreeLayout.ts";

function entry(
  id: string,
  parentId: string | null,
  timestamp: string,
  extra: Record<string, unknown> = {},
): SessionEntry {
  return {
    id,
    parentId,
    type: "custom",
    timestamp,
    customType: id,
    ...extra,
  } as unknown as SessionEntry;
}

test("lays out 12k entries iteratively without truncation", () => {
  const entries = Array.from({ length: 12_000 }, (_, i) =>
    entry(`e${i}`, i ? `e${i - 1}` : null, new Date(i).toISOString()),
  );
  const layout = computeTreeLayout({
    entries,
    leafId: "e11999",
    capturedAt: 1,
  });
  assert.equal(layout.totalCount, 12_000);
  assert.equal(layout.flatNodes.length, 12_000);
  assert.equal(layout.flatNodes[0]!.node.entry.id, "e0");
  assert.equal(layout.flatNodes.at(-1)!.node.entry.id, "e11999");
  assert.equal(layout.activeIds.size, 12_000);
  assert.equal(layout.flatNodes[1]!.indent, 0);
});

test("preserves active branch order, labels, roles, and multiple roots", () => {
  const entries = [
    entry("root", null, "2024-01-01T00:00:00.000Z"),
    entry("earlier", "root", "2024-01-01T00:00:01.000Z"),
    entry("active", "root", "2024-01-01T00:00:02.000Z"),
    entry("label", "active", "2024-01-01T00:00:03.000Z", { type: "label", label: "checkpoint" }),
    entry("other-root", null, "2024-01-01T00:00:04.000Z"),
  ] as SessionEntry[];
  const layout = computeTreeLayout({ entries, leafId: "label", capturedAt: 1 });
  assert.deepEqual(
    layout.flatNodes.map((item) => item.node.entry.id),
    ["root", "active", "label", "earlier", "other-root"],
  );
  assert.equal(layout.flatNodes[2]!.summary, "checkpoint: ");
  assert.equal(layout.flatNodes[2]!.role, "other");
  assert.equal(layout.flatNodes[0]!.multipleRoots, true);
  assert.deepEqual(
    layout.flatNodes.map((item) => item.cells),
    [[], ["v h"], ["v", ""], ["vh h"], []],
  );
});

test("lays out deeply branched histories with indexed connector gutters", () => {
  const timestamp = "2024-01-01T00:00:00.000Z";
  const entries = [entry("spine-0", null, timestamp)];
  for (let i = 1; i <= 600; i++) {
    entries.push(entry(`side-${i}`, `spine-${i - 1}`, timestamp));
    entries.push(entry(`spine-${i}`, `spine-${i - 1}`, timestamp));
  }
  const layout = computeTreeLayout({ entries, leafId: "spine-600", capturedAt: 1 });
  assert.equal(layout.totalCount, 1201);
  assert.equal(layout.activeIds.size, 601);
  assert.equal(layout.flatNodes.filter((item) => item.isCurrentLeaf).length, 1);
  assert.equal(layout.flatNodes[600]!.node.entry.id, "spine-600");
  assert.equal(layout.flatNodes.at(-1)!.node.entry.id, "side-1");
  assert.equal(layout.flatNodes[600]!.cells.length, 600);
});
