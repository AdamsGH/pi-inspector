import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";

export interface InspectorSettings {
	host: string;
	port: number;
}

function readSettings(path: string): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`pi-inspector: cannot read ${path}`, { cause: error });
	}
	try {
		const settings: unknown = JSON.parse(text);
		if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
			throw new Error("expected a JSON object");
		}
		const value = (settings as Record<string, unknown>)["pi-inspector"];
		if (value === undefined) return {};
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error('"pi-inspector" must be an object');
		}
		return value as Record<string, unknown>;
	} catch (error) {
		throw new Error(`pi-inspector: invalid settings in ${path}: ${String(error)}`, {
			cause: error,
		});
	}
}

/** Re-read settings on each start. Untrusted project settings never affect network exposure. */
export function loadInspectorSettings(
	agentDir: string,
	cwd: string,
	projectTrusted: boolean,
): InspectorSettings {
	const value = {
		host: "127.0.0.1",
		port: 0,
		...readSettings(join(agentDir, "settings.json")),
		...(projectTrusted ? readSettings(join(cwd, ".pi", "settings.json")) : {}),
	};
	for (const key of Object.keys(value)) {
		if (key !== "host" && key !== "port") {
			throw new Error(`pi-inspector: unknown setting "${key}". Supported settings: host, port.`);
		}
	}
	if (typeof value.host !== "string" || (!isIP(value.host) && value.host !== "localhost")) {
		throw new Error(
			'pi-inspector.host must be an IPv4/IPv6 address or "localhost" (no URL or port).',
		);
	}
	if (
		typeof value.port !== "number" ||
		!Number.isInteger(value.port) ||
		value.port < 0 ||
		value.port > 65535
	) {
		throw new Error(
			"pi-inspector.port must be an integer from 0 to 65535 (0 selects a free port).",
		);
	}
	return value as InspectorSettings;
}
