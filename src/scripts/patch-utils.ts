import { createLogger } from "./logger";

export type Cleanup = () => void;
export type PatchedMethod = (this: any, ...args: any[]) => any;

export function createCleanupStack(
	onError: (error: unknown) => void = () => {},
) {
	const cleanups: Cleanup[] = [];
	let disposed = false;
	const run = (cleanup: Cleanup): void => {
		try {
			cleanup();
		} catch (error) {
			onError(error);
		}
	};
	return {
		add(cleanup: Cleanup): void {
			if (disposed) run(cleanup);
			else cleanups.push(cleanup);
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			while (cleanups.length) run(cleanups.pop()!);
		},
	};
}

export function createWarningReporter(
	target: typeof globalThis,
	prefix: string,
	{
		maxKeys = Infinity,
		perKey = 1,
	}: { maxKeys?: number; perKey?: number } = {},
): (key: string, error?: unknown) => void {
	const counts = new Map<string, number>();
	const logger = createLogger(target);
	return (key, error) => {
		const count = counts.get(key) ?? 0;
		if (count >= perKey || (!counts.has(key) && counts.size >= maxKeys))
			return;
		counts.set(key, count + 1);
		try {
			if (error === undefined)
				logger.warn(`${prefix}${key ? `: ${key}` : ""}`);
			else logger.warn(`${prefix}${key ? ` (${key})` : ""}:`, error);
		} catch {}
	};
}

export function createMethodPatcher(addCleanup: (cleanup: Cleanup) => void) {
	const patched = new WeakMap<object, Set<string>>();
	return <T extends PatchedMethod>(
		owner: object,
		key: string,
		wrap: (original: T) => T,
	): boolean => {
		if (patched.get(owner)?.has(key)) return false;
		const descriptor = Object.getOwnPropertyDescriptor(owner, key);
		if (descriptor && !("value" in descriptor)) return false;
		const record = owner as Record<string, unknown>;
		const original = record[key];
		if (typeof original !== "function") return false;
		const replacement = wrap(original as T);
		Object.defineProperty(
			owner,
			key,
			descriptor
				? { ...descriptor, value: replacement }
				: {
						value: replacement,
						writable: true,
						configurable: true,
						enumerable: true,
					},
		);
		let keys = patched.get(owner);
		if (!keys) patched.set(owner, (keys = new Set()));
		keys.add(key);
		addCleanup(() => {
			if (record[key] !== replacement) return;
			if (descriptor) Object.defineProperty(owner, key, descriptor);
			else delete record[key];
		});
		return true;
	};
}
