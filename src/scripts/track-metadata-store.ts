import {
	createCleanupStack,
	createMethodPatcher,
	createWarningReporter,
} from "./patch-utils";
import type { TrackMetadataMap } from "./track-metadata";
import {
	type Schema,
	isRecord,
	schemaProperties,
	trackProperties,
	isExcludedMetadataField,
	mergeTrackMetadata,
} from "./track-metadata-schema";

type StoreNode = {
	type?: Schema;
	parent?: StoreNode;
	isAlive?: boolean;
	getChildren(): Iterable<StoreNode>;
	getSnapshot(): unknown;
	applyPatches(patches: unknown[]): void;
};
export type MetadataStoreContexts = {
	getRoot(): unknown;
	onRoot(callback: (root: unknown) => void): () => void;
};
export type MetadataStoreHandle = { refresh(): void; dispose(): void };
const installKey = Symbol.for("fckcensor.trackMetadata.store");
const limit = 50_000;

export function installTrackMetadataStore(
	getMetadata: () => TrackMetadataMap,
	target: typeof globalThis = globalThis,
	contexts?: MetadataStoreContexts,
): MetadataStoreHandle {
	const registry = target as unknown as {
		[installKey]?: MetadataStoreHandle;
	};
	registry[installKey]?.dispose();
	let root: StoreNode | undefined;
	let disposed = false;
	let applying = false;
	let unsubscribe: (() => void) | undefined;
	const warn = createWarningReporter(
		target,
		"[FckCensor] Cannot apply MST metadata",
		{ maxKeys: 10, perKey: 1 },
	);
	const cleanups = createCleanupStack((error) => warn("restore", error));
	const patchMethod = createMethodPatcher(cleanups.add);
	const belongs = (node: StoreNode | undefined): boolean => {
		const seen = new Set<StoreNode>();
		while (node && seen.size < limit && !seen.has(node)) {
			if (node === root) return root?.isAlive !== false;
			seen.add(node);
			node = node.parent;
		}
		return false;
	};
	const merge = (value: unknown, type?: Schema): unknown => {
		const props = trackProperties(type);
		if (!props || !isRecord(value) || value.id == null) return value;
		return mergeTrackMetadata(value, type, props, getMetadata(), (key) =>
			warn(key, "Value rejected by host schema; original field retained"),
		);
	};
	const apply = (node: StoreNode) => {
		if (!trackProperties(node.type) || node.isAlive === false) return;
		const snapshot = node.getSnapshot();
		const next = merge(snapshot, node.type);
		if (!isRecord(snapshot) || !isRecord(next)) return;
		for (const key of Object.keys(next)) {
			if (
				isExcludedMetadataField(key) ||
				JSON.stringify(snapshot[key]) === JSON.stringify(next[key])
			)
				continue;
			try {
				node.applyPatches([
					{
						op: "replace",
						path: `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
						value: next[key],
					},
				]);
			} catch (error) {
				warn(key, error);
			}
		}
	};
	type Method = (this: StoreNode & Schema, ...args: any[]) => any;
	const patch = (
		prototype: object,
		key: string,
		wrap: (original: Method) => Method,
	) => {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
		if (!descriptor || typeof descriptor.value !== "function") return;
		patchMethod<Method>(prototype, key, wrap);
	};
	const guardedMerge = (value: unknown, type?: Schema) => {
		try {
			return merge(value, type);
		} catch (error) {
			warn("normalize", error);
			return value;
		}
	};
	const hook = (node: StoreNode) => {
		patch(
			Object.getPrototypeOf(node),
			"emitPatch",
			(original) =>
				function (...args) {
					const result = original.apply(this, args);
					if (!disposed && !applying && belongs(this)) {
						applying = true;
						try {
							let current: StoreNode | undefined = this;
							const seen = new Set<StoreNode>();
							while (
								current &&
								seen.size < limit &&
								!seen.has(current)
							) {
								seen.add(current);
								if (trackProperties(current.type)) {
									apply(current);
									break;
								}
								current = current.parent;
							}
						} catch (error) {
							warn("change", error);
						} finally {
							applying = false;
						}
					}
					return result;
				},
		);
		if (!schemaProperties(node.type)) return;
		const prototype = Object.getPrototypeOf(node.type);
		patch(
			prototype,
			"instantiate",
			(original) =>
				function (...args) {
					if (!disposed && belongs(args[0]))
						args[3] = guardedMerge(args[3], this);
					return original.apply(this, args);
				},
		);
		patch(
			prototype,
			"applySnapshot",
			(original) =>
				function (...args) {
					if (!disposed && belongs(args[0]))
						args[1] = guardedMerge(args[1], this);
					return original.apply(this, args);
				},
		);
	};
	function refresh(): void {
		if (disposed || applying || !root || root.isAlive === false) return;
		applying = true;
		const pending = [root];
		const seen = new Set<StoreNode>();
		try {
			while (pending.length && seen.size < limit) {
				const node = pending.pop();
				if (!node || seen.has(node)) continue;
				seen.add(node);
				try {
					hook(node);
					apply(node);
					if (typeof node.getChildren === "function")
						for (const child of Array.from(node.getChildren()))
							if (pending.length < limit) pending.push(child);
				} catch (error) {
					warn("node", error);
				}
			}
		} finally {
			applying = false;
		}
	}
	const accept = (value: unknown) => {
		if (disposed) return;
		const node = isRecord(value) ? value.$treenode : undefined;
		root =
			isRecord(node) && typeof node.getChildren === "function"
				? (node as unknown as StoreNode)
				: undefined;
		refresh();
	};
	const handle: MetadataStoreHandle = {
		refresh,
		dispose() {
			if (disposed) return;
			disposed = true;
			try {
				unsubscribe?.();
			} catch (error) {
				warn("unsubscribe", error);
			}
			cleanups.dispose();
			root = undefined;
			if (registry[installKey] === handle) delete registry[installKey];
		},
	};
	registry[installKey] = handle;
	try {
		unsubscribe = contexts?.onRoot(accept);
		accept(contexts?.getRoot());
	} catch (error) {
		warn("context", error);
	}
	return handle;
}
