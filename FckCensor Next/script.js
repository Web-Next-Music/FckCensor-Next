(function () {
    console.info("[FckCensor] Script started");

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
    console.debug("[FckCensor] appRequire OK");

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
    console.debug("[FckCensor] FileInfo module OK");

    // ── track storage ─────────────────────────────────────────────────────────
    let remoteTracks = {};

    function getReplaced(trackId) {
        try {
            if (!trackId) return null;
            const id = String(trackId);
            if (remoteTracks[id]) return { url: remoteTracks[id] };
        } catch (e) {
            console.warn("[FckCensor] getReplaced error:", e);
        }
        return null;
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

    // ── cache save via nextmusicApi ───────────────────────────────────────────
    function saveCache(sourceUrl, fileName) {
        try {
            if (!window.nextmusicApi?.downloadAsset) {
                console.warn(
                    "[FckCensor] nextmusicApi.downloadAsset not available, skipping cache for:",
                    fileName,
                );
                return;
            }
            window.nextmusicApi
                .downloadAsset(sourceUrl, fileName, ADDON_NAME)
                .then(() =>
                    console.debug(
                        "[FckCensor] Cache saved:",
                        fileName,
                        "←",
                        sourceUrl,
                    ),
                )
                .catch((e) =>
                    console.warn(
                        "[FckCensor] Cache save failed for",
                        fileName,
                        ":",
                        e,
                    ),
                );
        } catch (e) {
            console.warn("[FckCensor] saveCache threw:", e);
        }
    }

    // ── fetch helpers ─────────────────────────────────────────────────────────

    // Возвращает { tracks, rawUrl } или null при любой ошибке
    function fetchGist() {
        console.debug("[FckCensor] Fetching gist index...");
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
                console.debug("[FckCensor] Gist raw_url:", rawUrl);
                return fetch(rawUrl).then(function (r2) {
                    if (!r2.ok) throw new Error("Gist raw HTTP " + r2.status);
                    return r2.json().then(function (parsed) {
                        if (!parsed?.tracks)
                            throw new Error("No .tracks in gist response");
                        console.debug(
                            "[FckCensor] Gist tracks count:",
                            Object.keys(parsed.tracks).length,
                        );
                        return { tracks: parsed.tracks, rawUrl: rawUrl };
                    });
                });
            })
            .catch(function (e) {
                console.warn("[FckCensor] Gist fetch failed:", e);
                return null;
            });
    }

    // Возвращает { tracks } или null при любой ошибке
    function fetchGithubRaw() {
        console.debug("[FckCensor] Fetching GitHub Raw...");
        return fetch(GITHUB_RAW_URL)
            .then(function (r) {
                if (!r.ok) throw new Error("GitHub Raw HTTP " + r.status);
                return r.json();
            })
            .then(function (parsed) {
                if (!parsed?.tracks)
                    throw new Error("No .tracks in GitHub Raw response");
                console.debug(
                    "[FckCensor] GitHub Raw tracks count:",
                    Object.keys(parsed.tracks).length,
                );
                return { tracks: parsed.tracks };
            })
            .catch(function (e) {
                console.warn("[FckCensor] GitHub Raw fetch failed:", e);
                return null;
            });
    }

    // Возвращает tracks {} или {} при любой ошибке
    function fetchLocalCache(url, label) {
        console.debug("[FckCensor] Trying local cache:", label);
        return fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error(label + " HTTP " + r.status);
                return r.json();
            })
            .then(function (parsed) {
                if (!parsed?.tracks) throw new Error("No .tracks in " + label);
                console.debug(
                    "[FckCensor] Local cache tracks:",
                    label,
                    Object.keys(parsed.tracks).length,
                );
                return parsed.tracks;
            })
            .catch(function (e) {
                console.warn("[FckCensor] Local cache unavailable:", label, e);
                return {};
            });
    }

    // ── main load logic ───────────────────────────────────────────────────────
    Promise.all([fetchGist(), fetchGithubRaw()])
        .then(function (results) {
            const gistResult = results[0]; // { tracks, rawUrl } | null
            const githubResult = results[1]; // { tracks }         | null

            const gistOk = gistResult !== null;
            const githubOk = githubResult !== null;

            console.debug(
                "[FckCensor] Sources: gist=" + gistOk + " github=" + githubOk,
            );

            if (gistOk || githubOk) {
                // Мерж: github как база, gist поверх — gist приоритетнее
                const base = githubOk ? githubResult.tracks : {};
                const override = gistOk ? gistResult.tracks : {};
                remoteTracks = Object.assign({}, base, override);

                console.info(
                    "[FckCensor] Tracks merged: github=" +
                        Object.keys(base).length +
                        " gist=" +
                        Object.keys(override).length +
                        " total=" +
                        Object.keys(remoteTracks).length,
                );

                // Кэшируем каждый источник отдельно для fallback
                if (gistOk) saveCache(gistResult.rawUrl, "list.json");
                if (githubOk) saveCache(GITHUB_RAW_URL, "list_hazzz895.json");
            } else {
                // Оба удалённых источника недоступны — пробуем локальные кэши
                console.warn(
                    "[FckCensor] Both remote sources failed, loading from local caches...",
                );

                Promise.all([
                    fetchLocalCache(LOCAL_GIST_CACHE_URL, "list.json"),
                    fetchLocalCache(
                        LOCAL_GITHUB_CACHE_URL,
                        "list_hazzz895.json",
                    ),
                ]).then(function (caches) {
                    const cachedGithub = caches[0]; // приоритет ниже (был gist кэш, но назовём корректно)
                    const cachedGist = caches[1];

                    // Тот же порядок мержа: github-кэш как база, gist-кэш поверх
                    remoteTracks = Object.assign({}, cachedGithub, cachedGist);
                    console.info(
                        "[FckCensor] Tracks from local cache: total=" +
                            Object.keys(remoteTracks).length,
                    );
                });
            }
        })
        .catch(function (e) {
            // Promise.all не должен сюда попасть — оба промиса уже .catch внутри
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
        try {
            const trackId = String(params?.trackId);
            const replaced = getReplaced(trackId);
            if (replaced) {
                console.debug(
                    "[FckCensor] Replacing track",
                    trackId,
                    "→",
                    replaced.url,
                );
                return {
                    downloadInfo: {
                        trackId: trackId,
                        realId: trackId,
                        quality: params?.quality ?? "nq",
                        codec: "mp3",
                        bitrate: 320,
                        transport: "raw",
                        key: "",
                        size: 0,
                        gain: false,
                        urls: [replaced.url],
                        url: replaced.url,
                    },
                    responseTime: 0,
                    url: replaced.url,
                };
            }
        } catch (e) {
            console.warn("[FckCensor] getFileInfo patch error:", e);
        }
        return originalGetFileInfo.apply(this, arguments);
    };

    proto.getFileInfoBatch = async function (params, options) {
        try {
            const trackIds = (params?.trackIds ?? []).map(String);
            const allReplaced = trackIds.every((id) => !!getReplaced(id));
            if (allReplaced) {
                return trackIds.map((id) => {
                    const replaced = getReplaced(id);
                    console.debug(
                        "[FckCensor] Batch replacing track",
                        id,
                        "→",
                        replaced.url,
                    );
                    return {
                        downloadInfo: {
                            trackId: id,
                            realId: id,
                            quality: params?.quality ?? "nq",
                            codec: "mp3",
                            bitrate: 320,
                            transport: "raw",
                            key: "",
                            size: 0,
                            gain: false,
                            urls: [replaced.url],
                            url: replaced.url,
                        },
                        responseTime: 0,
                        url: replaced.url,
                    };
                });
            }
        } catch (e) {
            console.warn("[FckCensor] getFileInfoBatch patch error:", e);
        }
        return originalGetFileInfoBatch.apply(this, arguments);
    };

    console.info("[FckCensor] Successfully initialized!");
})();
