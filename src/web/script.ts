import type { M3UResult } from "../types/m3u";
import type {
	WebpackRequire,
	WebpackChunk,
	FileInfoServiceProto,
	QueueEntityEntry,
	GetFileInfoParams,
	GetFileInfoBatchParams,
	FileInfoResult,
	FileInfoBatchResult,
} from "../types/script";

declare const unsafeWindow: Window & typeof globalThis;
declare function GM_xmlhttpRequest(details: {
	method: string;
	url: string;
	responseType?: string;
	onload?(res: { status: number; responseText: string; response: unknown }): void;
	onerror?(err: unknown): void;
}): void;

interface GmResponse {
	ok: boolean;
	status: number;
	text(): Promise<string>;
	json(): Promise<unknown>;
}

interface AudioData {
	blobUrl: string;
	durationMs: number | null;
}

(function (): void {
	// In sandboxed TM context (any @grant other than none), window ≠ page window.
	const pw =
		typeof unsafeWindow !== "undefined"
			? (unsafeWindow as any)
			: (window as any);

	let webpackGlobal: WebpackChunk;
	let appRequire: WebpackRequire | undefined;
	let fileInfoModule: { v?: { prototype: FileInfoServiceProto } } | undefined;
	const ADDON_PREFIX = "[FckCensor]";

	try {
		webpackGlobal = pw.webpackChunk_N_E;
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
		console.error(`${ADDON_PREFIX} appRequire is null, aborting`);
		return;
	}

	function isFileInfoModuleCandidate(
		mod: unknown,
	): mod is { v?: { prototype: FileInfoServiceProto } } {
		const proto = (mod as { v?: { prototype?: FileInfoServiceProto } })?.v
			?.prototype;
		return (
			!!proto &&
			typeof proto.getFileInfo === "function" &&
			typeof proto.getFileInfoBatch === "function"
		);
	}

	function findWebpackModule<T>(
		predicate: (mod: unknown) => mod is T,
	): T | null {
		const moduleMap = appRequire?.m;
		if (!moduleMap) {
			console.error(`${ADDON_PREFIX} appRequire.m is unavailable`);
			return null;
		}

		for (const moduleId of Object.keys(moduleMap)) {
			try {
				const mod = appRequire?.(moduleId);
				if (predicate(mod)) {
					console.log(
						`${ADDON_PREFIX} Found webpack module for patch:`,
						moduleId,
					);
					return mod;
				}
			} catch (e) {
				console.debug(
					`${ADDON_PREFIX} Failed to inspect webpack module ${moduleId}:`,
					e,
				);
			}
		}

		return null;
	}

	fileInfoModule = findWebpackModule(isFileInfoModuleCandidate) ?? undefined;

	if (!fileInfoModule?.v) {
		console.error(
			`${ADDON_PREFIX} FileInfo module not found, aborting. Wait for addon update.`,
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
			const players: any[] = pw._ymPlayers ?? [];
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

			const rootEl =
				document.getElementById("__next") ?? document.body;
			const fiberKey = Object.keys(rootEl).find((k) =>
				k.startsWith("__reactFiber"),
			);
			if (!fiberKey) return;

			const patchInValue = (
				obj: unknown,
				visited = new Set<object>(),
			): void => {
				if (!obj || typeof obj !== "object" || visited.has(obj))
					return;
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
						patched += patchEntityList(
							entityList,
							id,
							durationMs,
						);
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

	// Download audio via GM_xmlhttpRequest (bypasses page CSP), create a blob URL
	// (allowed by media-src blob:), and extract duration from the same arraybuffer.
	// Results are cached so repeated plays don't re-download.
	const audioCache: Record<string, AudioData> = {};
	const audioPending: Record<string, Promise<AudioData | null>> = {};

	function processRemoteAudio(url: string): Promise<AudioData | null> {
		if (audioCache[url]) return Promise.resolve(audioCache[url]);
		if (audioPending[url]) return audioPending[url];

		audioPending[url] = new Promise<AudioData | null>((resolve) => {
			GM_xmlhttpRequest({
				method: "GET",
				url,
				responseType: "arraybuffer",
				onload(res) {
					if (res.status < 200 || res.status >= 300) {
						console.warn(
							"[FckCensor] processRemoteAudio HTTP",
							res.status,
							url,
						);
						resolve(null);
						return;
					}

					try {
						const buf = res.response as ArrayBuffer;
						// Blob copies the data — buf can be safely detached by decodeAudioData after this
						const blob = new Blob([buf], { type: "audio/mpeg" });
						const blobUrl = URL.createObjectURL(blob);

						try {
							const AudioContextClass =
								pw.AudioContext ||
								(pw.webkitAudioContext as typeof AudioContext);
							const ctx = new AudioContextClass();
							ctx.decodeAudioData(
								buf,
								(decoded: AudioBuffer) => {
									ctx.close();
									resolve({
										blobUrl,
										durationMs: Math.round(
											decoded.duration * 1000,
										),
									});
								},
								() => resolve({ blobUrl, durationMs: null }),
							);
						} catch {
							resolve({ blobUrl, durationMs: null });
						}
					} catch (e) {
						console.warn(
							"[FckCensor] processRemoteAudio blob failed:",
							e,
						);
						resolve(null);
					}
				},
				onerror(e) {
					console.warn("[FckCensor] processRemoteAudio GM error:", e);
					resolve(null);
				},
			});
		}).then((data) => {
			if (data) audioCache[url] = data;
			delete audioPending[url];
			return data;
		});

		return audioPending[url];
	}

	function patchInfo(
		info: FileInfoResult,
		blobUrl: string,
	): FileInfoResult {
		if (!info?.downloadInfo) return info;

		const di = info.downloadInfo;
		di.url = blobUrl;
		di.urls = [blobUrl];
		di.transport = "raw";
		di.codec = "mp3";
		di.key = "";

		return info;
	}

	// GM_xmlhttpRequest bypasses the page's CSP connect-src restrictions.
	function gmFetch(url: string): Promise<GmResponse> {
		return new Promise((resolve, reject) => {
			GM_xmlhttpRequest({
				method: "GET",
				url,
				onload(res) {
					const text = res.responseText;
					resolve({
						ok: res.status >= 200 && res.status < 300,
						status: res.status,
						text: () => Promise.resolve(text),
						json: () => {
							try {
								return Promise.resolve(JSON.parse(text));
							} catch (e) {
								return Promise.reject(e);
							}
						},
					});
				},
				onerror: reject,
			});
		});
	}

	const GIST_URL =
		"https://api.github.com/gists/5db074aec38196af20d7dc19be4cdd50";
	const GITHUB_RAW_URL =
		"https://raw.githubusercontent.com/Hazzz895/FckCensorData/refs/heads/main/list.json";

	function fetchGistM3U(): Promise<(M3UResult & { rawUrl?: string }) | null> {
		return gmFetch(GIST_URL)
			.then((r) => {
				if (!r.ok) throw new Error("Gist HTTP " + r.status);
				return r.json();
			})
			.then((data) => {
				const d = data as { files?: Record<string, { raw_url?: string }> };
				const file = d.files?.["list.m3u"] ?? d.files?.["list.m3u8"];
				if (!file?.raw_url)
					throw new Error("list.m3u not found in gist");

				const rawUrl = file.raw_url;
				return gmFetch(rawUrl)
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
		return gmFetch(GITHUB_RAW_URL)
			.then((r) => {
				if (!r.ok) throw new Error("GitHub Raw HTTP " + r.status);
				return r.json();
			})
			.then((parsed) => {
				const p = parsed as { tracks?: Record<string, string> };
				if (!p?.tracks)
					throw new Error("No .tracks in GitHub Raw response");
				return { tracks: p.tracks };
			})
			.catch((e) => {
				console.warn("[FckCensor] fetchGithubJson failed:", e);
				return null;
			});
	}

	Promise.all([fetchGistM3U(), fetchGithubJson()])
		.then(([gistResult, githubResult]) => {
			const gistOk = gistResult !== null;
			const githubOk = githubResult !== null;

			if (gistOk || githubOk) {
				const githubTracks = githubOk ? githubResult.tracks : {};
				const gistTracks = gistOk ? gistResult.tracks : {};
				remoteTracks = Object.assign({}, githubTracks, gistTracks);

				console.log(
					"[FckCensor] Loaded tracks:",
					Object.keys(remoteTracks).length,
				);
			} else {
				console.warn(
					"[FckCensor] Failed to load tracks from all sources",
				);
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
				const audioData = await processRemoteAudio(replacedUrl);
				if (audioData) {
					patchInfo(result, audioData.blobUrl);
					if (audioData.durationMs != null) {
						patchQueueDuration(trackId, audioData.durationMs);
						for (const delay of [300, 800, 1500]) {
							setTimeout(
								() =>
									patchQueueDuration(
										trackId,
										audioData.durationMs!,
									),
								delay,
							);
						}
					}
				}
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

			await Promise.all(
				trackIds.map(async (id, i) => {
					const replacedUrl = getReplaced(id);
					if (!replacedUrl || !infos[i]) return;

					const audioData = await processRemoteAudio(replacedUrl);
					if (!audioData) return;

					infos[i].url = audioData.blobUrl;
					infos[i].urls = [audioData.blobUrl];
					infos[i].transport = "raw";
					infos[i].codec = "mp3";
					infos[i].key = "";

					if (audioData.durationMs != null) {
						patchQueueDuration(id, audioData.durationMs);
						for (const delay of [300, 800, 1500]) {
							setTimeout(
								() =>
									patchQueueDuration(
										id,
										audioData.durationMs!,
									),
								delay,
							);
						}
					}
				}),
			);
		} catch {}

		return result;
	};
})();
