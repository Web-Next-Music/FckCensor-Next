import { logger } from "../logger";
import type { PlaybackWindow } from "../types/script";
import { patchDownloadInfo, decodeDuration } from "../playback-shared";
import { LIST_URL, LIST_TIMEOUT_MS } from "../list-cache";
import { createAddonRuntime } from "../addon-runtime";

declare const unsafeWindow: Window & typeof globalThis;
declare function GM_xmlhttpRequest(details: {
	method: string;
	url: string;
	responseType?: string;
	timeout?: number;
	ontimeout?(): void;
	onabort?(): void;
	onload?(res: {
		status: number;
		responseText: string;
		response: unknown;
	}): void;
	onerror?(err: unknown): void;
}): { abort(): void } | void;

interface GmResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

interface AudioData {
	blobUrl: string;
	durationMs: number | null;
}

(function (): void {
	const pw =
		typeof unsafeWindow !== "undefined"
			? (unsafeWindow as PlaybackWindow)
			: (window as PlaybackWindow);

	const runtime = createAddonRuntime(pw);
	if (!runtime) return;
	const audioCache: Record<string, AudioData> = {};
	const audioPending: Partial<Record<string, Promise<AudioData | null>>> = {};

	function processRemoteAudio(url: string): Promise<AudioData | null> {
		if (audioCache[url]) return Promise.resolve(audioCache[url]);
		if (audioPending[url]) return audioPending[url];

		audioPending[url] = new Promise<AudioData | null>((resolve) => {
			let settled = false;
			let request: { abort(): void } | void;
			const finish = (data: AudioData | null): void => {
				if (settled) {
					if (data) URL.revokeObjectURL(data.blobUrl);
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve(data);
			};
			const timer = setTimeout(() => {
				finish(null);
				try {
					request?.abort();
				} catch {}
			}, 60000);
			try {
				request = GM_xmlhttpRequest({
					method: "GET",
					url,
					responseType: "arraybuffer",
					timeout: 60000,
					onload(res) {
						if (settled) return;
						clearTimeout(timer);
						if (res.status < 200 || res.status >= 300) {
							finish(null);
							return;
						}
						try {
							const buffer = res.response as ArrayBuffer;
							const blobUrl = URL.createObjectURL(
								new Blob([buffer], { type: "audio/mpeg" }),
							);
							void decodeDuration(
								buffer,
								pw.AudioContext || pw.webkitAudioContext,
							).then(
								(duration) =>
									finish({
										blobUrl,
										durationMs: Math.round(duration * 1000),
									}),
								() => finish({ blobUrl, durationMs: null }),
							);
						} catch (error) {
							logger.warn(
								"[FckCensor] processRemoteAudio blob failed:",
								error,
							);
							finish(null);
						}
					},
					onerror(error) {
						logger.warn(
							"[FckCensor] processRemoteAudio GM error:",
							error,
						);
						finish(null);
					},
					ontimeout() {
						finish(null);
					},
					onabort() {
						finish(null);
					},
				});
			} catch (error) {
				logger.warn("[FckCensor] processRemoteAudio failed:", error);
				finish(null);
			}
		})
			.then((data) => {
				if (data) audioCache[url] = data;
				return data;
			})
			.then(
				(data) => {
					delete audioPending[url];
					return data;
				},
				(error) => {
					delete audioPending[url];
					logger.warn("[FckCensor] Audio processing failed:", error);
					return null;
				},
			);

		return audioPending[url]!;
	}

	function gmFetch(url: string): Promise<GmResponse> {
		return new Promise((resolve, reject) => {
			let settled = false;
			let request: { abort(): void } | void;
			const fail = (error: unknown, abort = false): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
				if (abort) {
					try {
						request?.abort();
					} catch {}
				}
			};
			const timeout = (): void =>
				fail(new Error("List v2 request timed out"), true);
			const timer = setTimeout(timeout, LIST_TIMEOUT_MS);
			try {
				request = GM_xmlhttpRequest({
					method: "GET",
					url,
					timeout: LIST_TIMEOUT_MS,
					onload(res) {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						resolve({
							ok: res.status >= 200 && res.status < 300,
							status: res.status,
							json: async () => JSON.parse(res.responseText),
						});
					},
					onerror: (error) => fail(error),
					ontimeout: timeout,
					onabort: () => fail(new Error("List v2 request aborted")),
				});
			} catch (error) {
				fail(error);
			}
		});
	}

	async function fetchList(): Promise<unknown> {
		const response = await gmFetch(LIST_URL);
		if (!response.ok) throw new Error(`List HTTP ${response.status}`);
		return response.json();
	}

	runtime.loadTracks(() => fetchList());
	runtime.replaceFileInfo(async (id, info) => {
		const url = runtime.getReplacement(id);
		if (!url) return;
		const isCurrent = runtime.beginReplacement(id, url);
		const audioData = await processRemoteAudio(url);
		if (!audioData || !isCurrent()) return;
		patchDownloadInfo(info, audioData.blobUrl);
		if (audioData.durationMs != null)
			runtime.setDuration(id, url, audioData.durationMs);
	}, true);
})();
