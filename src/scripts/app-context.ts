import {
	createCleanupStack,
	createMethodPatcher,
	createWarningReporter,
} from "./patch-utils";
import type { WebpackChunk, WebpackRequire } from "./types/script";
import {
	factorySource,
	installWebpackPatch,
	webpackDependencies,
} from "./webpack-patches";

type RecordValue = Record<string, unknown>;
export interface AppContexts {
	getRoot(): unknown;
	getSonata(): unknown;
	onRoot(callback: (root: unknown) => void): () => void;
	onSonata(callback: (sonata: unknown) => void): () => void;
	dispose(): void;
}
const installKey = Symbol.for("fckcensor.appContexts");
const object = (value: unknown): value is RecordValue =>
	value !== null && typeof value === "object";
const rootValue = (value: unknown): boolean =>
	object(value) && value.isRootModel === true && object(value.$treenode);
const sonataValue = (value: unknown): boolean =>
	object(value) &&
	object(value.playbackController) &&
	typeof value.getState === "function";

export function installAppContexts(
	require: WebpackRequire,
	chunks: WebpackChunk,
	target: typeof globalThis = globalThis,
): AppContexts {
	const registry = target as unknown as { [installKey]?: AppContexts };
	registry[installKey]?.dispose();
	let disposed = false;
	let root: unknown;
	let sonata: unknown;
	const rootListeners = new Set<(value: unknown) => void>();
	const sonataListeners = new Set<(value: unknown) => void>();
	const seen = new WeakSet<object>();
	const contexts = new WeakSet<object>();
	const reportWarning = createWarningReporter(
		target,
		"[FckCensor] Application context patch skipped",
		{ maxKeys: 1 },
	);
	const warn = (error: unknown): void => reportWarning("", error);
	const cleanup = createCleanupStack(warn);
	const patchMethod = createMethodPatcher(cleanup.add);
	const publish = (value: unknown): void => {
		if (disposed) return;
		const isRoot = rootValue(value);
		if (!isRoot && !sonataValue(value)) return;
		if ((isRoot ? root : sonata) === value) return;
		if (isRoot) root = value;
		else sonata = value;
		void Promise.resolve().then(() => {
			if (disposed || (isRoot ? root : sonata) !== value) return;
			for (const callback of Array.from(
				isRoot ? rootListeners : sonataListeners,
			)) {
				try {
					callback(value);
				} catch (error) {
					warn(error);
				}
			}
		});
	};
	const patchContext = (
		exports: unknown,
		source: string,
		appRequire: WebpackRequire,
	): void => {
		if (!object(exports)) return;
		const reactCandidates = webpackDependencies(source, appRequire)
			.map((id) => appRequire(id) as unknown)
			.filter(
				(value) =>
					object(value) &&
					typeof value.createElement === "function" &&
					typeof value.useContext === "function",
			);
		if (reactCandidates.length !== 1) return;
		const react = reactCandidates[0] as {
			createElement(type: unknown, props: unknown): unknown;
			useContext(this: unknown, context: unknown): unknown;
		};
		patchMethod<typeof react.useContext>(
			react,
			"useContext",
			(original) =>
				function (context) {
					const value = original.call(this, context);
					if (!disposed && object(context) && contexts.has(context))
						publish(value);
					return value;
				},
		);
		for (const key of Object.keys(exports)) {
			const context = exports[key];
			if (
				!object(context) ||
				context.$$typeof !== Symbol.for("react.context") ||
				!context.Provider ||
				seen.has(context)
			)
				continue;
			contexts.add(context);
			const original = context.Provider;
			const Provider = (props: RecordValue): unknown => {
				if (!disposed) publish(props.value);
				return react.createElement(original, props);
			};
			context.Provider = Provider;
			seen.add(context);
			cleanup.add(() => {
				if (context.Provider === Provider) context.Provider = original;
			});
			publish(context._currentValue);
			publish(context._currentValue2);
		}
	};
	const unpatch = installWebpackPatch(
		require,
		chunks,
		(source) =>
			source.includes("E_CONTEXT_STORE_NULL") ||
			(source.includes("SonataProvider") &&
				source.includes("registerMediaPlayer") &&
				source.includes("playbackController")),
		(exports, source, appRequire) => {
			if (source.includes("E_CONTEXT_STORE_NULL")) {
				patchContext(exports, source, appRequire);
				return;
			}
			for (const id of webpackDependencies(source, appRequire)) {
				const dependency = factorySource(appRequire.m?.[id]);
				if (
					dependency.length < 2000 &&
					dependency.includes("createContext") &&
					dependency.includes("useContext")
				)
					patchContext(appRequire(id), dependency, appRequire);
			}
		},
		warn,
	);
	const subscribe = (
		listeners: Set<(value: unknown) => void>,
		callback: (value: unknown) => void,
		current: unknown,
	): (() => void) => {
		listeners.add(callback);
		if (current !== undefined) callback(current);
		return () => listeners.delete(callback);
	};
	const handle: AppContexts = {
		getRoot: () => root,
		getSonata: () => sonata,
		onRoot: (callback) => subscribe(rootListeners, callback, root),
		onSonata: (callback) => subscribe(sonataListeners, callback, sonata),
		dispose() {
			if (disposed) return;
			disposed = true;
			unpatch();
			cleanup.dispose();
			rootListeners.clear();
			sonataListeners.clear();
			root = undefined;
			sonata = undefined;
			if (registry[installKey] === handle) delete registry[installKey];
		},
	};
	registry[installKey] = handle;
	return handle;
}
