(function YMLrc() {
    "use strict";

    const log = (...a) => console.log("[LRC]", ...a);
    const origFetch = window.fetch.bind(window);
    const FAKE_S3_PREFIX =
        "https://music-lyrics.s3-private.mds.yandex.net/custom/";

    const pendingDownloadUrls = new Map();
    const lrclibCache = new Map();
    let currentTrackId = null;

    // ---------------- LRCLIB ----------------
    async function getLrc(trackId) {
        if (lrclibCache.has(trackId)) return lrclibCache.get(trackId);

        const api = window.nextmusicApi;
        const track = api?.getCurrentTrack();
        const title = track?.title ?? "";
        const artists = track?.artistNames?.join(", ") ?? "";

        const params = new URLSearchParams({
            track_name: title,
            artist_name: artists,
        });
        log(`[lrclib] search: ${title} - ${artists}`);

        try {
            const res = await origFetch(
                `https://lrclib.net/api/get?${params}`,
                {
                    headers: { "Lrclib-Client": "YMLrc/4.0" },
                },
            );
            if (!res.ok) throw new Error("http " + res.status);
            const data = await res.json();
            const result = data.syncedLyrics ?? null;
            lrclibCache.set(trackId, result);
            if (result) log(`[lrclib] найдено`);
            else log(`[lrclib] нет syncedLyrics`);
            return result;
        } catch (e) {
            lrclibCache.set(trackId, null);
            log(`[lrclib] ошибка:`, e.message);
            return null;
        }
    }

    // ---------------- FETCH PATCH ----------------
    window.fetch = async function (input, init) {
        const url = typeof input === "string" ? input : (input?.url ?? "");

        // Перехват запроса метаданных лирики
        const lyricsMatch = url.match(/\/tracks\/(\d+)\/lyrics/);
        if (lyricsMatch) {
            const trackId = lyricsMatch[1];
            const res = await origFetch(input, init);

            if (res.ok) {
                // Есть лирика на яндексе — сохраняем downloadUrl для подмены текста
                try {
                    const data = await res.clone().json();
                    if (data.downloadUrl) {
                        pendingDownloadUrls.set(trackId, data.downloadUrl);
                        log(`[meta] ${trackId} downloadUrl сохранён`);
                    }
                } catch (e) {}
                return res;
            } else {
                // 404 — нет лирики на яндексе, подменяем фейковым ответом
                log(`[meta] ${trackId} → 404, подменяем фейковым downloadUrl`);
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

        // Перехват скачивания текста лирики с реального S3
        if (url.includes("mds.yandex.net") || url.includes("music-lyrics")) {
            let matchedTrackId = null;
            for (const [tid, durl] of pendingDownloadUrls) {
                if (durl.split("?")[0] === url.split("?")[0]) {
                    matchedTrackId = tid;
                    break;
                }
            }

            if (matchedTrackId) {
                pendingDownloadUrls.delete(matchedTrackId);
                log(`[s3] подмена → lrclib (${matchedTrackId})`);
                const lrc = await getLrc(matchedTrackId);
                if (lrc) {
                    return new Response(lrc, {
                        status: 200,
                        headers: {
                            "Content-Type": "text/plain; charset=utf-8",
                        },
                    });
                }
                log(`[s3] lrclib нет — fallback на оригинал`);
                return origFetch(input, init);
            }
        }

        return origFetch(input, init);
    };

    log("fetch перехвачен");

    // ---------------- getLyricsText PATCH ----------------
    // Перехватывает метод который скачивает текст через httpClient
    // Нужен для фейкового FAKE_S3_PREFIX — плеер туда не делает fetch, а вызывает httpClient
    function interceptGetLyricsText() {
        const MARKER_KEYS = [
            "lyrics",
            "lyricId",
            "loadingState",
            "trackId",
            "writers",
        ];
        const visited = new Set();
        const found = [];

        function searchObj(obj, path = "", depth = 0) {
            if (
                !obj ||
                typeof obj !== "object" ||
                depth > 8 ||
                visited.has(obj)
            )
                return;
            visited.add(obj);
            if (
                Object.keys(obj).filter((k) => MARKER_KEYS.includes(k))
                    .length >= 3
            ) {
                found.push({ path, obj });
                return;
            }
            for (const [k, v] of Object.entries(obj)) {
                try {
                    searchObj(v, path ? `${path}.${k}` : k, depth + 1);
                } catch {}
            }
        }

        function searchFiber(fiber, depth = 0) {
            if (!fiber || depth > 120) return;
            try {
                searchObj(fiber.stateNode, "stateNode");
            } catch {}
            let state = fiber.memoizedState;
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
            searchFiber(fiber.child, depth + 1);
            searchFiber(fiber.sibling, depth + 1);
        }

        const root = document.getElementById("__next") ?? document.body;
        const fk = Object.keys(root).find((k) => k.startsWith("__reactFiber"));
        if (!fk) return false;
        searchFiber(root[fk]);

        const store =
            found.find((f) => f.path.includes("syncLyrics"))?.obj ??
            found[0]?.obj;
        if (!store) return false;

        let node = store.$treenode;
        while (node._parent) node = node._parent;
        const prefixless = node.environment?.prefixlessResource;
        if (!prefixless) return false;

        const proto = Object.getPrototypeOf(prefixless);
        if (typeof proto.getLyricsText !== "function") return false;
        if (proto.__lrcIntercepted) return true;
        proto.__lrcIntercepted = true;

        const origLT = proto.getLyricsText;

        proto.getLyricsText = async function (url, ...rest) {
            const urlStr = url?.toString() ?? "";
            log(`[getLyricsText] url: ${urlStr.slice(0, 80)}`);

            // Наш фейковый URL — отдаём lrclib напрямую
            if (urlStr.startsWith(FAKE_S3_PREFIX)) {
                const trackId = urlStr
                    .replace(FAKE_S3_PREFIX, "")
                    .split("?")[0];
                log(`[getLyricsText] фейковый URL, trackId=${trackId}`);
                const lrc = await getLrc(trackId);
                if (lrc) {
                    log(
                        `[getLyricsText] отдаём lrclib, строк: ${lrc.split("\n").length}`,
                    );
                    return lrc;
                }
                return "";
            }

            // Реальный URL — пробуем оригинал, при ошибке lrclib
            try {
                const result = await origLT.call(this, url, ...rest);
                if (result?.trim().length > 0) return result;
            } catch (e) {
                log(`[getLyricsText] оригинал упал: ${e.message}`);
            }

            const api = window.nextmusicApi;
            const track = api?.getCurrentTrack();
            if (!track) return "";
            const lrc = await getLrc(String(track.id));
            return lrc ?? "";
        };

        log("getLyricsText перехвачен");
        return true;
    }

    // ---------------- MST helpers ----------------
    function findRootSV() {
        const MARKER_KEYS = [
            "lyrics",
            "lyricId",
            "loadingState",
            "trackId",
            "writers",
        ];
        const visited = new Set();
        const found = [];

        function searchObj(obj, path = "", depth = 0) {
            if (
                !obj ||
                typeof obj !== "object" ||
                depth > 8 ||
                visited.has(obj)
            )
                return;
            visited.add(obj);
            if (
                Object.keys(obj).filter((k) => MARKER_KEYS.includes(k))
                    .length >= 3
            ) {
                found.push({ path, obj });
                return;
            }
            for (const [k, v] of Object.entries(obj)) {
                try {
                    searchObj(v, path ? `${path}.${k}` : k, depth + 1);
                } catch {}
            }
        }

        function searchFiber(fiber, depth = 0) {
            if (!fiber || depth > 120) return;
            try {
                searchObj(fiber.stateNode, "stateNode");
            } catch {}
            let state = fiber.memoizedState;
            while (state) {
                try {
                    searchObj(state.memoizedState, "memoizedState");
                } catch {}
                try {
                    searchObj(state.queue?.lastRenderedState, "queue");
                } catch {}
                state = state.next;
            }
            searchFiber(fiber.child, depth + 1);
            searchFiber(fiber.sibling, depth + 1);
        }

        const root = document.getElementById("__next") ?? document.body;
        const fk = Object.keys(root).find((k) => k.startsWith("__reactFiber"));
        if (!fk) return null;
        searchFiber(root[fk]);

        const store = found.find((f) => f.path.includes("syncLyrics"))?.obj;
        if (!store) return null;

        let node = store.$treenode;
        while (node._parent) node = node._parent;
        return node.storedValue;
    }

    function mstPatch(obj, patches) {
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

    function enableLyricsButton(rootSV) {
        const em = rootSV?.sonataState?.entityMeta;
        if (!em?.$treenode) return;
        if (em.hasLyrics && em.hasSyncLyrics) return;
        try {
            mstPatch(em, [
                { op: "replace", path: "/hasLyrics", value: true },
                { op: "replace", path: "/hasSyncLyrics", value: true },
            ]);
            log("кнопка включена");
        } catch (e) {}
    }

    function installEntityMetaIntercept(rootSV) {
        const em = rootSV?.sonataState?.entityMeta;
        if (!em?.$treenode || em.$treenode.__lrcEmIntercepted) return;
        em.$treenode.__lrcEmIntercepted = true;

        const orig = em.$treenode._applySnapshot.bind(em.$treenode);
        em.$treenode._applySnapshot = function (snapshot) {
            orig(snapshot);
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
                } catch (e) {}
                const api = window.nextmusicApi;
                const track = api?.getCurrentTrack();
                if (track && String(track.id) === trackId) {
                    await getLrc(trackId);
                }
            }, 100);
        };
        log("entityMeta перехват установлен");
    }

    // ---------------- MAIN ----------------
    async function main() {
        log("Запуск...");

        let rootSV = null;
        let prefixlessIntercepted = false;

        const initTimer = setInterval(async () => {
            if (!rootSV) {
                rootSV = findRootSV();
                if (rootSV) {
                    log("rootSV найден");
                    installEntityMetaIntercept(rootSV);
                }
            }
            if (rootSV && !prefixlessIntercepted) {
                prefixlessIntercepted = interceptGetLyricsText();
            }
        }, 300);

        // Предзагрузка текущего трека
        const api = window.nextmusicApi;
        const track = api?.getCurrentTrack();
        if (track) {
            await getLrc(String(track.id));
        }

        // Poll смены трека
        setInterval(() => {
            const api = window.nextmusicApi;
            const track = api?.getCurrentTrack();
            if (!track) return;
            const id = String(track.id);
            if (id === currentTrackId) return;
            currentTrackId = id;
            log(`[track] смена → ${id}`);
            getLrc(id);
        }, 500);

        log("Готов!");
    }

    main().catch(console.error);
})();
