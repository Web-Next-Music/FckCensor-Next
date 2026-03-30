(function() {
    // получение метода require из webpack
    const webpackGlobal = window.webpackChunk_N_E;
    let appRequire = null;

    webpackGlobal.push([[Symbol("requireGetter__FckCensor")],
        {},
        (internalRequire) => {
            appRequire = internalRequire;
        }
    ]);
    webpackGlobal.pop();

    if (!appRequire) {
        console.error("Failed to get appRequire func");
        return;
    }

    // получение DI модуля (оно хранит все синглтоны необходимые для работы аддона)
    const diModule = appRequire(58900);
    if (!diModule || !diModule.Dt) {
        console.error("Failed to find DI module. Wait for addon update!");
        return;
    }

    let hooked = false;
    const di = diModule.Dt;
    const originalDiGet = di.prototype.get;

    // пытаемся хукнуть получение этого самого DI
    let diMap = null;
    di.prototype.get = function(_) {
        const result = originalDiGet.apply(this, arguments);

        if (!hooked) {
            diMap = this.shared;
            const slam = diMap.get("Slam");
            const gfir = diMap.get("GetFileInfoResource");
            
            if (slam && gfir) {
                hooked = true;
                
                di.prototype.get = originalDiGet; 
                
                main(slam, gfir);
            }
        }
        
        return result;
    };

    function getReplaced(trackId) {
        if (!trackId) return null;
        url = null;
        src = null;
        if (localTracks[trackId]) {
            url = localTracks[trackId];
            src = "local";
        }
        else if (remoteTracks[trackId]) {
            url = remoteTracks[trackId];
            src = "remote";
        }
        return url ? { url, src } : null;
    }

    function updateLocalTracks() {
        fetch("http://localhost:2007/assets?name=FckCensor")
            .then(response => response.json())
            .then(data => {
                Object.keys(data.files).forEach(file => {
                    id = file.split(".")[0]
                    url = "http://localhost:2007/assets/" + file + "?name=FckCensor&"
                    localTracks[id] = url;
                });
                console.debug(localTracks);
            });
    }

    let localTracks = {};
    updateLocalTracks();
    let remoteTracks = {};

    fetch("https://raw.githubusercontent.com/Hazzz895/FckCensorData/refs/heads/main/list.json")
        .then(response => response.json())
        .then(data => {
            remoteTracks = data.tracks;
            console.debug(remoteTracks)
        });

    // основной код аддона, выполняется после инициализации DI
    function main(slam, gfir) {
        // подмена треков
        const originalGetFileInfo = gfir.getLocalFileDownloadInfo;
        gfir.getLocalFileDownloadInfo = async function(trackId) {
            const replacedTrack = getReplaced(trackId);
            if (replacedTrack) {
                console.debug("Replacing track " + trackId + " with url " + replacedTrack.url);
                return {
                    trackId: trackId,
                    urls: [replacedTrack.url]
                };
            }
            return originalGetFileInfo.apply(this, arguments);
        };

        const originalIsDownloaded = gfir.isTrackDownloaded;
        gfir.isTrackDownloaded = async function(trackId, quality) {
            if (getReplaced(trackId)) {
                return true;
            }
            return originalIsDownloaded.apply(this, arguments);
        };
    }

    function onContextMenuClick(entity, item) {
        const trackId = entity.id;
        const replaced = getReplaced(trackId);
        if (!replaced) {
            
        }
        else {
            delete localTracks[trackId];
            localStorage.setItem("fckcensor_localtracks", JSON.stringify(localTracks));
            updateReplaceItem(entity, item);
            console.debug("Removed track " + trackId + " from local tracks");
        }
    }

    function updateReplaceItem(entity, item) {
        const span = item.querySelector('span')
        const replaced = !!getReplaced(entity?.id);

        span.childNodes[0].firstElementChild.setAttribute("xlink:href", "/icons/sprite.svg#" + (replaced ? "close" : "pensil") + "_xxs");
        span.childNodes[1].nodeValue = replaced ? "Удалить замену" : "Подменить трек";
    }

    /*const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (!(node instanceof HTMLElement)) return;
                const trackMenu = node?.querySelector("[data-test-id='TRACK_CONTEXT_MENU']:not(:has([data-test-id='CONTEXT_MENU_REPLACE_BUTTON']))");
                if (trackMenu) {
                    const button = trackMenu.ariaLabelledByElements[0];
                    if (button.matches("[data-test-id='PLAYERBAR_DESKTOP_CONTEXT_MENU_BUTTON'], [data-test-id='FULLSCREEN_PLAYER_CONTEXT_MENU_BUTTON']")) {
                        const entity = window.pulsesyncApi?.getCurrentTrack();
                        const replaced = getReplaced(entity?.id);
                        if (!entity || !replaced || replaced?.src == "remote") return;
                        const downloadItem = trackMenu.querySelector('[data-test-id="CONTEXT_MENU_DOWNLOAD_BUTTON"]')
                        const replaceItem = downloadItem.cloneNode(true)
                        replaceItem.setAttribute('data-test-id', 'CONTEXT_MENU_REPLACE_BUTTON');
                        updateReplaceItem(entity, replaceItem);
                        replaceItem.addEventListener('click', () => onContextMenuClick(entity, replaceItem));
                        downloadItem.parentElement.insertBefore(replaceItem, downloadItem.nextSibling);
                    }
                }
            })
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });*/
})();