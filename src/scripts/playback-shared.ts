import type { DownloadInfo, WebpackRequire } from "./types/script";

export function patchDownloadInfo(
	info: DownloadInfo | undefined,
	url: string,
): void {
	if (!info) return;
	Object.assign(info, {
		url,
		urls: [url],
		transport: "raw",
		codec: "mp3",
		key: "",
	});
}

export function createReplacementGuard(getUrl: (id: string) => string | null) {
	const tokens = new Map<string, { url: string }>();
	return {
		begin(id: string, url: string) {
			const token = { url };
			tokens.set(id, token);
			return () => tokens.get(id) === token && getUrl(id) === url;
		},
		refresh(): void {
			tokens.forEach((token, id) => {
				if (getUrl(id) !== token.url) tokens.delete(id);
			});
		},
	};
}

export async function fetchAudioBuffer(
	url: string,
	fetcher: typeof fetch = fetch,
	timeoutMs = 60000,
): Promise<ArrayBuffer> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				const response = await fetcher(url, {
					signal: controller.signal,
				});
				if (!response.ok)
					throw new Error(`Audio HTTP ${response.status}`);
				return response.arrayBuffer();
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					reject(new Error(`Audio download timed out: ${url}`));
					controller.abort();
				}, timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export function findWebpackModule<T>(
	require: WebpackRequire | undefined,
	predicate: (mod: unknown) => mod is T,
): T | null {
	if (!require?.m) {
		console.error("[FckCensor] appRequire.m is unavailable");
		return null;
	}
	for (const id of Object.keys(require.m)) {
		try {
			const mod: unknown = require(id);
			if (predicate(mod)) {
				console.log("[FckCensor] Found webpack module for patch:", id);
				return mod;
			}
		} catch (error) {
			console.debug(
				`[FckCensor] Failed to inspect webpack module ${id}:`,
				error,
			);
		}
	}
	return null;
}

export function decodeDuration(
	buffer: ArrayBuffer,
	Context: typeof AudioContext,
): Promise<number> {
	return new Promise((resolve, reject) => {
		let context: AudioContext | undefined;
		let settled = false;
		const finish = (duration: number | null, error?: unknown): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				void context?.close().catch(() => {});
			} catch {}
			if (duration !== null) resolve(duration);
			else reject(error);
		};
		const timer = setTimeout(
			() => finish(null, new Error("Audio decode timed out")),
			30000,
		);
		try {
			context = new Context();
			const decoding = context.decodeAudioData(
				buffer,
				(audio) => finish(audio.duration),
				(error) => finish(null, error),
			);
			void decoding?.catch((error) => finish(null, error));
		} catch (error) {
			finish(null, error);
		}
	});
}

export function createBoundedDiagnostics(limit = 3) {
	const counts = new Map<string, number>();
	return (key: string, error: unknown): void => {
		const count = counts.get(key) ?? 0;
		if (count >= limit) return;
		counts.set(key, count + 1);
		console.warn(
			`[FckCensor] ${key}${count + 1 === limit ? " (further warnings suppressed)" : ""}:`,
			error,
		);
	};
}
