import type { PlaybackWindow } from "../types/script";
import {
	patchDownloadInfo,
	decodeDuration,
	fetchAudioBuffer,
} from "../playback-shared";
import { LIST_URL, LIST_TIMEOUT_MS } from "../list-cache";
import { createAddonRuntime } from "../addon-runtime";

(function (): void {
	const installedRuntime = createAddonRuntime(window as PlaybackWindow);
	if (!installedRuntime) return;
	const runtime = installedRuntime;
	const durationCache = new Map<string, number>();
	const durationPending = new Map<string, Promise<number | null>>();
	function fetchDuration(url: string): Promise<number | null> {
		if (durationCache.has(url))
			return Promise.resolve(durationCache.get(url)!);
		const pending = durationPending.get(url);
		if (pending) return pending;
		const request = fetchAudioBuffer(url)
			.then((buffer) =>
				decodeDuration(
					buffer,
					window.AudioContext ||
						(window as PlaybackWindow).webkitAudioContext,
				),
			)
			.then((duration) => {
				durationCache.set(url, duration);
				return duration;
			})
			.catch((error) => {
				console.warn("[FckCensor] fetchDuration failed:", error);
				return null;
			})
			.then((duration) => {
				durationPending.delete(url);
				return duration;
			});
		durationPending.set(url, request);
		return request;
	}

	(window as PlaybackWindow).__fckCensorDuration =
		(window as PlaybackWindow).__fckCensorDuration ?? {};
	const _fckPendingDuration = new Map<
		string,
		{ url: string; isCurrent: () => boolean }
	>();

	function applyDuration(
		trackId: string | number,
		replacedUrl: string,
	): void {
		const id = String(trackId);
		const pending = _fckPendingDuration.get(id);
		if (pending?.url === replacedUrl && pending.isCurrent()) return;
		const isCurrent = runtime.beginReplacement(id, replacedUrl);
		const token = { url: replacedUrl, isCurrent };
		_fckPendingDuration.set(id, token);
		fetchDuration(replacedUrl).then((dur) => {
			if (_fckPendingDuration.get(id) === token)
				_fckPendingDuration.delete(id);
			if (dur == null || !isCurrent()) return;
			const durationMs = Math.round(dur * 1000);
			(window as PlaybackWindow).__fckCensorDuration[id] = durationMs;
			runtime.setDuration(trackId, replacedUrl, durationMs);
		});
	}

	async function fetchList(url: string): Promise<unknown> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				(async () => {
					const response = await fetch(url, {
						signal: controller.signal,
					});
					if (!response.ok)
						throw new Error(`List HTTP ${response.status}`);
					return response.json();
				})(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						reject(new Error(`List request timed out: ${url}`));
						controller.abort();
					}, LIST_TIMEOUT_MS);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	runtime.loadTracks(() => fetchList(LIST_URL));
	runtime.replaceFileInfo((id, info) => {
		const url = runtime.getReplacement(id);
		if (!url) return;
		patchDownloadInfo(info, url);
		applyDuration(id, url);
	});
})();
