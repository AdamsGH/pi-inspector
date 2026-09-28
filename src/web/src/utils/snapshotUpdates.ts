import type { SessionSnapshot } from "../types.ts";

export type SnapshotUpdate = SessionSnapshot | { error: { message: string } };

/** Order HTTP refreshes against SSE updates, including errors and recovery. */
export function createSnapshotUpdates(apply: (update: SnapshotUpdate) => void) {
	let generation = 0;
	return {
		receive(update: SnapshotUpdate): void {
			generation++;
			apply(update);
		},
		async refresh(fetchUpdate: () => Promise<SnapshotUpdate>): Promise<void> {
			const requested = ++generation;
			const update = await fetchUpdate();
			if (requested === generation) apply(update);
		},
		cancel(): void {
			generation++;
		},
	};
}
