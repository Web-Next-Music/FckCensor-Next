import { createCleanupStack, createWarningReporter } from "./patch-utils";
import type { WebpackChunk, WebpackRequire } from "./types/script";
import {
	factorySource,
	installWebpackPatch,
	webpackDependencies,
} from "./webpack-patches";

export type BadgeHandle = { refresh(): void; dispose(): void };
type RecordValue = Record<string, unknown>;
type Render = (props: RecordValue, ref?: unknown) => unknown;
interface AppReact {
	createElement(
		type: unknown,
		props: unknown,
		...children: unknown[]
	): unknown;
	Fragment: unknown;
	useSyncExternalStore(
		subscribe: (listener: () => void) => () => void,
		snapshot: () => number,
		serverSnapshot: () => number,
	): number;
}
interface BadgeRuntime {
	react: AppReact;
	tooltip: unknown;
	icon: unknown;
	classes: RecordValue;
}
const installKey = Symbol.for("fckcensor.trackBadges.installer");
const tooltipText = "This track is included in the FckCensor lists";
const object = (value: unknown): value is RecordValue =>
	value !== null && typeof value === "object";
export function isTrackMetaFactory(source: string): boolean {
	return [
		"afterTitle",
		"withExplicitMark",
		"getDescriptionTexts",
		"explicitMarkContainer",
		"track:",
	].every((token) => source.includes(token));
}

function resolveRuntime(
	source: string,
	require: WebpackRequire,
): BadgeRuntime | undefined {
	const factories = require.m ?? {};
	const dependencies = webpackDependencies(source, require);
	const unique = (
		ids: string[],
		predicate: (source: string) => boolean,
	): string | undefined => {
		const matches = ids.filter((id) =>
			predicate(factorySource(factories[id])),
		);
		return matches.length === 1 ? matches[0] : undefined;
	};
	const cssId = unique(dependencies, (value) =>
		value.includes('"Meta_explicitMarkContainer__'),
	);
	const explicitId = unique(dependencies, (value) =>
		[
			"iconVariant",
			"descriptionText",
			"isTooltipEnabled",
			"getDescriptionTexts",
		].every((token) => value.includes(token)),
	);
	if (!cssId || !explicitId) return;
	const explicitDependencies = webpackDependencies(
		factorySource(factories[explicitId]),
		require,
	);
	const tooltipId = unique(explicitDependencies, (value) =>
		["description", "shiftOptions", "flipOptions", "placement"].every(
			(token) => value.includes(token),
		),
	);
	const iconId = unique(
		explicitDependencies,
		(value) =>
			value.includes("/icons/sprite.svg#edit_") &&
			value.includes("variant"),
	);
	const reactIds = dependencies.filter((id) => {
		let value = factorySource(factories[id]);
		for (let depth = 0; depth < 3; depth++) {
			if (
				["createElement", "useSyncExternalStore", "useState"].every(
					(token) => value.includes(token),
				)
			)
				return true;
			const nested = webpackDependencies(value, require);
			if (nested.length !== 1 || !value.includes(".exports="))
				return false;
			value = factorySource(factories[nested[0]]);
		}
		return false;
	});
	if (!tooltipId || !iconId) return;
	const reactModules = reactIds
		.map((id) => require(id) as AppReact)
		.filter(
			(value) =>
				typeof value?.createElement === "function" &&
				typeof value?.useSyncExternalStore === "function",
		);
	if (reactModules.length !== 1) return;
	const react = reactModules[0];
	const classes: unknown = require(cssId);
	const component = (id: string): unknown => {
		const exports: unknown = require(id);
		if (!object(exports)) return;
		const values = Object.keys(exports)
			.map((key) => exports[key])
			.filter(
				(value) =>
					typeof value === "function" ||
					(object(value) && value.$$typeof),
			);
		return values.length === 1 ? values[0] : undefined;
	};
	const tooltip = component(tooltipId);
	const icon = component(iconId);
	if (
		!object(classes) ||
		typeof classes.explicitMark !== "string" ||
		typeof classes.explicitMarkContainer !== "string" ||
		typeof react.createElement !== "function" ||
		typeof react.useSyncExternalStore !== "function" ||
		!tooltip ||
		!icon
	)
		return;
	return { react, classes, tooltip, icon };
}

export function installTrackBadges(
	isListed: (id: string) => boolean,
	target: typeof globalThis = globalThis,
	require?: WebpackRequire,
	chunks?: WebpackChunk,
): BadgeHandle {
	const registry = target as unknown as { [installKey]?: BadgeHandle };
	registry[installKey]?.dispose();
	let disposed = false;
	let revision = 0;
	const listeners = new Set<() => void>();

	const seen = new WeakSet<object>();
	const warn = createWarningReporter(
		target,
		"[FckCensor] Track badge patch skipped",
	);
	const cleanup = createCleanupStack((error) => warn("restore", error));
	const snapshot = (): number => revision;
	const subscribe = (listener: () => void): (() => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	const patchExports = (
		exports: unknown,
		source: string,
		appRequire: WebpackRequire,
	): void => {
		if (disposed || !object(exports)) return;
		const candidates = Object.keys(exports)
			.map((key) => exports[key])
			.filter(
				(value) =>
					object(value) &&
					value.$$typeof === Symbol.for("react.memo") &&
					typeof value.type === "function",
			);
		if (candidates.length !== 1) {
			warn("unrecognized track component exports");
			return;
		}
		const memo = candidates[0] as RecordValue;
		if (seen.has(memo)) return;
		const runtime = resolveRuntime(source, appRequire);
		if (!runtime) {
			warn("native icon/tooltip dependencies changed");
			return;
		}
		const { react, classes } = runtime;
		const Badge = (props: RecordValue): unknown => {
			react.useSyncExternalStore(subscribe, snapshot, snapshot);
			if (disposed || !object(props.track)) return null;
			const id = props.track.id;
			if (
				(typeof id !== "string" && typeof id !== "number") ||
				!isListed(String(id))
			)
				return null;
			const stopClick = (event: {
				preventDefault(): void;
				stopPropagation(): void;
			}): void => {
				event.preventDefault();
				event.stopPropagation();
			};
			return react.createElement(
				runtime.tooltip,
				{
					description: tooltipText,
					enabled: true,
					placement: "bottom-start",
				},
				react.createElement(
					"span",
					{
						className: classes.explicitMarkContainer,
						"data-fckcensor-track-badge": "",
						"aria-label": tooltipText,
						role: "img",
						tabIndex: 0,
						onClick: stopClick,
						onKeyDown: (event: {
							key: string;
							stopPropagation(): void;
						}): void => {
							if (event.key === "Enter" || event.key === " ")
								event.stopPropagation();
						},
					},
					react.createElement(runtime.icon, {
						className: classes.explicitMark,
						variant: "edit",
						size: "xxs",
						"aria-hidden": true,
					}),
				),
			);
		};
		const original = memo.type as Render;
		const patched: Render = (props, ref) => {
			if (disposed) return original(props, ref);
			return original(
				{
					...props,
					afterTitle: react.createElement(
						react.Fragment,
						null,
						react.createElement(Badge, {
							track: props.track,
							key: "fckcensor-badge",
						}),
						props.afterTitle,
					),
				},
				ref,
			);
		};
		memo.type = patched;
		seen.add(memo);
		cleanup.add(() => {
			if (memo.type === patched) memo.type = original;
		});
	};
	if (require?.m && chunks) {
		cleanup.add(
			installWebpackPatch(
				require,
				chunks,
				isTrackMetaFactory,
				(exports, source, appRequire) => {
					try {
						patchExports(exports, source, appRequire);
					} catch {
						warn("unsupported track component");
					}
				},
				() => warn("track module not available"),
			),
		);
	} else warn("webpack runtime unavailable");
	const handle: BadgeHandle = {
		refresh() {
			if (!disposed) {
				revision++;
				for (const listener of Array.from(listeners)) listener();
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			revision++;
			for (const listener of Array.from(listeners)) listener();
			listeners.clear();
			cleanup.dispose();
			if (registry[installKey] === handle) delete registry[installKey];
		},
	};
	registry[installKey] = handle;
	return handle;
}
