import type { Track } from "./types/track";
import type { NextMusicApi } from "./types/api";
import type { M3UResult } from "./types/m3u";
import type {
	WebpackRequire,
	WebpackChunk,
	FileInfoServiceProto,
	QueueEntityEntry,
	GetFileInfoParams,
	GetFileInfoBatchParams,
	FileInfoResult,
	FileInfoBatchResult,
	PatchedNextMusicApi,
} from "./types/script";

(function (): void {
	let webpackGlobal: WebpackChunk;
	let appRequire: WebpackRequire | undefined;
	let fileInfoModule: { v?: { prototype: FileInfoServiceProto } };

	try {
		webpackGlobal = (window as any).webpackChunk_N_E;
		if (!webpackGlobal) {
			console.error("[FckCensor] webpackChunk_N_E not found, aborting");
			return;
		}
	} catch (e) {
		console.error("[FckCensor] Failed to access webpackChunk_N_E:", e);
		return;
	}

	try {
		webpackGlobal.push([
			[Symbol("requireGetter__FckCensor")],
			{},
			(r: WebpackRequire) => {
				appRequire = r;
			},
		]);
		webpackGlobal.pop();
	} catch (e) {
		console.error("[FckCensor] Failed to get appRequire:", e);
		return;
	}

	if (!appRequire) {
		console.error("[FckCensor] appRequire is null, aborting");
		return;
	}

	try {
		fileInfoModule = appRequire(63974);
	} catch (e) {
		console.error("[FckCensor] Failed to require module 63974:", e);
		return;
	}

	if (!fileInfoModule?.v) {
		console.error(
			"[FckCensor] FileInfo module (63974) has no .v, aborting",
		);
		return;
	}

	let remoteTracks: Record<string, string> = {};

	function getReplaced(trackId: string | number): string | null {
		try {
			if (!trackId) return null;
			return remoteTracks[String(trackId)] ?? null;
		} catch {
			return null;
		}
	}

	function extractIdFromUrl(url: string): string | null {
		try {
			const u = new URL(url);
			const qid =
				u.searchParams.get("track_id") || u.searchParams.get("id");

			if (qid && /^\d+$/.test(qid)) return qid;

			const segments = u.pathname.split("/").filter(Boolean);
			const last = segments[segments.length - 1] ?? "";
			const m = last.match(/^(\d+)/);
			if (m) return m[1];
		} catch {}
		return null;
	}

	function parseM3U(text: string): M3UResult {
		const lines = text.split(/\r?\n/);
		const result: Record<string, string> = {};

		let pendingArtist = "";
		let pendingTitle = "";
		let pendingCover = "";

		for (const raw of lines) {
			const line = raw.trim();
			if (!line || line === "#EXTM3U") continue;

			if (line.startsWith("#EXTINF:")) {
				const comma = line.indexOf(",");
				if (comma !== -1) {
					const attrs = line.slice(8, comma);
					const info = line.slice(comma + 1).trim();
					const logoMatch = attrs.match(/tvg-logo=["']([^"']+)["']/);

					if (logoMatch) pendingCover = logoMatch[1].trim();

					const dash = info.indexOf(" - ");
					if (dash !== -1) {
						pendingArtist = info.slice(0, dash).trim();
						pendingTitle = info.slice(dash + 3).trim();
					} else {
						pendingArtist = "";
						pendingTitle = info;
					}
				}
				continue;
			}

			if (line.startsWith("#EXTIMG:")) {
				pendingCover = line.slice(8).trim();
				continue;
			}

			if (line.startsWith("http://") || line.startsWith("https://")) {
				const id = extractIdFromUrl(line);
				if (id) result[id] = line;

				pendingArtist = "";
				pendingTitle = "";
				pendingCover = "";
			}
		}

		return { tracks: result };
	}

	const durationCache: Record<string, number> = {};

	function fetchDuration(url: string): Promise<number | null> {
		if (durationCache[url] !== undefined) {
			return Promise.resolve(durationCache[url]);
		}

		return fetch(url)
			.then((r) => r.arrayBuffer())
			.then(
				(buf) =>
					new Promise<number>((resolve, reject) => {
						try {
							const AudioContextClass =
								window.AudioContext ||
								((window as any)
									.webkitAudioContext as typeof AudioContext);
							const ctx = new AudioContextClass();
							ctx.decodeAudioData(
								buf,
								(decoded: AudioBuffer) => {
									ctx.close();
									durationCache[url] = decoded.duration;
									resolve(decoded.duration);
								},
								reject,
							);
						} catch (e) {
							reject(e);
						}
					}),
			)
			.catch((e) => {
				console.warn("[FckCensor] fetchDuration failed:", e);
				return null;
			});
	}

	function patchEntityList(
		entityList: QueueEntityEntry[],
		id: string,
		durationMs: number,
	): number {
		let patched = 0;
		for (const entry of entityList) {
			const meta = entry?.entity?.entityData?.meta;
			if (!meta) continue;
			if (String(meta.id) === id || String(meta.realId) === id) {
				meta.durationMs = durationMs;
				patched++;
			}
		}
		return patched;
	}

	function patchQueueDuration(
		trackId: string | number,
		durationMs: number,
	): void {
		const id = String(trackId);
		let patched = 0;

		try {
			const players: any[] = (window as any)._ymPlayers ?? [];
			for (const player of players) {
				const entityList: QueueEntityEntry[] | undefined =
					player?.queueController?.playerQueue?.queueState?.entityList
						?.value;
				if (Array.isArray(entityList)) {
					patched += patchEntityList(entityList, id, durationMs);
				}
			}
		} catch (e) {
			console.warn("[FckCensor] patchQueueDuration path1 failed:", e);
		}

		try {
			const VE = appRequire?.(46663)?.VE;
			if (!VE) return;

			const rootEl = document.getElementById("__next") ?? document.body;
			const fiberKey = Object.keys(rootEl).find((k) =>
				k.startsWith("__reactFiber"),
			);
			if (!fiberKey) return;

			const patchInValue = (
				obj: unknown,
				visited = new Set<object>(),
			): void => {
				if (!obj || typeof obj !== "object" || visited.has(obj)) return;
				visited.add(obj);

				if (Array.isArray(obj)) {
					patched += patchEntityList(
						obj as QueueEntityEntry[],
						id,
						durationMs,
					);
					return;
				}

				const record = obj as Record<string, unknown>;
				if ("value" in record && Array.isArray(record.value)) {
					patchInValue(record.value, visited);
				}
			};

			const walkFiber = (fiber: any, depth: number): void => {
				if (!fiber || depth > 60) return;

				let state = fiber.memoizedState;
				while (state) {
					patchInValue(state.memoizedState);
					state = state.next;
				}

				if (fiber.stateNode instanceof VE) {
					const entityList: QueueEntityEntry[] | undefined =
						fiber.stateNode?.queueController?.playerQueue
							?.queueState?.entityList?.value;
					if (Array.isArray(entityList)) {
						patched += patchEntityList(entityList, id, durationMs);
					}
				}

				walkFiber(fiber.child, depth + 1);
				walkFiber(fiber.sibling, depth + 1);
			};

			walkFiber((rootEl as any)[fiberKey], 0);
		} catch (e) {
			console.warn("[FckCensor] patchQueueDuration path2 failed:", e);
		}

		if (patched === 0) {
			console.warn(
				"[FckCensor] patchQueueDuration: track not found, id=",
				id,
			);
		}
	}

	(window as any).__fckCensorDuration =
		(window as any).__fckCensorDuration ?? {};
	const _fckPendingDuration = new Set<string>();

	function applyDuration(
		trackId: string | number,
		replacedUrl: string,
	): void {
		const id = String(trackId);
		_fckPendingDuration.add(id);

		fetchDuration(replacedUrl).then((dur) => {
			if (dur == null) {
				_fckPendingDuration.delete(id);
				return;
			}

			const durationMs = Math.round(dur * 1000);
			(window as any).__fckCensorDuration[id] = durationMs;

			patchQueueDuration(trackId, durationMs);
			for (const delay of [300, 800, 1500]) {
				setTimeout(
					() => patchQueueDuration(trackId, durationMs),
					delay,
				);
			}

			_fckPendingDuration.delete(id);
		});
	}

	(function patchNextmusicApi(): void {
		function wrapApi(api: PatchedNextMusicApi): PatchedNextMusicApi {
			if (api.__fckCensorPatched) return api;
			api.__fckCensorPatched = true;

			const origGetCurrentTrack = api.getCurrentTrack.bind(api);

			api.getCurrentTrack = function (): Track | undefined {
				const track = origGetCurrentTrack();
				if (!track) return track;

				const id = String(track.id ?? "");
				const overrideDurationMs = (window as any).__fckCensorDuration[
					id
				] as number | undefined;
				const isPending = _fckPendingDuration.has(id);

				if (overrideDurationMs == null && !isPending) return track;

				const patch: Partial<Track> = {
					durationMs: overrideDurationMs ?? track.durationMs,
				};

				if (isPending && track.coverUrl) {
					patch.coverUrl = track.coverUrl + "#fck_pending";
				}

				return Object.assign({}, track, patch);
			};

			return api;
		}

		if ((window as any).nextmusicApi) {
			wrapApi((window as any).nextmusicApi as PatchedNextMusicApi);
			return;
		}

		let _api: PatchedNextMusicApi | undefined;

		try {
			Object.defineProperty(window, "nextmusicApi", {
				configurable: true,
				enumerable: true,
				get(): PatchedNextMusicApi | undefined {
					return _api;
				},
				set(val: PatchedNextMusicApi) {
					_api = val ? wrapApi(val) : val;
				},
			});
		} catch {
			const pollId = setInterval(() => {
				const api = (window as any).nextmusicApi as
					| PatchedNextMusicApi
					| undefined;
				if (api && !api.__fckCensorPatched) {
					wrapApi(api);
					clearInterval(pollId);
				}
			}, 200);
		}
	})();

	function patchInfo(
		info: FileInfoResult,
		replacedUrl: string,
	): FileInfoResult {
		if (!info?.downloadInfo) return info;

		const di = info.downloadInfo;
		di.url = replacedUrl;
		di.urls = [replacedUrl];
		di.transport = "raw";
		di.codec = "mp3";
		di.key = "";

		return info;
	}

	const ADDON_NAME = "FckCensor Next";
	const GIST_URL =
		"https://api.github.com/gists/5db074aec38196af20d7dc19be4cdd50";
	const GITHUB_RAW_URL =
		"https://raw.githubusercontent.com/Hazzz895/FckCensorData/refs/heads/main/list.json";
	const LOCAL_GIST_CACHE_URL =
		"http://localhost:2007/assets/list.m3u?name=FckCensor%20Next&";
	const LOCAL_GITHUB_CACHE_URL =
		"http://localhost:2007/assets/list.json?name=FckCensor%20Next&";

	function saveCache(sourceUrl: string, fileName: string): void {
		try {
			const api = (window as any).nextmusicApi as
				| NextMusicApi
				| undefined;
			api?.downloadAsset?.(sourceUrl, fileName, ADDON_NAME)?.catch(
				() => {},
			);
		} catch {}
	}

	function fetchGistM3U(): Promise<(M3UResult & { rawUrl?: string }) | null> {
		return fetch(GIST_URL)
			.then((r) => {
				if (!r.ok) throw new Error("Gist HTTP " + r.status);
				return r.json();
			})
			.then((data: { files?: Record<string, { raw_url?: string }> }) => {
				const file =
					data.files?.["list.m3u"] ?? data.files?.["list.m3u8"];
				if (!file?.raw_url)
					throw new Error("list.m3u not found in gist");

				const rawUrl = file.raw_url;
				return fetch(rawUrl)
					.then((r2) => {
						if (!r2.ok)
							throw new Error("Gist raw HTTP " + r2.status);
						return r2.text();
					})
					.then((text) => {
						const parsed = parseM3U(text);
						if (
							!parsed.tracks ||
							Object.keys(parsed.tracks).length === 0
						) {
							throw new Error("Empty M3U from gist");
						}
						return { ...parsed, rawUrl };
					});
			})
			.catch((e) => {
				console.warn("[FckCensor] fetchGistM3U failed:", e);
				return null;
			});
	}

	function fetchGithubJson(): Promise<M3UResult | null> {
		return fetch(GITHUB_RAW_URL)
			.then((r) => {
				if (!r.ok) throw new Error("GitHub Raw HTTP " + r.status);
				return r.json();
			})
			.then((parsed: { tracks?: Record<string, string> }) => {
				if (!parsed?.tracks)
					throw new Error("No .tracks in GitHub Raw response");
				return { tracks: parsed.tracks };
			})
			.catch((e) => {
				console.warn("[FckCensor] fetchGithubJson failed:", e);
				return null;
			});
	}

	function fetchLocalM3UCache(url: string): Promise<M3UResult> {
		return fetch(url)
			.then((r) => {
				if (!r.ok) throw new Error();
				return r.text();
			})
			.then((text) => parseM3U(text))
			.catch(() => ({ tracks: {} }));
	}

	function fetchLocalJsonCache(url: string): Promise<Record<string, string>> {
		return fetch(url)
			.then((r) => {
				if (!r.ok) throw new Error();
				return r.json();
			})
			.then((parsed: { tracks?: Record<string, string> }) => {
				if (!parsed?.tracks) throw new Error();
				return parsed.tracks;
			})
			.catch(() => ({}));
	}

	Promise.all([fetchGistM3U(), fetchGithubJson()])
		.then(([gistResult, githubResult]) => {
			const gistOk = gistResult !== null;
			const githubOk = githubResult !== null;

			if (gistOk || githubOk) {
				const githubTracks = githubOk ? githubResult.tracks : {};
				const gistTracks = gistOk ? gistResult.tracks : {};
				remoteTracks = Object.assign({}, githubTracks, gistTracks);

				if (gistOk) saveCache(gistResult.rawUrl!, "list.m3u");
				if (githubOk) saveCache(GITHUB_RAW_URL, "list.json");

				console.log(
					"[FckCensor] Loaded tracks:",
					Object.keys(remoteTracks).length,
				);
			} else {
				Promise.all([
					fetchLocalM3UCache(LOCAL_GIST_CACHE_URL),
					fetchLocalJsonCache(LOCAL_GITHUB_CACHE_URL),
				]).then(([m3uCache, jsonCache]) => {
					remoteTracks = Object.assign(
						{},
						jsonCache,
						m3uCache.tracks,
					);
					console.log(
						"[FckCensor] Loaded tracks from cache:",
						Object.keys(remoteTracks).length,
					);
				});
			}
		})
		.catch((e) =>
			console.error("[FckCensor] Unexpected error in load logic:", e),
		);

	let proto: FileInfoServiceProto;
	let originalGetFileInfo: (...args: any[]) => Promise<FileInfoResult>;
	let originalGetFileInfoBatch: (
		...args: any[]
	) => Promise<FileInfoBatchResult>;

	try {
		proto = fileInfoModule.v!.prototype;
		originalGetFileInfo = proto.getFileInfo as typeof originalGetFileInfo;
		originalGetFileInfoBatch =
			proto.getFileInfoBatch as typeof originalGetFileInfoBatch;
	} catch (e) {
		console.error("[FckCensor] Failed to access prototype:", e);
		return;
	}

	proto.getFileInfo = async function (
		params: GetFileInfoParams,
		options?: unknown,
	): Promise<FileInfoResult> {
		const result = await originalGetFileInfo.call(this, params, options);

		try {
			const trackId = String(params?.trackId);
			const replacedUrl = getReplaced(trackId);
			if (replacedUrl) {
				patchInfo(result, replacedUrl);
				applyDuration(trackId, replacedUrl);
			}
		} catch {}

		return result;
	};

	proto.getFileInfoBatch = async function (
		params: GetFileInfoBatchParams,
		options?: unknown,
	): Promise<FileInfoBatchResult> {
		const result = await originalGetFileInfoBatch.call(
			this,
			params,
			options,
		);

		try {
			const rawIds = params?.trackIds ?? [];
			const trackIds = Array.isArray(rawIds)
				? rawIds.map(String)
				: [String(rawIds)];
			const infos = result?.downloadInfos ?? [];

			trackIds.forEach((id, i) => {
				const replacedUrl = getReplaced(id);
				if (!replacedUrl || !infos[i]) return;

				infos[i].url = replacedUrl;
				infos[i].urls = [replacedUrl];
				infos[i].transport = "raw";
				infos[i].codec = "mp3";
				infos[i].key = "";

				applyDuration(id, replacedUrl);
			});
		} catch {}

		return result;
	};
})();
