import type { AppContexts } from "./app-context";
import {
	createCleanupStack,
	createMethodPatcher,
	createWarningReporter,
} from "./patch-utils";
import {
	applyTrackMetadataToTrack,
	type TrackMetadataMap,
} from "./track-metadata";
import type { WebpackChunk, WebpackRequire } from "./types/script";
import { factorySource, installWebpackPatch } from "./webpack-patches";

type RecordValue = Record<string, unknown>;
type Method = (this: unknown, ...args: unknown[]) => unknown;
export interface TrackDurationHandle {
	set(id: string | number, url: string, ms: number): void;
	refresh(): void;
	dispose(): void;
}
const installKey = Symbol.for("fckcensor.trackDuration");
const object = (value: unknown): value is RecordValue =>
	value !== null && typeof value === "object";
const own = (value: object, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(value, key);
const isPlainTrackMetadata = (value: unknown): value is RecordValue => {
	if (!object(value) || !own(value, "id")) return false;
	const prototype = Object.getPrototypeOf(value);
	return (
		(prototype === Object.prototype || prototype === null) &&
		(typeof value.id === "string" || typeof value.id === "number") &&
		["durationMs", "artists", "realId"].some((key) => own(value, key))
	);
};
const method = (value: RecordValue, key: string): boolean =>
	typeof value[key] === "function";

function cloneTrackMetadata(meta: RecordValue): RecordValue {
	// API metadata may be shared or frozen; omit runtime fields before cloning.
	const plain: RecordValue = {};
	for (const key of Object.keys(meta))
		if (!key.startsWith("$"))
			Object.defineProperty(plain, key, {
				value: meta[key],
				enumerable: true,
			});
	return JSON.parse(JSON.stringify(plain)) as RecordValue;
}

function decorateTrackMetadata(
	meta: RecordValue,
	getMetadata: () => TrackMetadataMap,
	getDuration: (id: string) => number | undefined,
): RecordValue {
	const copy = cloneTrackMetadata(meta);
	applyTrackMetadataToTrack(copy, getMetadata());
	if (typeof copy.id === "string" || typeof copy.id === "number") {
		const ms = getDuration(String(copy.id));
		if (ms !== undefined) copy.durationMs = ms;
	}
	return copy;
}

export function installTrackDuration(
	getReplacement: (id: string) => string | null,
	getMetadata: () => TrackMetadataMap,
	contexts: AppContexts,
	require: WebpackRequire,
	chunks: WebpackChunk,
	target: typeof globalThis = globalThis,
): TrackDurationHandle {
	const registry = target as unknown as {
		[installKey]?: TrackDurationHandle;
	};
	registry[installKey]?.dispose();
	let disposed = false;
	const reportWarning = createWarningReporter(
		target,
		"[FckCensor] Track duration patch skipped",
		{ maxKeys: 1 },
	);
	const warn = (error: unknown): void => reportWarning("", error);
	const cleanup = createCleanupStack(warn);
	const patchMethod = createMethodPatcher(cleanup.add);
	const cache = new Map<string, { url: string; ms: number }>();
	const playbacks = new Set<RecordValue>();
	const queues = new Set<RecordValue>();

	const safely = (run: () => void): void => {
		try {
			if (!disposed) run();
		} catch (error) {
			warn(error);
		}
	};
	const duration = (id: string): number | undefined => {
		const entry = cache.get(id);
		if (!entry) return undefined;
		if (getReplacement(id) === entry.url) return entry.ms;
		cache.delete(id);
		return undefined;
	};
	const decorate = (meta: RecordValue): RecordValue => {
		return decorateTrackMetadata(meta, getMetadata, duration);
	};
	const update = (value: unknown, seen = new Set<object>()): void => {
		if (!object(value) || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) safely(() => update(item, seen));
			return;
		}
		safely(() => {
			if (isPlainTrackMetadata(value.meta))
				value.meta = decorate(value.meta);
			else if (isPlainTrackMetadata(value)) {
				const next = decorate(value);
				for (const key of Object.keys(next))
					if (value[key] !== next[key]) value[key] = next[key];
			}
		});
		// Entity wrappers can have their own id and cyclic runtime state.
		// A failed metadata patch must not prevent reaching their raw data.
		for (const key of ["entity", "entityData", "data"])
			safely(() => {
				if (object(value[key])) update(value[key], seen);
			});
	};
	const wrap = (
		owner: RecordValue,
		key: string,
		before: (self: unknown, args: unknown[]) => void,
		after?: (self: unknown, result: unknown) => void,
	): void => {
		patchMethod<Method>(
			owner,
			key,
			(original) =>
				function (...args) {
					safely(() => before(this, args));
					const result = original.apply(this, args);
					if (after) safely(() => after(this, result));
					return result;
				},
		);
	};
	const patchFactory = (factory: unknown): void => {
		if (!object(factory) || !method(factory, "createEntity")) return;
		wrap(
			factory,
			"createEntity",
			(_self, args) => {
				// Replace the argument rather than mutating metadata owned by the API.
				if (object(args[0])) {
					const input = args[0];
					if (isPlainTrackMetadata(input.meta))
						args[0] = { ...input, meta: decorate(input.meta) };
					else if (isPlainTrackMetadata(input))
						args[0] = decorate(input);
				}
			},
			(_self, result) => update(result),
		);
	};
	const patchQueue = (queue: unknown): void => {
		if (!object(queue)) return;
		queues.add(queue);
		wrap(queue, "setEntityList", (self, args) => {
			if (object(self)) queues.add(self);
			update(args[0]);
		});
	};
	const capture = (playback: unknown): void => {
		if (!object(playback)) return;
		playbacks.add(playback);
		if (object(playback.contextController))
			patchFactory(playback.contextController.factory);
		if (object(playback.queueController)) {
			patchQueue(playback.queueController.playerQueue);
			patchQueue(playback.queueController.queue);
		}
	};
	const discover = (): void => {
		const sonata = contexts.getSonata();
		if (!object(sonata) || !object(sonata.playbackController)) return;
		const available = sonata.playbackController.availablePlaybacks;
		const values =
			available instanceof Map || available instanceof Set
				? Array.from(available.values())
				: Array.isArray(available)
					? available
					: object(available)
						? Object.keys(available).map((key) => available[key])
						: [];
		for (const playback of values) safely(() => capture(playback));
	};
	const updateRoot = (): void => {
		const root = contexts.getRoot();
		if (
			!object(root) ||
			!object(root.sonataState) ||
			!object(root.sonataState.entityMeta)
		)
			return;
		const meta = root.sonataState.entityMeta;
		if (
			(typeof meta.id !== "string" && typeof meta.id !== "number") ||
			!own(meta, "durationMs")
		)
			return;
		const ms = duration(String(meta.id));
		if (ms === undefined || meta.durationMs === ms) return;
		const node = meta.$treenode;
		if (object(node) && method(node, "applyPatches")) {
			// Only patch declared MST properties: snapshots silently discard unknown fields.
			const type = node.type;
			const properties =
				object(type) && object(type.properties)
					? type.properties
					: undefined;
			if (properties && !own(properties, "durationMs")) return;
			(node.applyPatches as Method).call(node, [
				{ op: "replace", path: "/durationMs", value: ms },
			]);
		} else if (!node) meta.durationMs = ms;
	};
	const refreshQueue = (queue: RecordValue): void => {
		for (const key of ["state", "queueState"]) {
			const state = queue[key];
			if (object(state) && object(state.entityList))
				update(state.entityList.value);
		}
	};
	const refresh = (): void =>
		safely(() => {
			for (const id of Array.from(cache.keys()))
				safely(() => {
					duration(id);
				});
			discover();
			for (const playback of Array.from(playbacks))
				safely(() => capture(playback));
			for (const queue of Array.from(queues))
				safely(() => {
					refreshQueue(queue);
				});
			safely(updateRoot);
		});
	const patchPlaybackPrototype = (proto: RecordValue): void => {
		for (const key of [
			"setContext",
			"restartContext",
			"injectLast",
			"registerMediaPlayer",
			"getEntityByIndex",
		]) {
			wrap(
				proto,
				key,
				(self) => capture(self),
				(self) => capture(self),
			);
		}
	};
	const patchExports = (exports: unknown): void => {
		const values =
			typeof exports === "function"
				? [exports]
				: object(exports)
					? Object.keys(exports).map((key) => exports[key])
					: [];
		for (const value of values) {
			if (
				typeof value !== "function" ||
				!factorySource(value) ||
				!object(value.prototype)
			)
				continue;
			const proto = value.prototype;
			if (
				method(proto, "setEntityList") &&
				method(proto, "setOrder") &&
				method(proto, "createOrder") &&
				method(proto, "getEntityByIndex")
			)
				patchQueue(proto);
			if (
				method(proto, "setContext") &&
				method(proto, "restartContext") &&
				method(proto, "getEntityByIndex")
			) {
				patchPlaybackPrototype(proto);
			}
		}
	};
	const handle: TrackDurationHandle = {
		set(id, url, ms) {
			safely(() => {
				const key = String(id);
				if (
					!Number.isFinite(ms) ||
					ms <= 0 ||
					!url ||
					getReplacement(key) !== url
				)
					return;
				cache.set(key, { url, ms });
				refresh();
			});
		},
		refresh,
		dispose() {
			if (disposed) return;
			disposed = true;
			cleanup.dispose();
			cache.clear();
			playbacks.clear();
			queues.clear();
			if (registry[installKey] === handle) delete registry[installKey];
		},
	};
	registry[installKey] = handle;
	safely(() => {
		cleanup.add(
			installWebpackPatch(
				require,
				chunks,
				(source) =>
					source.includes("E_CREATE_PLAYER_CONTROLLERS") ||
					[
						"setEntityList",
						"setOrder",
						"createOrder",
						"getEntityByIndex",
					].every((token) => source.includes(token)),
				(exports) => patchExports(exports),
				warn,
			),
		);
	});
	safely(() => {
		cleanup.add(contexts.onRoot(refresh));
	});
	safely(() => {
		cleanup.add(contexts.onSonata(refresh));
	});
	refresh();
	return handle;
}
