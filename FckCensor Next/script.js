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
            if (remoteTracks[id]) return { url: remoteTracks[id] };
        } catch (e) {
            console.warn("[FckCensor] getReplaced error:", e);
        }
        return null;
    }

    function makeDownloadInfo(id, url, quality) {
        return {
            downloadInfo: {
                trackId: id,
                realId: id,
                quality: quality ?? "nq",
                codec: "mp3",
                bitrate: 320,
                transport: "raw",
                key: "",
                size: 0,
                gain: false,
                urls: [url],
                url: url,
            },
            responseTime: 0,
            url: url,
        };
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
            .catch(function (e) {
                console.warn("[FckCensor] Gist fetch failed:", e);
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
            .catch(function (e) {
                console.warn("[FckCensor] GitHub Raw fetch failed:", e);
                return null;
            });
    }

    function fetchLocalCache(url, label) {
        return fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error(label + " HTTP " + r.status);
                return r.json();
            })
            .then(function (parsed) {
                if (!parsed?.tracks) throw new Error("No .tracks in " + label);
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
            const gistResult = results[0];
            const githubResult = results[1];

            const gistOk = gistResult !== null;
            const githubOk = githubResult !== null;

            if (gistOk || githubOk) {
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

                if (gistOk) saveCache(gistResult.rawUrl, "list.json");
                if (githubOk) saveCache(GITHUB_RAW_URL, "list_hazzz895.json");
            } else {
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
                    remoteTracks = Object.assign({}, caches[0], caches[1]);
                    console.info(
                        "[FckCensor] Tracks from local cache: total=" +
                            Object.keys(remoteTracks).length,
                    );
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
                return makeDownloadInfo(trackId, replaced.url, params?.quality);
            }
        } catch (e) {
            console.warn("[FckCensor] getFileInfo patch error:", e);
        }
        return originalGetFileInfo.apply(this, arguments);
    };

    proto.getFileInfoBatch = async function (params, options) {
        try {
            const rawIds = params?.trackIds ?? [];
            // trackIds может прийти строкой при автоплее
            const isSingle = !Array.isArray(rawIds);
            const trackIds = isSingle ? [String(rawIds)] : rawIds.map(String);

            const hasAnyReplaced = trackIds.some((id) => !!getReplaced(id));

            if (hasAnyReplaced) {
                const missing = trackIds.filter((id) => !getReplaced(id));
                let missingMap = {};

                if (missing.length > 0) {
                    const originalParams = Object.assign({}, params, {
                        trackIds: isSingle ? missing[0] : missing,
                    });
                    try {
                        let originalResults =
                            await originalGetFileInfoBatch.call(
                                this,
                                originalParams,
                                options,
                            );
                        // Нормализуем ответ оригинала в массив
                        if (!Array.isArray(originalResults))
                            originalResults = [originalResults];
                        missing.forEach(function (id, i) {
                            missingMap[id] = originalResults[i] ?? null;
                        });
                    } catch (e) {
                        console.warn(
                            "[FckCensor] originalGetFileInfoBatch failed for missing:",
                            e,
                        );
                    }
                }

                const results = trackIds.map(function (id) {
                    const replaced = getReplaced(id);
                    if (replaced) {
                        console.debug(
                            "[FckCensor] Batch replacing track",
                            id,
                            "→",
                            replaced.url,
                        );
                        return makeDownloadInfo(
                            id,
                            replaced.url,
                            params?.quality,
                        );
                    }
                    return missingMap[id] ?? null;
                });

                // Если пришла строка — возвращаем одиночный объект, не массив
                return isSingle ? results[0] : results;
            }
        } catch (e) {
            console.warn("[FckCensor] getFileInfoBatch patch error:", e);
        }
        return originalGetFileInfoBatch.apply(this, arguments);
    };

    console.info("[FckCensor] Successfully initialized!");
})();
