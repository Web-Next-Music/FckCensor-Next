import type { Track } from "./types/track";
import type { NextMusicApi, LrclibResponse } from "./types/api";

(function YMLrc(): void {
	"use strict";

	const origFetch = window.fetch.bind(window);

	const FAKE_S3_PREFIX =
		"https://music-lyrics.s3-private.mds.yandex.net/custom/";

	const pendingDownloadUrls = new Map<string, string>();
	const lrclibCache = new Map<string, string | null>();

	let currentTrackId: string | null = null;

	async function getLrc(trackId: string): Promise<string | null> {
		if (lrclibCache.has(trackId)) return lrclibCache.get(trackId) ?? null;

		const api = (window as any).nextmusicApi as NextMusicApi | undefined;
		const track = api?.getCurrentTrack();
		const title = track?.title ?? "";
		const artists = track?.artistNames?.join(", ") ?? "";

		const params = new URLSearchParams({
			track_name: title,
			artist_name: artists,
		});

		try {
			const res = await origFetch(
				`https://lrclib.net/api/get?${params}`,
				{
					headers: { "Lrclib-Client": "YMLrc/4.0" },
				},
			);

			if (!res.ok) throw new Error("http " + res.status);

			const data = (await res.json()) as LrclibResponse;
			const result = data.syncedLyrics ?? null;
			lrclibCache.set(trackId, result);
			return result;
		} catch {
			lrclibCache.set(trackId, null);
			return null;
		}
	}

	window.fetch = async function (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> {
		const url =
			typeof input === "string" ? input : ((input as Request)?.url ?? "");

		const lyricsMatch = url.match(/\/tracks\/(\d+)\/lyrics/);
		if (lyricsMatch) {
			const trackId = lyricsMatch[1];
			const res = await origFetch(input, init);

			if (res.ok) {
				try {
					const data = await res.clone().json();
					if (data.downloadUrl) {
						pendingDownloadUrls.set(trackId, data.downloadUrl);
					}
				} catch {}
				return res;
			} else {
				pendingDownloadUrls.set(trackId, `${FAKE_S3_PREFIX}${trackId}`);
				return new Response(
					JSON.stringify({
						lyricId: parseInt(trackId),
						externalLyricId: "custom",
						writers: [],
						major: null,
						downloadUrl: `${FAKE_S3_PREFIX}${trackId}`,
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		}

		if (url.includes("mds.yandex.net") || url.includes("music-lyrics")) {
			let matchedTrackId: string | null = null;

			for (const [tid, durl] of pendingDownloadUrls) {
				if (durl.split("?")[0] === url.split("?")[0]) {
					matchedTrackId = tid;
					break;
				}
			}

			if (matchedTrackId) {
				pendingDownloadUrls.delete(matchedTrackId);
				const lrc = await getLrc(matchedTrackId);

				if (lrc) {
					return new Response(lrc, {
						status: 200,
						headers: {
							"Content-Type": "text/plain; charset=utf-8",
						},
					});
				}

				return origFetch(input, init);
			}
		}

		return origFetch(input, init);
	};

	const LYRICS_MARKER_KEYS = [
		"lyrics",
		"lyricId",
		"loadingState",
		"trackId",
		"writers",
	];

	interface FiberSearchResult {
		path: string;
		obj: Record<string, unknown>;
	}

	function searchFiberForLyricsStore(root: Element): FiberSearchResult[] {
		const visited = new Set<object>();
		const found: FiberSearchResult[] = [];

		function searchObj(obj: unknown, path = "", depth = 0): void {
			if (
				!obj ||
				typeof obj !== "object" ||
				depth > 8 ||
				visited.has(obj)
			)
				return;
			visited.add(obj);

			const record = obj as Record<string, unknown>;
			const matchCount = Object.keys(record).filter((k) =>
				LYRICS_MARKER_KEYS.includes(k),
			).length;

			if (matchCount >= 3) {
				found.push({ path, obj: record });
				return;
			}

			for (const [k, v] of Object.entries(record)) {
				try {
					searchObj(v, path ? `${path}.${k}` : k, depth + 1);
				} catch {}
			}
		}

		function searchFiber(fiber: unknown, depth = 0): void {
			if (!fiber || depth > 120) return;
			const f = fiber as Record<string, any>;

			try {
				searchObj(f.stateNode, "stateNode");
			} catch {}

			let state = f.memoizedState;
			while (state) {
				try {
					searchObj(state.memoizedState, "memoizedState");
				} catch {}
				try {
					searchObj(
						state.queue?.lastRenderedState,
						"queue.lastRenderedState",
					);
				} catch {}
				state = state.next;
			}

			searchFiber(f.child, depth + 1);
			searchFiber(f.sibling, depth + 1);
		}

		const fk = Object.keys(root).find((k) => k.startsWith("__reactFiber"));
		if (fk) searchFiber((root as any)[fk]);

		return found;
	}

	function interceptGetLyricsText(): boolean {
		const root = document.getElementById("__next") ?? document.body;
		const found = searchFiberForLyricsStore(root);

		const store =
			found.find((f) => f.path.includes("syncLyrics"))?.obj ??
			found[0]?.obj;
		if (!store) return false;

		let node = (store as any).$treenode;
		while (node._parent) node = node._parent;

		const prefixless = node.environment?.prefixlessResource;
		if (!prefixless) return false;

		const proto = Object.getPrototypeOf(prefixless);
		if (typeof proto.getLyricsText !== "function") return false;
		if ((proto as any).__lrcIntercepted) return true;
		(proto as any).__lrcIntercepted = true;

		const origLT = proto.getLyricsText as (
			url: unknown,
			...rest: unknown[]
		) => Promise<string>;

		proto.getLyricsText = async function (
			url: unknown,
			...rest: unknown[]
		): Promise<string> {
			const urlStr = String(url ?? "");

			if (urlStr.startsWith(FAKE_S3_PREFIX)) {
				const trackId = urlStr
					.replace(FAKE_S3_PREFIX, "")
					.split("?")[0];
				return (await getLrc(trackId)) ?? "";
			}

			try {
				const result = await origLT.call(this, url, ...rest);
				if (result?.trim().length > 0) return result;
			} catch {}

			const api = (window as any).nextmusicApi as
				| NextMusicApi
				| undefined;
			const track = api?.getCurrentTrack();
			if (!track) return "";

			return (await getLrc(String(track.id))) ?? "";
		};

		return true;
	}

	function findRootSV(): unknown {
		const root = document.getElementById("__next") ?? document.body;
		const visited = new Set<object>();
		const found: FiberSearchResult[] = [];

		function searchObj(obj: unknown, path = "", depth = 0): void {
			if (
				!obj ||
				typeof obj !== "object" ||
				depth > 8 ||
				visited.has(obj)
			)
				return;
			visited.add(obj);

			const record = obj as Record<string, unknown>;
			const matchCount = Object.keys(record).filter((k) =>
				LYRICS_MARKER_KEYS.includes(k),
			).length;

			if (matchCount >= 3) {
				found.push({ path, obj: record });
				return;
			}

			for (const [k, v] of Object.entries(record)) {
				try {
					searchObj(v, path ? `${path}.${k}` : k, depth + 1);
				} catch {}
			}
		}

		function searchFiber(fiber: unknown, depth = 0): void {
			if (!fiber || depth > 120) return;
			const f = fiber as Record<string, any>;

			try {
				searchObj(f.stateNode, "stateNode");
			} catch {}

			let state = f.memoizedState;
			while (state) {
				try {
					searchObj(state.memoizedState, "memoizedState");
				} catch {}
				try {
					searchObj(state.queue?.lastRenderedState, "queue");
				} catch {}
				state = state.next;
			}

			searchFiber(f.child, depth + 1);
			searchFiber(f.sibling, depth + 1);
		}

		const fk = Object.keys(root).find((k) => k.startsWith("__reactFiber"));
		if (!fk) return null;
		searchFiber((root as any)[fk]);

		const store = found.find((f) => f.path.includes("syncLyrics"))?.obj;
		if (!store) return null;

		let node = (store as any).$treenode;
		while (node._parent) node = node._parent;
		return node.storedValue;
	}

	interface MstPatch {
		op: "replace" | "add" | "remove";
		path: string;
		value?: unknown;
	}

	function mstPatch(obj: any, patches: MstPatch[]): void {
		const node = obj.$treenode;
		const wasProtected = node.isProtectionEnabled;
		node.isProtectionEnabled = false;
		node._isRunningAction = true;
		try {
			node._applyPatches(patches);
		} finally {
			node._isRunningAction = false;
			node.isProtectionEnabled = wasProtected;
		}
	}

	function enableLyricsButton(rootSV: any): void {
		const em = rootSV?.sonataState?.entityMeta;
		if (!em?.$treenode) return;
		if (em.hasLyrics && em.hasSyncLyrics) return;

		try {
			mstPatch(em, [
				{ op: "replace", path: "/hasLyrics", value: true },
				{ op: "replace", path: "/hasSyncLyrics", value: true },
			]);
		} catch {}
	}

	function installEntityMetaIntercept(rootSV: any): void {
		const em = rootSV?.sonataState?.entityMeta;
		if (!em?.$treenode || (em.$treenode as any).__lrcEmIntercepted) return;
		(em.$treenode as any).__lrcEmIntercepted = true;

		const origApplySnapshot = em.$treenode._applySnapshot.bind(
			em.$treenode,
		);

		em.$treenode._applySnapshot = function (snapshot: unknown): void {
			origApplySnapshot(snapshot);

			const trackId = String(em.id ?? "");
			if (!trackId) return;

			setTimeout(async () => {
				try {
					if (!em.hasLyrics || !em.hasSyncLyrics) {
						mstPatch(em, [
							{ op: "replace", path: "/hasLyrics", value: true },
							{
								op: "replace",
								path: "/hasSyncLyrics",
								value: true,
							},
						]);
					}
				} catch {}

				const api = (window as any).nextmusicApi as
					| NextMusicApi
					| undefined;
				const track = api?.getCurrentTrack();
				if (track && String(track.id) === trackId) {
					await getLrc(trackId);
				}
			}, 100);
		};
	}

	async function main(): Promise<void> {
		let rootSV: unknown = null;
		let prefixlessIntercepted = false;

		setInterval(async () => {
			if (!rootSV) {
				rootSV = findRootSV();
				if (rootSV) {
					enableLyricsButton(rootSV);
					installEntityMetaIntercept(rootSV);
				}
			}
			if (rootSV && !prefixlessIntercepted) {
				prefixlessIntercepted = interceptGetLyricsText();
			}
		}, 300);

		const api = (window as any).nextmusicApi as NextMusicApi | undefined;
		const track = api?.getCurrentTrack();
		if (track) {
			await getLrc(String(track.id));
		}

		setInterval(() => {
			const api = (window as any).nextmusicApi as
				| NextMusicApi
				| undefined;
			const track: Track | undefined = api?.getCurrentTrack();
			if (!track) return;

			const id = String(track.id);
			if (id === currentTrackId) return;

			currentTrackId = id;
			getLrc(id);
		}, 500);
	}

	main().catch(console.error);
})();
