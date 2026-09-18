import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createInspectServer, type InspectServer } from "./server.ts";
import { loadInspectorSettings, type InspectorSettings } from "./settings.ts";

const REFRESH_EVENTS = [
	"session_start",
	"session_info_changed",
	"session_tree",
	"session_compact",
	"session_compact_failed",
	"message_start",
	"message_end",
	"turn_start",
	"turn_end",
	"tool_execution_start",
	"tool_execution_end",
	"agent_start",
	"agent_end",
	"agent_settled",
	"model_select",
	"thinking_level_select",
] as const;

function openBrowser(url: string): void {
	const platform = process.platform;
	const cmd =
		platform === "darwin"
			? ["open", url]
			: platform === "win32"
				? ["cmd", "/c", "start", "", url]
				: ["xdg-open", url];
	try {
		const child = spawn(cmd[0]!, cmd.slice(1), { stdio: "ignore", detached: true });
		child.on("error", () => undefined);
		child.unref();
	} catch {
		// Best effort; the URL is still shown in the footer.
	}
}

export default function inspectExtension(pi: ExtensionAPI): void {
	let server: InspectServer | undefined;
	let settings: InspectorSettings | undefined;
	let lastSystemPrompt: string | undefined;
	let pushTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingBuilder: (() => unknown) | undefined;

	// Register listeners for every event that can change the visible session state.
	for (const event of REFRESH_EVENTS) {
		(pi.on as (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => void)(
			event,
			(_event, ctx) => schedulePush(() => buildSnapshot(ctx)),
		);
	}
	pi.on("message_update", (_event, ctx) => schedulePush(() => buildSnapshot(ctx)));

	// Capture the fully-assembled system prompt each turn.
	pi.on("before_agent_start", (event, ctx) => {
		lastSystemPrompt = event.systemPrompt;
		schedulePush(() => buildSnapshot(ctx));
	});
	pi.on("session_start", (_event, ctx) => {
		lastSystemPrompt = ctx.getSystemPrompt();
	});

	// Lifecycle: stop the local server when the session runtime is torn down.
	pi.on("session_shutdown", async (_event, ctx) => {
		await stopServer(ctx);
	});

	pi.registerCommand("inspect", {
		description: "Inspect current session dashboard (subcommands: start | stop | status | open)",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (!["", "start", "stop", "status", "open"].includes(sub)) {
				ctx.ui.notify("Usage: /inspect [start|stop|status|open]", "error");
				return;
			}
			if (sub === "stop") {
				await stopServer(ctx);
				ctx.ui.notify("pi-inspector stopped", "info");
				return;
			}
			if (sub === "status") {
				ctx.ui.notify(describeServer(), "info");
				return;
			}
			if (!server?.isRunning()) {
				try {
					settings = loadInspectorSettings(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
					server = createInspectServer(settings);
					const url = await server.start();
					ctx.ui.setStatus("inspect", url);
				} catch (error) {
					await server?.stop();
					server = undefined;
					settings = undefined;
					ctx.ui.notify(`pi-inspector failed to start: ${String(error)}`, "error");
					return;
				}
				if (settings && !["127.0.0.1", "::1", "localhost"].includes(settings.host)) {
					ctx.ui.notify(
						"pi-inspector has no authentication: reachable clients can read the full transcript and system prompt. Use only on a trusted network.",
						"warning",
					);
				}
			}
			const snapshot = buildSnapshot(ctx);
			if (snapshot !== undefined) server.push(snapshot);
			ctx.ui.notify(describeServer(), "info");
			if (sub !== "start") openBrowser(server.getUrl()!);
		},
	});

	function buildSnapshot(ctx: ExtensionContext): unknown {
		try {
			const sm = ctx.sessionManager;
			return {
				sessionId: sm.getSessionId(),
				sessionName: sm.getSessionName(),
				cwd: sm.getCwd(),
				sessionFile: sm.getSessionFile(),
				header: sm.getHeader(),
				model: ctx.model
					? { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name }
					: undefined,
				thinkingLevel: ctx.thinkingLevel,
				idle: ctx.isIdle(),
				systemPrompt: lastSystemPrompt ?? ctx.getSystemPrompt(),
				entries: sm.getEntries(),
				tree: sm.getTree(),
				branch: sm.getBranch(),
				leafId: sm.getLeafId(),
				commands: pi.getCommands(),
				tools: pi.getAllTools(),
				activeTools: pi.getActiveTools(),
				capturedAt: Date.now(),
			};
		} catch {
			// A queued refresh may outlive its context during a session switch or reload.
			return undefined;
		}
	}

	/** Throttled push: coalesce bursts (e.g. streaming deltas) into one broadcast. */
	function schedulePush(builder: () => unknown): void {
		if (!server?.isRunning()) return;
		pendingBuilder = builder;
		if (pushTimer) return;
		pushTimer = setTimeout(() => {
			pushTimer = undefined;
			const pending = pendingBuilder;
			pendingBuilder = undefined;
			if (server?.isRunning() && pending) {
				const snapshot = pending();
				if (snapshot !== undefined) server.push(snapshot);
			}
		}, 100);
	}

	function describeServer(): string {
		const url = server?.getUrl();
		if (!url || !settings) return "pi-inspector not running. Use /inspect to start.";
		const port = new URL(url).port;
		const urls = new Set([url]);
		if (settings.host === "0.0.0.0" || settings.host === "::") {
			for (const addresses of Object.values(networkInterfaces())) {
				for (const address of addresses ?? []) {
					if (address.internal || address.address.includes("%")) continue;
					if (address.family === "IPv4") urls.add(`http://${address.address}:${port}`);
					else if (settings.host === "::" && !address.address.startsWith("fe80:"))
						urls.add(`http://[${address.address}]:${port}`);
				}
			}
		}
		return `pi-inspector listening on ${settings.host}:${port}\n${[...urls].join("\n")}`;
	}

	async function stopServer(ctx: ExtensionContext): Promise<void> {
		if (pushTimer) clearTimeout(pushTimer);
		pushTimer = undefined;
		pendingBuilder = undefined;
		await server?.stop();
		server = undefined;
		settings = undefined;
		lastSystemPrompt = undefined;
		ctx.ui.setStatus("inspect", undefined);
	}
}
