import { useEffect, useState, useCallback } from "react";
import type { SessionSnapshot } from "../types.ts";
import { createSnapshotUpdates, type SnapshotUpdate } from "../utils/snapshotUpdates.ts";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export function useInspectEvents() {
	const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
	const [status, setStatus] = useState<ConnectionStatus>("connecting");
	const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
	const [snapshotError, setSnapshotError] = useState<string | null>(null);
	const [updates] = useState(() =>
		createSnapshotUpdates((data) => {
			if ("error" in data) {
				setSnapshotError(data.error.message);
				return;
			}
			setSnapshotError(null);
			if (Object.keys(data).length > 0) {
				setSnapshot(data);
				setLastUpdated(new Date(data.capturedAt || Date.now()));
			}
		}),
	);

	const fetchSnapshot = useCallback(async () => {
		try {
			await updates.refresh(async () => {
				const res = await fetch("/snapshot");
				const data = (await res.json()) as SnapshotUpdate;
				if (!res.ok) {
					return {
						error: {
							message:
								"error" in data ? data.error.message : "Snapshot unavailable. Refresh to retry.",
						},
					};
				}
				return data;
			});
		} catch {
			// A failed request must not replace the last delivered snapshot or error.
		}
	}, [updates]);

	useEffect(() => {
		let isMounted = true;
		setStatus("connecting");
		fetchSnapshot();
		const es = new EventSource("/events");

		const handleOpen = () => {
			if (isMounted) setStatus("connected");
		};
		const handleError = () => {
			if (isMounted) setStatus("disconnected");
		};
		const handleMessage = (ev: MessageEvent) => {
			if (!isMounted) return;
			try {
				const data = JSON.parse(ev.data) as SnapshotUpdate;
				updates.receive(data);
				setStatus("connected");
			} catch {
				// Ignore malformed snapshot chunks.
			}
		};
		es.addEventListener("open", handleOpen);
		es.addEventListener("error", handleError);
		es.addEventListener("message", handleMessage);

		return () => {
			isMounted = false;
			updates.cancel();
			es.removeEventListener("open", handleOpen);
			es.removeEventListener("error", handleError);
			es.removeEventListener("message", handleMessage);
			es.close();
		};
	}, [fetchSnapshot, updates]);

	return { snapshot, snapshotError, status, lastUpdated, refresh: fetchSnapshot };
}
