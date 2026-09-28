import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Run separately so an unbounded transport regression cannot exhaust the test runner's heap.
const probe = String.raw`
import { connect } from "node:net";
import { once } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
const { createInspectServer } = await import(process.argv[1]);
const server = createInspectServer({ webDir: process.argv[2] });
let socket;
function sample() {
  global.gc();
  const { heapUsed, external, rss } = process.memoryUsage();
  return { heapUsed, external, rss };
}
try {
  const url = new URL(await server.start());
  socket = connect({ host: "127.0.0.1", port: Number(url.port) });
  socket.on("error", () => {});
  await once(socket, "connect");
  const headers = once(socket, "data");
  socket.write("GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n");
  await headers;
  socket.pause();
  const before = sample();
  for (let frame = 1; frame <= 512; frame++) {
    const accepted = server.push({ frame, payload: String.fromCharCode(65 + frame % 26).repeat(128 * 1024) });
    if (!accepted) throw new Error("Snapshot was rejected");
    await tick();
    if (frame % 128 === 0 && sample().heapUsed > 88 * 1024 * 1024) {
      throw new Error("Retained heap exceeded the bounded probe safety cutoff");
    }
  }
  console.log(JSON.stringify({ frames: 512, before, after: sample() }));
} finally {
  socket?.destroy();
  await server.stop();
}
`;

test(
  "stalled SSE reader does not retain a heap proportional to update count",
  { timeout: 20_000 },
  async () => {
    const webDir = await mkdtemp(join(tmpdir(), "pi-inspector-memory-"));
    try {
      await mkdir(join(webDir, "dist"));
      await writeFile(join(webDir, "index.html"), "<html>memory probe</html>");
      await writeFile(join(webDir, "dist", "index.js"), "// probe");
      await writeFile(join(webDir, "dist", "index.css"), "/* probe */");
      const result = spawnSync(
        process.execPath,
        [
          "--max-old-space-size=128",
          "--expose-gc",
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          probe,
          new URL("../src/server.ts", import.meta.url).href,
          webDir,
        ],
        {
          encoding: "utf8",
          timeout: 15_000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
          env: { ...process.env, NODE_OPTIONS: "" },
        },
      );
      assert.equal(result.status, 0, String(result.error ?? result.stderr));
      const measurement = JSON.parse(result.stdout.trim());
      assert.equal(measurement.frames, 512);
      const heapGrowth = measurement.after.heapUsed - measurement.before.heapUsed;
      const externalGrowth = measurement.after.external - measurement.before.external;
      assert.ok(
        heapGrowth < 8 * 1024 * 1024,
        `Retained heap grew by ${heapGrowth} bytes: ${result.stdout}`,
      );
      assert.ok(
        externalGrowth < 8 * 1024 * 1024,
        `External memory grew by ${externalGrowth} bytes: ${result.stdout}`,
      );
    } finally {
      await rm(webDir, { recursive: true, force: true });
    }
  },
);
