import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import {
  createServer,
  get,
  type IncomingHttpHeaders,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import {
  connect,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { join } from "node:path";
import { tmpdir, networkInterfaces } from "node:os";
import { test } from "node:test";
import { createInspectServer, MAX_EVENT_STREAM_CLIENTS } from "../src/server.ts";

interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

const REQUEST_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_MS = 10_000;
const testOptions = { timeout: TEST_TIMEOUT_MS };

async function listen(server: HttpServer | NetServer, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}

async function close(server: HttpServer | NetServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function makeBuild(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-inspector-server-"));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "index.html"), "<html>built</html>");
  await writeFile(join(root, "dist", "index.js"), "console.log('built');");
  await writeFile(join(root, "dist", "index.css"), "body { color: red; }");
  return root;
}

async function request(baseUrl: string, requestPath: string): Promise<HttpResponse> {
  const target = new URL(baseUrl);
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const req = get(
      {
        hostname,
        port: Number(target.port),
        path: requestPath,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.setTimeout(REQUEST_TIMEOUT_MS, () =>
          res.destroy(new Error(`Response timed out: ${requestPath}`)),
        );
        res.on("error", (error) => finish(() => reject(error)));
        res.on("end", () =>
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          ),
        );
      },
    );
    timer = setTimeout(
      () => req.destroy(new Error(`Request timed out: ${requestPath}`)),
      REQUEST_TIMEOUT_MS,
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () =>
      req.destroy(new Error(`Request timed out: ${requestPath}`)),
    );
    req.on("error", (error) => finish(() => reject(error)));
  });
}

interface Forwarder {
  port: number;
  server: NetServer;
  sockets: Set<Socket>;
}

async function startForwarder(target: URL): Promise<Forwarder> {
  const sockets = new Set<Socket>();
  const forwarder = createNetServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    const upstream = connect({
      host: target.hostname.replace(/^\[|\]$/g, ""),
      port: Number(target.port),
    });
    sockets.add(upstream);
    upstream.once("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.once("close", () => upstream.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  const port = await listen(forwarder);
  return { port, server: forwarder, sockets };
}

function waitForText(socket: Socket, text: string, received: { value: string }): Promise<void> {
  if (received.value.includes(text)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error(`SSE timed out waiting for ${text}`));
    }, REQUEST_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      received.value += chunk.toString("utf8");
      if (received.value.includes(text)) {
        socket.off("data", onData);
        clearTimeout(timer);
        resolve();
      }
    };
    socket.on("data", onData);
  });
}

test("binds requested host and port, with usable wildcard and IPv6 URLs", testOptions, async () => {
  const webDir = await makeBuild();
  const wildcard = createInspectServer({ host: "0.0.0.0", webDir });
  const ipv6 = createInspectServer({ host: "::1", webDir });
  try {
    const wildcardUrl = await wildcard.start();
    assert.match(wildcardUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await request(wildcardUrl, "/")).status, 200);
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((address) => address && !address.internal && address.family === "IPv4");
    if (lan) {
      assert.equal(
        (await request(`http://${lan.address}:${new URL(wildcardUrl).port}`, "/dist/index.js"))
          .status,
        200,
      );
    }

    const ipv6Url = await ipv6.start();
    assert.match(ipv6Url, /^http:\/\/\[::1\]:\d+$/);
    assert.equal((await request(ipv6Url, "/")).status, 200);
  } finally {
    await Promise.all([wildcard.stop(), ipv6.stop()]);
    await rm(webDir, { recursive: true, force: true });
  }
});

test("reports EADDRINUSE and can recover after the port is released", testOptions, async () => {
  const webDir = await makeBuild();
  const blocker = createServer();
  const port = await listen(blocker);
  const server = createInspectServer({ port, webDir });
  try {
    await assert.rejects(server.start(), (error: unknown) => {
      assert.match(String((error as Error).message), /EADDRINUSE/);
      assert.match(String((error as Error).message), /another process|another port/i);
      return true;
    });
    assert.equal(server.isRunning(), false);
    await close(blocker);
    const url = await server.start();
    assert.equal(Number(new URL(url).port), port);
    assert.equal((await request(url, "/")).status, 200);
  } finally {
    await server.stop();
    await close(blocker);
    await rm(webDir, { recursive: true, force: true });
  }
});

test(
  "serves only expected routes with safe assets, MIME types, and nonimmutable caching",
  testOptions,
  async () => {
    const webDir = await makeBuild();
    const outside = join(webDir, "outside.txt");
    await writeFile(outside, "private");
    await symlink(outside, join(webDir, "dist", "leak.txt"));
    await mkdir(join(webDir, "dist", "directory"));
    const server = createInspectServer({ webDir });
    try {
      const url = await server.start();
      const html = await request(url, "/?cache=bust");
      assert.equal(html.status, 200);
      assert.match(html.headers["content-type"] ?? "", /^text\/html/);
      assert.equal((await request(url, "/index.html")).status, 200);
      assert.equal((await request(url, "/dashboard")).status, 404);

      const script = await request(url, "/dist/index.js?cache=bust");
      assert.equal(script.status, 200);
      assert.match(script.headers["content-type"] ?? "", /javascript/);
      assert.doesNotMatch(script.headers["cache-control"] ?? "", /immutable/);
      const css = await request(url, "/dist/index.css");
      assert.equal(css.status, 200);
      assert.match(css.headers["content-type"] ?? "", /^text\/css/);
      assert.equal(css.headers["x-content-type-options"], "nosniff");
      const missing = await request(url, "/dist/missing.js");
      assert.equal(missing.status, 404);
      assert.match(missing.headers["content-type"] ?? "", /^text\/plain/);
      assert.equal((await request(url, "/dist/directory")).status, 404);
      assert.equal((await request(url, "/dist/leak.txt")).status, 404);
      assert.equal((await request(url, "/dist/%2e%2e/outside.txt")).status, 404);
      assert.equal((await request(url, "/dist/%2Fetc%2Fpasswd")).status, 404);
      assert.equal((await request(url, "/dist/%E0%A4%A")).status, 400);
    } finally {
      await server.stop();
      await rm(webDir, { recursive: true, force: true });
    }
  },
);

test(
  "fails clearly for a missing web build and starts after the build is supplied",
  testOptions,
  async () => {
    const webDir = await mkdtemp(join(tmpdir(), "pi-inspector-missing-"));
    const server = createInspectServer({ webDir });
    try {
      await assert.rejects(server.start(), (error: unknown) => {
        assert.match(String((error as Error).message), /bun run build:web/);
        return true;
      });
      assert.equal(server.isRunning(), false);
      await mkdir(join(webDir, "dist"));
      await writeFile(join(webDir, "index.html"), "<html>ready</html>");
      await writeFile(join(webDir, "dist", "index.js"), "ready");
      await writeFile(join(webDir, "dist", "index.css"), "ready");
      assert.equal((await request(await server.start(), "/")).status, 200);
    } finally {
      await server.stop();
      await rm(webDir, { recursive: true, force: true });
    }
  },
);

test("serves snapshots and flushed SSE through a local TCP forwarder", testOptions, async () => {
  const webDir = await makeBuild();
  const server = createInspectServer({ webDir });
  let forwarder: Forwarder | undefined;
  let socket: Socket | undefined;
  try {
    const serverUrl = await server.start();
    forwarder = await startForwarder(new URL(serverUrl));
    const forwardedBase = `http://127.0.0.1:${forwarder.port}`;
    const snapshot = await request(forwardedBase, "/snapshot");
    assert.equal(snapshot.status, 200);
    assert.deepEqual(JSON.parse(snapshot.body), {});
    assert.equal(snapshot.headers["cache-control"], "no-store");
    for (const path of ["/", "/dist/index.js", "/dist/index.css"]) {
      assert.equal((await request(forwardedBase, path)).status, 200);
    }

    const client = (socket = connect(forwarder.port, "127.0.0.1"));
    const received = { value: "" };
    await new Promise<void>((resolve, reject) => {
      client.setTimeout(REQUEST_TIMEOUT_MS, () => client.destroy(new Error("SSE socket timeout")));
      client.once("connect", () => {
        client.write("GET /events HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n");
        resolve();
      });
      client.once("error", reject);
    });
    await waitForText(socket, "\r\n\r\n", received);
    assert.match(received.value, /text\/event-stream/);
    server.push({ streamed: true });
    await waitForText(socket, 'data: {"streamed":true}', received);
    socket.destroy();
  } finally {
    socket?.destroy();
    if (forwarder) {
      for (const connection of forwarder.sockets) connection.destroy();
      await close(forwarder.server);
    }
    await server.stop();
    await rm(webDir, { recursive: true, force: true });
  }
});

test(
  "caches large snapshots for HTTP and SSE and reports serialization failures safely",
  testOptions,
  async () => {
    const webDir = await makeBuild();
    const server = createInspectServer({ webDir });
    let socket: Socket | undefined;
    try {
      const url = await server.start();
      const entries = Array.from({ length: 12_000 }, (_, i) => ({
        id: `entry-${i}`,
        parentId: i ? `entry-${i - 1}` : null,
        type: "custom",
        timestamp: new Date(i).toISOString(),
        customType: "test",
      }));
      const snapshot = { entries, capturedAt: 1 };
      assert.equal(server.push(snapshot), true);
      entries[0]!.customType = "mutated after push";
      const fetched = await request(url, "/snapshot");
      assert.equal(fetched.status, 200);
      const parsed = JSON.parse(fetched.body);
      assert.equal(parsed.entries.length, 12_000);
      assert.equal(parsed.entries[0].customType, "test");
      assert.equal("tree" in parsed, false);

      socket = connect(Number(new URL(url).port), "127.0.0.1");
      const received = { value: "" };
      await new Promise<void>((resolve, reject) => {
        socket!.setTimeout(REQUEST_TIMEOUT_MS, () => socket!.destroy(new Error("SSE timeout")));
        socket!.once("connect", () => {
          socket!.write(
            "GET /events HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n",
          );
          resolve();
        });
        socket!.once("error", reject);
      });
      await waitForText(socket, '"capturedAt":1', received);
      assert.match(received.value, /"id":"entry-11999"/);
      assert.equal(server.push({ ...snapshot, live: true }), true);
      await waitForText(socket, '"live":true', received);
      const cycle: Record<string, unknown> = {};
      cycle.self = cycle;
      const errorEvent = waitForText(socket, "SNAPSHOT_SERIALIZATION_FAILED", received);
      assert.equal(server.push(cycle), false);
      await errorEvent;
      const failed = await request(url, "/snapshot");
      assert.equal(failed.status, 500);
      const error = JSON.parse(failed.body);
      assert.equal(error.error.code, "SNAPSHOT_SERIALIZATION_FAILED");
      assert.doesNotMatch(failed.body, /entry-11999|self/);
      const recoveryEvent = waitForText(socket, '"recovered":true', received);
      assert.equal(server.push({ recovered: true }), true);
      await recoveryEvent;
      assert.deepEqual(JSON.parse((await request(url, "/snapshot")).body), { recovered: true });

      const getter = Object.defineProperty({}, "bad", {
        enumerable: true,
        get() {
          throw new Error("secret value");
        },
      });
      assert.equal(server.push(getter), false);
      assert.doesNotMatch((await request(url, "/snapshot")).body, /secret value/);
      const deep: Record<string, unknown> = {};
      let cursor = deep;
      for (let i = 0; i < 20_000; i++) {
        const next: Record<string, unknown> = {};
        cursor.next = next;
        cursor = next;
      }
      // A custom JSON method triggers the recursive serializer path even on runtimes
      // whose fast path can serialize deeply nested plain objects iteratively.
      const deepAccepted = server.push({
        deep,
        tool: {
          toJSON() {
            return {};
          },
        },
      });
      if (!deepAccepted) {
        const deepResponse = await request(url, "/snapshot");
        assert.equal(deepResponse.status, 500);
        assert.equal(JSON.parse(deepResponse.body).error.code, "SNAPSHOT_SERIALIZATION_FAILED");
      } else {
        assert.equal((await request(url, "/snapshot")).status, 200);
      }
      await server.stop();
      const restartedUrl = await server.start();
      assert.deepEqual(JSON.parse((await request(restartedUrl, "/snapshot")).body), {});
    } finally {
      socket?.destroy();
      await server.stop();
      await rm(webDir, { recursive: true, force: true });
    }
  },
);

test(
  "replays snapshot errors to new SSE clients and recovers without restarting",
  testOptions,
  async () => {
    const webDir = await makeBuild();
    const server = createInspectServer({ webDir });
    try {
      const url = await server.start();
      assert.equal(server.push({ unsupported: 1n }), false);
      const events = await fetch(`${url}/events`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const reader = events.body!.getReader();
      try {
        let frame = "";
        const decoder = new TextDecoder();
        while (!frame.includes("\n\n")) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          frame += decoder.decode(chunk.value, { stream: true });
        }
        assert.equal(JSON.parse(frame.slice(6).trim()).error.code, "SNAPSHOT_SERIALIZATION_FAILED");
      } finally {
        await reader.cancel();
      }
      assert.equal(server.push({ recovered: true }), true);
      assert.deepEqual(JSON.parse((await request(url, "/snapshot")).body), { recovered: true });
    } finally {
      await server.stop();
      await rm(webDir, { recursive: true, force: true });
    }
  },
);

test("reproduces legacy snapshot stringify overflow with toJSON in an isolated child", () => {
  const script =
    "let node = { id: 0 }; for (let i = 1; i < 15518; i++) node = { id: i, children: [node] }; try { JSON.stringify({ entries: [], tree: [node], tool: { toJSON() { return {}; } } }); process.exit(0); } catch (error) { if (error instanceof RangeError) process.exit(42); throw error; }";
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(result.status, 42, result.stderr);
});

test(
  "bounds slow SSE clients to the latest snapshot and isolates healthy clients",
  testOptions,
  async () => {
    const webDir = await makeBuild();
    const server = createInspectServer({ webDir });
    let slow: Socket | undefined;
    try {
      const url = await server.start();
      const payload = "x".repeat(256 * 1024);
      assert.equal(server.push({ revision: 0, payload }), true);
      slow = connect(Number(new URL(url).port), "127.0.0.1");
      const received = { value: "" };
      await new Promise<void>((resolve, reject) => {
        const socket = slow!;
        const timer = setTimeout(
          () => reject(new Error("SSE headers timed out")),
          REQUEST_TIMEOUT_MS,
        );
        const onHeaders = (chunk: Buffer): void => {
          received.value += chunk.toString("utf8");
          if (!received.value.includes("\r\n\r\n")) return;
          clearTimeout(timer);
          socket.off("data", onHeaders);
          socket.pause();
          resolve();
        };
        socket.once("connect", () => {
          socket.write("GET /events HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n");
        });
        socket.on("data", onHeaders);
        socket.once("error", reject);
      });

      for (let revision = 1; revision <= 20; revision++) {
        assert.equal(server.push({ revision, payload }), true);
      }

      const healthy = await fetch(`${url}/events`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const reader = healthy.body!.getReader();
      try {
        const latestEvent = waitForTextFromReader(reader, '"revision":21');
        assert.equal(server.push({ revision: 21, healthy: true }), true);
        await latestEvent;
      } finally {
        await reader.cancel();
      }

      const slowText = received;
      await new Promise<void>((resolve, reject) => {
        const socket = slow!;
        const timer = setTimeout(
          () => reject(new Error("SSE timed out waiting for latest revision")),
          REQUEST_TIMEOUT_MS,
        );
        const onData = (chunk: Buffer): void => {
          slowText.value += chunk.toString("utf8");
          if (!slowText.value.includes('"revision":21')) return;
          clearTimeout(timer);
          socket.off("data", onData);
          resolve();
        };
        socket.on("data", onData);
        socket.resume();
      });
      const deliveredRevisions = [...slowText.value.matchAll(/"revision":(\d+)/g)].map((match) =>
        Number(match[1]),
      );
      assert.equal(deliveredRevisions.at(-1), 21);
      assert.ok(
        deliveredRevisions.length <= 6,
        `Expected bounded delivery, got ${deliveredRevisions.length} frames`,
      );
      slow.destroy();
      slow = undefined;
      assert.equal(server.push({ afterClose: true }), true);
      assert.deepEqual(JSON.parse((await request(url, "/snapshot")).body), { afterClose: true });
    } finally {
      slow?.destroy();
      await server.stop();
      await rm(webDir, { recursive: true, force: true });
    }
  },
);

test(
  "caps SSE connections, releases capacity, and cleans up clients on stop",
  testOptions,
  async () => {
    const webDir = await makeBuild();
    const server = createInspectServer({ webDir });
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      const url = await server.start();
      const open = async (): Promise<Response> =>
        fetch(`${url}/events`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      for (let i = 0; i < MAX_EVENT_STREAM_CLIENTS; i++) {
        const response = await open();
        assert.equal(response.status, 200);
        readers.push(response.body!.getReader());
      }
      const saturated = await open();
      assert.equal(saturated.status, 503);
      await saturated.body?.cancel();

      await readers[0]!.cancel();
      readers.shift();
      let replacement: Response | undefined;
      for (let attempt = 0; attempt < 20; attempt++) {
        replacement = await open();
        if (replacement.status === 200) break;
        await replacement.body?.cancel();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      assert.equal(replacement?.status, 200, "released SSE capacity should accept a reconnect");
      readers.push(replacement!.body!.getReader());

      assert.equal(server.push({ blockedCleanup: "x".repeat(256 * 1024) }), true);
      await server.stop();
      for (const reader of readers.splice(0)) {
        await reader.cancel().catch(() => undefined);
      }
      const restartedUrl = await server.start();
      assert.equal(server.push({ afterRestart: true }), true);
      const reconnected = await fetch(`${restartedUrl}/events`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      assert.equal(reconnected.status, 200);
      const reconnectReader = reconnected.body!.getReader();
      try {
        await waitForTextFromReader(reconnectReader, '"afterRestart":true');
      } finally {
        await reconnectReader.cancel();
      }
    } finally {
      for (const reader of readers) await reader.cancel().catch(() => undefined);
      await server.stop();
      await rm(webDir, { recursive: true, force: true });
    }
  },
);

test(
  "asynchronous SSE response errors destroy the connection and detach delivery listeners",
  testOptions,
  async () => {
    const webDir = await makeBuild();
    const server = createInspectServer({ webDir });
    const requestStart = channel("http.server.request.start");
    let response: ServerResponse | undefined;
    const capture = (message: unknown): void => {
      const event = message as { response: ServerResponse };
      if (event.response.req.url === "/events") response = event.response;
    };
    requestStart.subscribe(capture);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const url = await server.start();
      const opened = await fetch(`${url}/events`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      reader = opened.body!.getReader();
      requestStart.unsubscribe(capture);
      assert.ok(response);
      assert.equal(response.listenerCount("drain"), 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      response.emit("error", new Error("injected asynchronous transport failure"));
      assert.equal(response.destroyed, true);
      assert.equal(response.listenerCount("drain"), 0);
      assert.equal(response.listenerCount("error"), 0);
      assert.equal(server.push({ survivedTransportFailure: true }), true);
      assert.deepEqual(JSON.parse((await request(url, "/snapshot")).body), {
        survivedTransportFailure: true,
      });
    } finally {
      requestStart.unsubscribe(capture);
      await reader?.cancel().catch(() => undefined);
      await server.stop();
      await rm(webDir, { recursive: true, force: true });
    }
  },
);

async function waitForTextFromReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  text: string,
): Promise<void> {
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes(text)) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, `SSE ended before ${text}`);
    received += decoder.decode(chunk.value, { stream: true });
  }
}

test("stops and restarts cleanly without retaining the old snapshot", testOptions, async () => {
  const webDir = await makeBuild();
  const server = createInspectServer({ webDir });
  try {
    await server.start();
    server.push({ old: true });
    await server.stop();
    assert.equal(server.isRunning(), false);
    assert.equal(server.getUrl(), undefined);

    const secondUrl = await server.start();
    assert.equal(server.isRunning(), true);
    assert.deepEqual(JSON.parse((await request(secondUrl, "/snapshot")).body), {});
    assert.equal((await request(secondUrl, "/")).status, 200);
  } finally {
    await server.stop();
    await rm(webDir, { recursive: true, force: true });
  }
});
