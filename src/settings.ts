import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { isIP } from "node:net";
import { join } from "node:path";

export interface InspectorSettings {
	host: string;
	port: number;
}

function inspectorSettings(settings: object, path: string): Record<string, unknown> {
	const value = (settings as Record<string, unknown>)["pi-inspector"];
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`pi-inspector: invalid settings in ${path}: "pi-inspector" must be an object`);
	}
	return value as Record<string, unknown>;
}

/** Re-read settings on each start. Untrusted project settings never affect network exposure. */
export function loadInspectorSettings(
	agentDir: string,
	cwd: string,
	projectTrusted: boolean,
): InspectorSettings {
	const paths = {
		global: join(agentDir, "settings.json"),
		project: join(cwd, ".pi", "settings.json"),
	};
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
	const errors = settings.drainErrors();
	if (errors.length > 0) {
		throw new Error(
			`pi-inspector: invalid settings in ${errors.map(({ scope, error }) => `${paths[scope]}: ${error.message}`).join("; ")}`,
			{ cause: errors[0]!.error },
		);
	}
	const value = {
		host: "127.0.0.1",
		port: 0,
		...inspectorSettings(settings.getGlobalSettings(), paths.global),
		...(projectTrusted ? inspectorSettings(settings.getProjectSettings(), paths.project) : {}),
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
