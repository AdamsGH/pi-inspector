import {
	createServer,
	type Server as HttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultWebDir = join(dirname(fileURLToPath(import.meta.url)), "web");

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

export interface InspectServer {
	/** Start listening and resolve to the base URL. */
	start(): Promise<string>;
	/** Stop the server and disconnect all SSE clients. */
	stop(): Promise<void>;
	/** Broadcast a snapshot to all connected clients and cache it for future connections. */
	push(snapshot: unknown): void;
	/** Whether the server is currently listening. */
	isRunning(): boolean;
	/** The base URL, if started. */
	getUrl(): string | undefined;
}

export interface InspectServerOptions {
	host?: string;
	port?: number;
	webDir?: string;
}

interface BuildPaths {
	webRoot: string;
	distRoot: string;
	htmlPath: string;
}

function isContained(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeRegularFile(root: string, relativePath: string): string | undefined {
	const candidate = resolve(root, relativePath);
	if (!isContained(root, candidate)) return undefined;

	try {
		const resolved = realpathSync(candidate);
		if (!isContained(root, resolved) || !statSync(resolved).isFile()) return undefined;
		return resolved;
	} catch {
		return undefined;
	}
}

function safeDirectory(root: string, relativePath: string): string | undefined {
	const candidate = resolve(root, relativePath);
	if (!isContained(root, candidate)) return undefined;

	try {
		const resolved = realpathSync(candidate);
		if (!isContained(root, resolved) || !statSync(resolved).isDirectory()) return undefined;
		return resolved;
	} catch {
		return undefined;
	}
}

function validateBuild(configuredWebDir: string): BuildPaths {
	let webRoot: string | undefined;
	try {
		webRoot = realpathSync(configuredWebDir);
	} catch {
		webRoot = undefined;
	}

	const htmlPath = webRoot ? safeRegularFile(webRoot, "index.html") : undefined;
	const distRoot = webRoot ? safeDirectory(webRoot, "dist") : undefined;
	const missing = [
		!htmlPath && "index.html",
		!distRoot && "dist/",
		distRoot && !safeRegularFile(distRoot, "index.js") && "dist/index.js",
		distRoot && !safeRegularFile(distRoot, "index.css") && "dist/index.css",
	].filter((item): item is string => Boolean(item));

	if (!webRoot || missing.length > 0 || !htmlPath || !distRoot) {
		throw new Error(
			`pi-inspector web build is missing ${missing.join(", ") || "required files"}. Run bun run build:web before starting the inspector.`,
		);
	}

	return { webRoot, distRoot, htmlPath };
}

function wildcardLocalHost(host: string): string | undefined {
	const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (normalized === "0.0.0.0") return "127.0.0.1";
	if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return "::1";
	return undefined;
}

function urlHost(host: string): string {
	const localHost = wildcardLocalHost(host) ?? host.replace(/^\[|\]$/g, "");
	return localHost.includes(":") ? `[${localHost}]` : localHost;
}

function listenError(error: unknown, host: string, port: number): Error {
	const original = error as NodeJS.ErrnoException;
	const code = original.code ?? "UNKNOWN";
	const detail =
		code === "EADDRINUSE"
			? "The address is already in use. Stop the other process or choose another port."
			: original.message || "The operating system rejected the bind request.";
	const wrapped = new Error(
		`Unable to start pi-inspector on ${host}:${port} (${code}): ${detail}`,
		{ cause: error },
	);
	wrapped.name = "InspectServerListenError";
	Object.assign(wrapped, { code });
	return wrapped;
}

function sendNotFound(res: ServerResponse): void {
	res.writeHead(404, {
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "no-cache",
	});
	res.end("Not Found");
}

function sendBadRequest(res: ServerResponse): void {
	res.writeHead(400, {
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "no-cache",
	});
	res.end("Bad Request");
}

export function createInspectServer(options: InspectServerOptions = {}): InspectServer {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 0;
	const configuredWebDir = resolve(options.webDir ?? defaultWebDir);
	let httpServer: HttpServer | undefined;
	let url: string | undefined;
	let lastSnapshot: unknown;
	let activeBuild: BuildPaths | undefined;
	let startPromise: Promise<string> | undefined;
	let stopPromise: Promise<void> | undefined;
	const clients = new Set<ServerResponse>();

	function broadcast(data: unknown): void {
		const body = `data: ${JSON.stringify(data) ?? "null"}\n\n`;
		for (const res of clients) {
			try {
				res.write(body);
			} catch {
				clients.delete(res);
			}
		}
	}

	const server: HttpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
		const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
		let path: string;
		try {
			path = decodeURIComponent(rawPath);
		} catch {
			sendBadRequest(res);
			return;
		}

		if (path === "/events") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"X-Content-Type-Options": "nosniff",
			});
			res.flushHeaders();
			if (lastSnapshot !== undefined) {
				res.write(`data: ${JSON.stringify(lastSnapshot) ?? "null"}\n\n`);
			}
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}

		if (path === "/snapshot") {
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			});
			res.end(lastSnapshot === undefined ? "{}" : (JSON.stringify(lastSnapshot) ?? "null"));
			return;
		}

		if (path === "/" || path === "/index.html") {
			const build = activeBuild;
			const htmlFile = build ? safeRegularFile(build.webRoot, "index.html") : undefined;
			if (htmlFile) {
				try {
					const html = readFileSync(htmlFile, "utf8");
					res.writeHead(200, {
						"Content-Type": "text/html; charset=utf-8",
						"Cache-Control": "no-cache",
						"X-Content-Type-Options": "nosniff",
					});
					res.end(html);
				} catch {
					sendNotFound(res);
				}
				return;
			}
			sendNotFound(res);
			return;
		}

		if (path.startsWith("/dist/")) {
			const build = activeBuild;
			const distRoot = build ? safeDirectory(build.webRoot, "dist") : undefined;
			const filePath = distRoot
				? safeRegularFile(distRoot, path.slice("/dist/".length))
				: undefined;
			if (filePath) {
				try {
					const body = readFileSync(filePath);
					const ext = extname(filePath).toLowerCase();
					res.writeHead(200, {
						"Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
						"Cache-Control": "no-cache",
						"X-Content-Type-Options": "nosniff",
					});
					res.end(body);
				} catch {
					sendNotFound(res);
				}
				return;
			}
		}

		sendNotFound(res);
	});

	function listen(): Promise<void> {
		return new Promise<void>((resolveListen, rejectListen) => {
			const onError = (error: Error): void => {
				server.off("listening", onListening);
				rejectListen(listenError(error, host, port));
			};
			const onListening = (): void => {
				server.off("error", onError);
				resolveListen();
			};
			server.once("listening", onListening);
			server.once("error", onError);
			try {
				server.listen(port, host);
			} catch (error) {
				server.off("listening", onListening);
				server.off("error", onError);
				rejectListen(listenError(error, host, port));
			}
		});
	}

	async function startInternal(): Promise<string> {
		activeBuild = validateBuild(configuredWebDir);
		await listen();
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Unable to determine the pi-inspector listening address.");
		}
		httpServer = server;
		url = `http://${urlHost(host)}:${address.port}`;
		return url;
	}

	return {
		async start(): Promise<string> {
			if (stopPromise) {
				await stopPromise;
				return this.start();
			}
			if (httpServer?.listening) return url!;
			if (startPromise) return startPromise;

			const pending = startInternal();
			startPromise = pending;
			pending.then(
				() => {
					if (startPromise === pending) startPromise = undefined;
				},
				() => {
					if (startPromise === pending) startPromise = undefined;
				},
			);
			return pending;
		},
		async stop(): Promise<void> {
			if (stopPromise) return stopPromise;
			const pending = (async (): Promise<void> => {
				if (startPromise) {
					try {
						await startPromise;
					} catch {
						// A failed start leaves the server available for a later retry.
					}
				}
				for (const res of clients) res.end();
				clients.clear();
				if (server.listening) {
					const closePromise = new Promise<void>((resolveClose, rejectClose) => {
						server.close((error) => {
							if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
								rejectClose(error);
							} else {
								resolveClose();
							}
						});
					});
					server.closeAllConnections();
					await closePromise;
				}
				httpServer = undefined;
				url = undefined;
				activeBuild = undefined;
				lastSnapshot = undefined;
			})();
			stopPromise = pending;
			try {
				await pending;
			} finally {
				if (stopPromise === pending) stopPromise = undefined;
			}
		},
		push(snapshot: unknown): void {
			lastSnapshot = snapshot;
			if (clients.size > 0) broadcast(snapshot);
		},
		isRunning(): boolean {
			return httpServer !== undefined;
		},
		getUrl(): string | undefined {
			return url;
		},
	};
}
