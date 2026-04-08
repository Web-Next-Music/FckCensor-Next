(function () {
    // ── webpack require ───────────────────────────────────────────────────────
    let webpackGlobal, appRequire, fileInfoModule;
    try {
        webpackGlobal = window.webpackChunk_N_E;
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
            (r) => {
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
    // ── track storage ─────────────────────────────────────────────────────────
    let remoteTracks = {};
    function getReplaced(trackId) {
        try {
            if (!trackId) return null;
            return remoteTracks[String(trackId)] ?? null;
        } catch (e) {}
        return null;
    }
    // ── M3U parser ────────────────────────────────────────────────────────────
    function extractIdFromUrl(url) {
        try {
            const u = new URL(url);
            const qid =
                u.searchParams.get("track_id") || u.searchParams.get("id");
            if (qid && /^\d+$/.test(qid)) return qid;
            const segments = u.pathname.split("/").filter(Boolean);
            const last = segments[segments.length - 1] ?? "";
            const m = last.match(/^(\d+)/);
            if (m) return m[1];
        } catch (e) {}
        return null;
    }
    function parseM3U(text) {
        const lines = text.split(/\r?\n/);
        const result = {};
        let pendingCover = "";
        let pendingArtist = "";
        let pendingTitle = "";
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
                if (id) {
                    result[id] = line;
                }
                pendingArtist = "";
                pendingTitle = "";
                pendingCover = "";
            }
        }
        return { tracks: result };
    }
    // ── duration cache + fetch ────────────────────────────────────────────────
    const durationCache = {};
    function fetchDuration(url) {
        if (durationCache[url] !== undefined)
            return Promise.resolve(durationCache[url]);
        return fetch(url)
            .then((r) => r.arrayBuffer())
            .then(
                (buf) =>
                    new Promise((resolve, reject) => {
                        try {
                            const ctx = new (
                                window.AudioContext || window.webkitAudioContext
                            )();
                            ctx.decodeAudioData(
                                buf,
                                (decoded) => {
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
    // ── patch queue duration ──────────────────────────────────────────────────
    function patchQueueDuration(trackId, durationMs) {
        const id = String(trackId);
        let patched = 0;
        try {
            const players = window._ymPlayers ?? [];
            for (const player of players) {
                const entityList =
                    player?.queueController?.playerQueue?.queueState?.entityList
                        ?.value;
                if (!Array.isArray(entityList)) continue;
                for (const entry of entityList) {
                    const meta = entry?.entity?.entityData?.meta;
                    if (!meta) continue;
                    if (String(meta.id) === id || String(meta.realId) === id) {
                        meta.durationMs = durationMs;
                        patched++;
                    }
                }
            }
        } catch (e) {
            console.warn("[FckCensor] patchQueueDuration path1 failed:", e);
        }
        try {
            const VE = appRequire(46663)?.VE;
            if (!VE) return;
            const rootEl = document.getElementById("__next") || document.body;
            const fiberKey = Object.keys(rootEl).find((k) =>
                k.startsWith("__reactFiber"),
            );
            if (!fiberKey) return;
            function patchInValue(obj, id, durationMs, visited = new Set()) {
                if (!obj || typeof obj !== "object" || visited.has(obj)) return;
                visited.add(obj);
                if (Array.isArray(obj)) {
                    for (const entry of obj) {
                        const meta = entry?.entity?.entityData?.meta;
                        if (!meta) continue;
                        if (
                            String(meta.id) === id ||
                            String(meta.realId) === id
                        ) {
                            meta.durationMs = durationMs;
                            patched++;
                        }
                    }
                    return;
                }
                if ("value" in obj && Array.isArray(obj.value)) {
                    patchInValue(obj.value, id, durationMs, visited);
                }
            }
            function walkFiber(fiber, depth) {
                if (!fiber || depth > 60) return;
                let state = fiber.memoizedState;
                while (state) {
                    patchInValue(state.memoizedState, id, durationMs);
                    state = state.next;
                }
                if (fiber.stateNode instanceof VE) {
                    const entityList =
                        fiber.stateNode?.queueController?.playerQueue
                            ?.queueState?.entityList?.value;
                    if (Array.isArray(entityList)) {
                        for (const entry of entityList) {
                            const meta = entry?.entity?.entityData?.meta;
                            if (!meta) continue;
                            if (
                                String(meta.id) === id ||
                                String(meta.realId) === id
                            ) {
                                meta.durationMs = durationMs;
                                patched++;
                            }
                        }
                    }
                }
                walkFiber(fiber.child, depth + 1);
                walkFiber(fiber.sibling, depth + 1);
            }
            walkFiber(rootEl[fiberKey], 0);
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
    // ── duration overrides for RPC ────────────────────────────────────────────
    window.__fckCensorDuration = window.__fckCensorDuration ?? {};
    const _fckPendingDuration = new Set();
    function applyDuration(trackId, replacedUrl) {
        const id = String(trackId);
        _fckPendingDuration.add(id);
        fetchDuration(replacedUrl).then((dur) => {
            if (dur == null) {
                _fckPendingDuration.delete(id);
                return;
            }
            const durationMs = Math.round(dur * 1000);
            window.__fckCensorDuration[id] = durationMs;
            patchQueueDuration(trackId, durationMs);
            [300, 800, 1500].forEach((delay) => {
                setTimeout(
                    () => patchQueueDuration(trackId, durationMs),
                    delay,
                );
            });
            _fckPendingDuration.delete(id);
        });
    }
    // ── patch nextmusicApi for RPC ────────────────────────────────────────────
    (function patchNextmusicApi() {
        function wrapApi(api) {
            if (api.__fckCensorPatched) return api;
            api.__fckCensorPatched = true;
            const origGetCurrentTrack = api.getCurrentTrack.bind(api);
            api.getCurrentTrack = function () {
                const track = origGetCurrentTrack();
                if (!track) return track;
                const id = String(track.id ?? "");
                const overrideDurationMs = window.__fckCensorDuration[id];
                const isPending = _fckPendingDuration.has(id);
                if (overrideDurationMs == null && !isPending) return track;
                const patch = {
                    durationMs: overrideDurationMs ?? track.durationMs,
                };
                if (isPending && track.coverUrl) {
                    patch.coverUrl = track.coverUrl + "#fck_pending";
                }
                return Object.assign({}, track, patch);
            };
            return api;
        }
        if (window.nextmusicApi) {
            wrapApi(window.nextmusicApi);
            return;
        }
        let _api;
        try {
            Object.defineProperty(window, "nextmusicApi", {
                configurable: true,
                enumerable: true,
                get() {
                    return _api;
                },
                set(val) {
                    _api = val ? wrapApi(val) : val;
                },
            });
        } catch (e) {
            const pollId = setInterval(() => {
                if (
                    window.nextmusicApi &&
                    !window.nextmusicApi.__fckCensorPatched
                ) {
                    wrapApi(window.nextmusicApi);
                    clearInterval(pollId);
                }
            }, 200);
        }
    })();
    // ── patch downloadInfo in-place ───────────────────────────────────────────
    function patchInfo(info, replacedUrl) {
        if (!info?.downloadInfo) return info;
        const di = info.downloadInfo;
        di.url = replacedUrl;
        di.urls = [replacedUrl];
        di.transport = "raw";
        di.codec = "mp3";
        di.key = "";
        return info;
    }
    // ── constants ─────────────────────────────────────────────────────────────
    const ADDON_NAME = "FckCensor Next";
    const GIST_URL =
        "https://api.github.com/gists/5db074aec38196af20d7dc19be4cdd50";
    const GITHUB_RAW_URL =
        "https://raw.githubusercontent.com/Hazzz895/FckCensorData/refs/heads/main/list.json";
    const LOCAL_GIST_CACHE_URL =
        "http://localhost:2007/assets/list.m3u?name=FckCensor%20Next&";
    const LOCAL_GITHUB_CACHE_URL =
        "http://localhost:2007/assets/list.json?name=FckCensor%20Next&";
    // ── save cache via nextmusicApi ───────────────────────────────────────────
    function saveCache(sourceUrl, fileName) {
        try {
            if (!window.nextmusicApi?.downloadAsset) return;
            window.nextmusicApi
                .downloadAsset(sourceUrl, fileName, ADDON_NAME)
                .catch(() => {});
        } catch (e) {}
    }
    // ── fetch gist → list.m3u ─────────────────────────────────────────────────
    function fetchGistM3U() {
        return fetch(GIST_URL)
            .then((r) => {
                if (!r.ok) throw new Error("Gist HTTP " + r.status);
                return r.json();
            })
            .then((data) => {
                const file =
                    data.files?.["list.m3u"] || data.files?.["list.m3u8"];
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
                        )
                            throw new Error("Empty M3U from gist");
                        return { ...parsed, rawUrl };
                    });
            })
            .catch((e) => {
                console.warn("[FckCensor] fetchGistM3U failed:", e);
                return null;
            });
    }
    // ── fetch github raw → list.json ──────────────────────────────────────────
    function fetchGithubJson() {
        return fetch(GITHUB_RAW_URL)
            .then((r) => {
                if (!r.ok) throw new Error("GitHub Raw HTTP " + r.status);
                return r.json();
            })
            .then((parsed) => {
                if (!parsed?.tracks)
                    throw new Error("No .tracks in GitHub Raw response");
                return { tracks: parsed.tracks };
            })
            .catch((e) => {
                console.warn("[FckCensor] fetchGithubJson failed:", e);
                return null;
            });
    }
    // ── fetch local cache ─────────────────────────────────────────────────────
    function fetchLocalM3UCache(url) {
        return fetch(url)
            .then((r) => {
                if (!r.ok) throw new Error();
                return r.text();
            })
            .then((text) => parseM3U(text))
            .catch(() => ({ tracks: {} }));
    }
    function fetchLocalJsonCache(url) {
        return fetch(url)
            .then((r) => {
                if (!r.ok) throw new Error();
                return r.json();
            })
            .then((parsed) => {
                if (!parsed?.tracks) throw new Error();
                return parsed.tracks;
            })
            .catch(() => ({}));
    }
    // ── main load logic ───────────────────────────────────────────────────────
    Promise.all([fetchGistM3U(), fetchGithubJson()])
        .then(([gistResult, githubResult]) => {
            const gistOk = gistResult !== null;
            const githubOk = githubResult !== null;
            if (gistOk || githubOk) {
                const githubTracks = githubOk ? githubResult.tracks : {};
                const gistTracks = gistOk ? gistResult.tracks : {};
                // gist перекрывает github
                remoteTracks = Object.assign({}, githubTracks, gistTracks);
                if (gistOk) saveCache(gistResult.rawUrl, "list.m3u");
                if (githubOk) saveCache(GITHUB_RAW_URL, "list.json");
                console.log(
                    "[FckCensor] Loaded tracks:",
                    Object.keys(remoteTracks).length,
                );
            } else {
                // Оба источника недоступны — используем локальные кэши
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
    // ── patch FileInfo ────────────────────────────────────────────────────────
    let proto, originalGetFileInfo, originalGetFileInfoBatch;
    try {
        proto = fileInfoModule.v.prototype;
        originalGetFileInfo = proto.getFileInfo;
        originalGetFileInfoBatch = proto.getFileInfoBatch;
    } catch (e) {
        console.error("[FckCensor] Failed to access prototype:", e);
        return;
    }
    proto.getFileInfo = async function (params, options) {
        const result = await originalGetFileInfo.apply(this, arguments);
        try {
            const trackId = String(params?.trackId);
            const replacedUrl = getReplaced(trackId);
            if (replacedUrl) {
                patchInfo(result, replacedUrl);
                applyDuration(trackId, replacedUrl);
            }
        } catch (e) {}
        return result;
    };
    proto.getFileInfoBatch = async function (params, options) {
        const result = await originalGetFileInfoBatch.apply(this, arguments);
        try {
            const rawIds = params?.trackIds ?? [];
            const trackIds = Array.isArray(rawIds)
                ? rawIds.map(String)
                : [String(rawIds)];
            const infos = result?.downloadInfos ?? [];
            trackIds.forEach((id, i) => {
                const replacedUrl = getReplaced(id);
                if (replacedUrl && infos[i]) {
                    infos[i].url = replacedUrl;
                    infos[i].urls = [replacedUrl];
                    infos[i].transport = "raw";
                    infos[i].codec = "mp3";
                    infos[i].key = "";
                    applyDuration(id, replacedUrl);
                }
            });
        } catch (e) {}
        return result;
    };
})();
