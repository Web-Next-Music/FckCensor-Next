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
            const id = String(trackId);
            return remoteTracks[id] ?? null;
        } catch (e) {}
        return null;
    }

    // ── duration cache + fetch ────────────────────────────────────────────────
    const durationCache = {};

    function fetchDuration(url) {
        if (durationCache[url] !== undefined) {
            return Promise.resolve(durationCache[url]);
        }
        return fetch(url)
            .then(function (r) {
                return r.arrayBuffer();
            })
            .then(function (buf) {
                return new Promise(function (resolve, reject) {
                    try {
                        const ctx = new (
                            window.AudioContext || window.webkitAudioContext
                        )();
                        ctx.decodeAudioData(
                            buf,
                            function (decoded) {
                                ctx.close();
                                durationCache[url] = decoded.duration;
                                resolve(decoded.duration);
                            },
                            reject,
                        );
                    } catch (e) {
                        reject(e);
                    }
                });
            })
            .catch(function (e) {
                console.warn("[FckCensor] fetchDuration failed:", e);
                return null;
            });
    }

    // ── patch queue duration — all known paths ────────────────────────────────
    function patchQueueDuration(trackId, durationMs) {
        const id = String(trackId);
        let patched = 0;

        try {
            // Path 1: via _ymPlayers (filled by api.js)
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
            // Path 2: traverse React fiber directly (independent of _ymPlayers)
            const VE = appRequire(46663)?.VE;
            if (!VE) return;

            const rootEl = document.getElementById("__next") || document.body;
            const fiberKey = Object.keys(rootEl).find((k) =>
                k.startsWith("__reactFiber"),
            );
            if (!fiberKey) return;

            function walkFiber(fiber, depth) {
                if (!fiber || depth > 60) return;

                // Look for entityList in memoizedState
                let state = fiber.memoizedState;
                while (state) {
                    patchInValue(state.memoizedState, id, durationMs);
                    state = state.next;
                }

                // And in stateNode if it's a player instance
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

            function patchInValue(obj, id, durationMs, visited = new Set()) {
                if (!obj || typeof obj !== "object" || visited.has(obj)) return;
                visited.add(obj);

                // Is this entityList?
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

                // Is this an observable with .value?
                if ("value" in obj && Array.isArray(obj.value)) {
                    patchInValue(obj.value, id, durationMs, visited);
                }
            }

            walkFiber(rootEl[fiberKey], 0);
        } catch (e) {
            console.warn("[FckCensor] patchQueueDuration path2 failed:", e);
        }

        if (patched === 0) {
            console.warn(
                "[FckCensor] patchQueueDuration: track not found in queue, id=",
                id,
            );
        }
    }

    // ── duration overrides for RPC ────────────────────────────────────────────
    // Stores real duration of replaced tracks { trackId -> durationMs }
    // siteRPCServer reads nextmusicApi.getCurrentTrack().durationMs — we patch
    // this method here so RPC always sees the correct value.
    window.__fckCensorDuration = window.__fckCensorDuration ?? {};

    // Tracks for which fetchDuration has not finished yet.
    // While the id is here — getCurrentTrack() returns coverUrl with suffix
    // "#fck_pending" so RPC stores it in lastSentData.
    // Once duration is loaded — id is removed from the set,
    // and on the next poll() RPC sees img change → isStateChanged=true
    // → resends the track with correct durationSec.
    const _fckPendingDuration = new Set();

    // ── apply duration with retries ───────────────────────────────────────────
    // Queue may update later — retry several times
    function applyDuration(trackId, replacedUrl) {
        const id = String(trackId);

        // Mark track as "duration still loading"
        _fckPendingDuration.add(id);

        fetchDuration(replacedUrl).then(function (dur) {
            if (dur == null) {
                _fckPendingDuration.delete(id);
                return;
            }
            const durationMs = Math.round(dur * 1000);

            // Save for nextmusicApi patch
            window.__fckCensorDuration[id] = durationMs;

            // Immediately
            patchQueueDuration(trackId, durationMs);

            // And again after 300ms / 800ms / 1500ms — in case queue
            // wasn't updated yet at first call
            [300, 800, 1500].forEach(function (delay) {
                setTimeout(function () {
                    patchQueueDuration(trackId, durationMs);
                }, delay);
            });

            // Remove pending flag — on next poll() RPC will detect
            // img change (suffix removed) and resend track
            _fckPendingDuration.delete(id);
        });
    }

    // ── patch nextmusicApi for RPC ─────────────────────────────────────────────
    // Wrap getCurrentTrack() so siteRPCServer always gets correct duration
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

                // No override — return original
                if (overrideDurationMs == null && !isPending) return track;

                const patch = {
                    durationMs: overrideDurationMs ?? track.durationMs,
                };

                // While loading — mark coverUrl to trigger RPC update
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

        let _api = undefined;
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
            const pollId = setInterval(function () {
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
        "https://api.github.com/gists/c356a73d2d36d218b5cbd67651e387c0";
    const GITHUB_RAW_URL =
        "https://raw.githubusercontent.com/Hazzz895/FckCensorData/refs/heads/main/list.json";
    const LOCAL_GIST_CACHE_URL =
        "http://localhost:2007/assets/list.json?name=FckCensor%20Next&";
    const LOCAL_GITHUB_CACHE_URL =
        "http://localhost:2007/assets/list_hazzz895.json?name=FckCensor%20Next&";

    // ── save cache via nextmusicApi ───────────────────────────────────────────
    function saveCache(sourceUrl, fileName) {
        try {
            if (!window.nextmusicApi?.downloadAsset) return;
            window.nextmusicApi
                .downloadAsset(sourceUrl, fileName, ADDON_NAME)
                .catch(() => {});
        } catch (e) {}
    }

    // ── fetch helpers ─────────────────────────────────────────────────────────
    function fetchGist() {
        return fetch(GIST_URL)
            .then(function (r) {
                if (!r.ok) throw new Error("Gist index HTTP " + r.status);
                return r.json();
            })
            .then(function (data) {
                const file = data.files?.["list.json"];
                if (!file?.raw_url)
                    throw new Error("raw_url not found in gist");
                const rawUrl = file.raw_url;
                return fetch(rawUrl).then(function (r2) {
                    if (!r2.ok) throw new Error("Gist raw HTTP " + r2.status);
                    return r2.json().then(function (parsed) {
                        if (!parsed?.tracks)
                            throw new Error("No .tracks in gist response");
                        return { tracks: parsed.tracks, rawUrl: rawUrl };
                    });
                });
            })
            .catch(function () {
                return null;
            });
    }

    function fetchGithubRaw() {
        return fetch(GITHUB_RAW_URL)
            .then(function (r) {
                if (!r.ok) throw new Error("GitHub Raw HTTP " + r.status);
                return r.json();
            })
            .then(function (parsed) {
                if (!parsed?.tracks)
                    throw new Error("No .tracks in GitHub Raw response");
                return { tracks: parsed.tracks };
            })
            .catch(function () {
                return null;
            });
    }

    function fetchLocalCache(url) {
        return fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error();
                return r.json();
            })
            .then(function (parsed) {
                if (!parsed?.tracks) throw new Error();
                return parsed.tracks;
            })
            .catch(function () {
                return {};
            });
    }

    // ── main load logic ───────────────────────────────────────────────────────
    Promise.all([fetchGist(), fetchGithubRaw()])
        .then(function (results) {
            const gistResult = results[0];
            const githubResult = results[1];

            const gistOk = gistResult !== null;
            const githubOk = githubResult !== null;

            if (gistOk || githubOk) {
                const base = githubOk ? githubResult.tracks : {};
                const override = gistOk ? gistResult.tracks : {};
                remoteTracks = Object.assign({}, base, override);

                if (gistOk) saveCache(gistResult.rawUrl, "list.json");
                if (githubOk) saveCache(GITHUB_RAW_URL, "list_hazzz895.json");
            } else {
                Promise.all([
                    fetchLocalCache(LOCAL_GIST_CACHE_URL),
                    fetchLocalCache(LOCAL_GITHUB_CACHE_URL),
                ]).then(function (caches) {
                    remoteTracks = Object.assign({}, caches[0], caches[1]);
                });
            }
        })
        .catch(function (e) {
            console.error("[FckCensor] Unexpected error in load logic:", e);
        });

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
            const isSingle = !Array.isArray(rawIds);
            const trackIds = isSingle ? [String(rawIds)] : rawIds.map(String);
            const infos = result?.downloadInfos ?? [];

            trackIds.forEach(function (id, i) {
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
