(function () {
    const webpackGlobal = window.webpackChunk_N_E;
    let appRequire = null;

    webpackGlobal.push([
        [Symbol("requireGetter__FckCensor")],
        {},
        (r) => {
            appRequire = r;
        },
    ]);
    webpackGlobal.pop();

    if (!appRequire) {
        console.error("[FckCensor] Failed to get appRequire func");
        return;
    }

    const fileInfoModule = appRequire(63974);
    if (!fileInfoModule?.v) {
        console.error("[FckCensor] Failed to find FileInfo module (63974)");
        return;
    }

    // ===================== TRACK STORAGE =====================
    let localTracks = {};
    let remoteTracks = {};

    function getReplaced(trackId) {
        if (!trackId) return null;
        const id = String(trackId);
        if (localTracks[id]) return { url: localTracks[id], src: "local" };
        if (remoteTracks[id]) return { url: remoteTracks[id], src: "remote" };
        return null;
    }

    function updateLocalTracks() {
        fetch("http://localhost:2007/assets?name=FckCensor")
            .then((r) => r.json())
            .then((data) => {
                Object.keys(data.files).forEach((file) => {
                    const id = file.split(".")[0];
                    localTracks[id] =
                        "http://localhost:2007/assets/" +
                        file +
                        "?name=FckCensor&";
                });
                console.debug("[FckCensor] Local tracks:", localTracks);
            })
            .catch((e) =>
                console.warn("[FckCensor] Local server unavailable:", e),
            );
    }

    updateLocalTracks();

    fetch(
        "https://raw.githubusercontent.com/Hazzz895/FckCensorData/refs/heads/main/list.json",
    )
        .then((r) => r.json())
        .then((data) => {
            remoteTracks = data.tracks;
            console.debug("[FckCensor] Remote tracks:", remoteTracks);
        })
        .catch((e) =>
            console.warn("[FckCensor] Failed to load remote tracks:", e),
        );

    // ===================== PATCH =====================
    const proto = fileInfoModule.v.prototype;
    const originalGetFileInfo = proto.getFileInfo;
    const originalGetFileInfoBatch = proto.getFileInfoBatch;

    proto.getFileInfo = async function (params, options) {
        const trackId = String(params?.trackId);
        const replaced = getReplaced(trackId);

        if (replaced) {
            console.debug(
                "[FckCensor] Replacing track",
                trackId,
                "→",
                replaced.url,
            );

            // Точная структура как у оригинального ответа
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

        return originalGetFileInfo.apply(this, arguments);
    };

    proto.getFileInfoBatch = async function (params, options) {
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

        return originalGetFileInfoBatch.apply(this, arguments);
    };

    console.info("[FckCensor] Successfully initialized!");
})();
