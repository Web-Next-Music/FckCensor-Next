import { logger } from "./logger";
import { createCleanupStack } from "./patch-utils";
import type {
	WebpackChunk,
	WebpackChunkEntry,
	WebpackRequire,
} from "./types/script";

type Factory = (
	this: unknown,
	module: { exports: unknown },
	exports: unknown,
	require: WebpackRequire,
) => unknown;
const originalFactory = Symbol.for("fckcensor.webpack.originalFactory");

export function factorySource(value: unknown): string {
	const seen = new Set<Function>();
	while (typeof value === "function") {
		if (seen.has(value)) return "";
		seen.add(value);
		const original = (value as unknown as Record<symbol, unknown>)[
			originalFactory
		];
		if (typeof original !== "function")
			return Function.prototype.toString.call(value);
		value = original;
	}
	return "";
}

export function webpackDependencies(
	source: string,
	require: WebpackRequire,
): string[] {
	const ids = new Set<string>();
	const calls = /\b[\w$]+\((\d+)\)/g;
	let match: RegExpExecArray | null;
	while ((match = calls.exec(source)) !== null) {
		if (Object.prototype.hasOwnProperty.call(require.m ?? {}, match[1]))
			ids.add(match[1]);
	}
	return Array.from(ids);
}

export function installWebpackPatch(
	require: WebpackRequire,
	chunks: WebpackChunk,
	matches: (source: string) => boolean,
	patch: (exports: unknown, source: string, require: WebpackRequire) => void,
	onError: (error: unknown) => void = (error) =>
		logger.warn("[FckCensor] Webpack patch skipped:", error),
): () => void {
	let disposed = false;
	const seen = new WeakSet<Function>();
	const cleanup = createCleanupStack(onError);
	const apply = (
		exports: unknown,
		source: string,
		appRequire: WebpackRequire,
	): void => {
		if (disposed) return;
		try {
			patch(exports, source, appRequire);
		} catch (error) {
			onError(error);
		}
	};
	const wrap = (
		factories: Record<string, unknown>,
	): Array<[string, string]> => {
		const selected: Array<[string, string]> = [];
		for (const id of Object.keys(factories)) {
			const factory = factories[id];
			const source = factorySource(factory);
			if (
				typeof factory !== "function" ||
				seen.has(factory) ||
				!matches(source)
			)
				continue;
			selected.push([id, source]);
			const wrapped: Factory = function (module, exports, appRequire) {
				const result = (factory as Factory).call(
					this,
					module,
					exports,
					appRequire,
				);
				apply(module.exports, source, appRequire);
				return result;
			};
			Object.defineProperty(wrapped, originalFactory, { value: factory });
			seen.add(wrapped);
			factories[id] = wrapped;
			cleanup.add(() => {
				if (factories[id] === wrapped) factories[id] = factory;
			});
		}
		return selected;
	};
	const selected = wrap(require.m ?? {});
	const originalPush: (...entries: WebpackChunkEntry[]) => number =
		chunks.push;
	const push = function (
		this: WebpackChunk,
		...entries: WebpackChunkEntry[]
	): number {
		if (!disposed)
			for (const entry of entries)
				if (entry && typeof entry[1] === "object" && entry[1])
					wrap(entry[1]);
		return originalPush.apply(this, entries);
	};
	chunks.push = push;
	cleanup.add(() => {
		if (chunks.push === push) chunks.push = originalPush;
	});
	for (const [id, source] of selected) {
		try {
			apply(require(id), source, require);
		} catch (error) {
			onError(error);
		}
	}
	return () => {
		if (disposed) return;
		disposed = true;
		cleanup.dispose();
	};
}
