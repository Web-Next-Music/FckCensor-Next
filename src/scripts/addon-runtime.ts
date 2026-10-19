import { logger } from "./logger";
import { patchDownloadInfo } from "./playback-shared";
import { installLocalTracks } from "./local-tracks";
import type { PlaybackWindow } from "./types/script";
import {
	findWebpackModule,
	createReplacementGuard,
	createBoundedDiagnostics,
} from "./playback-shared";
import { validatedTracks, readListCache, saveLocalCache } from "./list-cache";
import { getReplacement, normalizeTrackIds } from "./replacements";
import { installAppContexts } from "./app-context";
import { installTrackDuration } from "./track-duration";
import { installTrackMetadataStore } from "./track-metadata-store";
import { installTrackBadges } from "./track-badges";

import type { parseRemoteList } from "./remote-list";
import type { TrackMetadataMap } from "./track-metadata";
import type {
	WebpackRequire,
	WebpackChunk,
	FileInfoServiceProto,
	DownloadInfo,
} from "./types/script";

import { createCleanupStack, createMethodPatcher } from "./patch-utils";
type TrackReplacement = (
	id: string,
	info: DownloadInfo | undefined,
) => void | Promise<void>;

export interface AddonRuntime {
	replaceFileInfo(replace: TrackReplacement, parallelBatch?: boolean): void;
	getReplacement(id: string | number): string | null;
	beginReplacement(id: string, url: string): () => boolean;
	setDuration(id: string | number, url: string, ms: number): void;
	loadTracks(fetchList: () => Promise<unknown>): void;
	dispose(): void;
}
export function createAddonRuntime(
	target: PlaybackWindow,
): AddonRuntime | null {
	const cleanup = createCleanupStack();
	let disposed = false;
	let webpackGlobal: WebpackChunk;
	let appRequire: WebpackRequire | undefined;
	let fileInfoModule: { v: { prototype: FileInfoServiceProto } } | undefined;
	const ADDON_PREFIX = "[FckCensor]";

	try {
		webpackGlobal = target.webpackChunk_N_E;
		if (!webpackGlobal) {
			logger.error("[FckCensor] webpackChunk_N_E not found, aborting");
			cleanup.dispose();
			return null;
		}
	} catch (e) {
		logger.error("[FckCensor] Failed to access webpackChunk_N_E:", e);
		cleanup.dispose();
		return null;
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
		logger.error("[FckCensor] Failed to get appRequire:", e);
		cleanup.dispose();
		return null;
	}

	if (!appRequire) {
		logger.error(`${ADDON_PREFIX} appRequire is null, aborting`);
		cleanup.dispose();
		return null;
	}

	const contexts = installAppContexts(appRequire, webpackGlobal, target);

	cleanup.add(() => contexts.dispose());

	function isFileInfoModuleCandidate(
		mod: unknown,
	): mod is { v: { prototype: FileInfoServiceProto } } {
		const proto = (mod as { v?: { prototype?: FileInfoServiceProto } })?.v
			?.prototype;
		return (
			!!proto &&
			typeof proto.getFileInfo === "function" &&
			typeof proto.getFileInfoBatch === "function"
		);
	}

	fileInfoModule =
		findWebpackModule(appRequire, isFileInfoModuleCandidate) ?? undefined;

	if (!fileInfoModule?.v) {
		logger.error(
			`${ADDON_PREFIX} FileInfo module not found, aborting. Wait for addon update.`,
		);
		cleanup.dispose();
		return null;
	}

	let remoteTracks: Record<string, string> = {};

	let trackMetadata: TrackMetadataMap = {};
	const local = installLocalTracks(target, () => {
		replacementGuard.refresh();
		for (const track of local.tracks.values())
			durationPatches.set(track.id, track.url, track.durationMs);
		durationPatches.refresh();
		metadataStore.refresh();
		trackBadges.refresh();
	});
	cleanup.add(() => local.dispose());
	function combinedMetadata(): TrackMetadataMap {
		const result = { ...trackMetadata };
		for (const id of new Set([
			...Object.keys(remoteTracks),
			...local.tracks.keys(),
		]))
			result[id] = {
				...result[id],
				available: true,
				isAvailable: true,
				error: undefined,
			};
		return result;
	}
	const metadataStore = installTrackMetadataStore(
		combinedMetadata,
		target,
		contexts,
	);
	cleanup.add(() => metadataStore.dispose());
	const durationPatches = installTrackDuration(
		getReplaced,
		combinedMetadata,
		contexts,
		appRequire,
		webpackGlobal,
		target,
	);
	cleanup.add(() => durationPatches.dispose());
	const trackBadges = installTrackBadges(
		(id) =>
			local.tracks.has(id) ||
			Object.prototype.hasOwnProperty.call(remoteTracks, id) ||
			Object.prototype.hasOwnProperty.call(trackMetadata, id),
		target,
		appRequire,
		webpackGlobal,
	);

	cleanup.add(() => trackBadges.dispose());

	function getReplaced(trackId: string | number): string | null {
		return (
			local.tracks.get(String(trackId))?.url ??
			getReplacement(remoteTracks, trackId)
		);
	}

	const replacementGuard = createReplacementGuard((id) => getReplaced(id));
	function useTracks(
		parsed: ReturnType<typeof parseRemoteList>,
		source: string,
	): void {
		remoteTracks = parsed.tracks;
		replacementGuard.refresh();
		trackMetadata = parsed.trackMetadata;
		durationPatches.refresh();
		metadataStore.refresh();
		trackBadges.refresh();
		logger.log(
			`${ADDON_PREFIX} Loaded ${Object.keys(remoteTracks).length} tracks and ${Object.keys(trackMetadata).length} metadata patches from ${source}`,
		);
	}

	let fileInfo: FileInfoServiceProto;
	try {
		fileInfo = fileInfoModule.v.prototype;
		void fileInfo.getFileInfo;
		void fileInfo.getFileInfoBatch;
	} catch (error) {
		logger.error("[FckCensor] Failed to access prototype:", error);
		cleanup.dispose();
		return null;
	}
	return {
		replaceFileInfo(replace, parallelBatch = false) {
			if (!disposed)
				cleanup.add(
					installFileInfoReplacement(
						fileInfo,
						replace,
						parallelBatch,
						async (id) => {
							await local.ready.catch(() => {});
							return local.tracks.get(id)?.url ?? undefined;
						},
						(id) => getReplacement(remoteTracks, id),
					),
				);
		},
		getReplacement: getReplaced,
		beginReplacement(id, url) {
			const current = replacementGuard.begin(id, url);
			return () => !disposed && current();
		},
		setDuration(id, url, ms) {
			if (!disposed) durationPatches.set(id, url, ms);
		},
		loadTracks(fetchList) {
			if (disposed) return;
			readListCache(useTracks);
			void fetchList()
				.then((data) => {
					if (disposed) return;
					const tracks = validatedTracks(data);
					useTracks(tracks, "remote list v2");
					saveLocalCache(data);
				})
				.catch((error) => {
					logger.error(
						`${ADDON_PREFIX} Remote list v2 failed; retaining cache (${Object.keys(remoteTracks).length} tracks):`,
						error,
					);
				});
		},
		dispose() {
			disposed = true;
			cleanup.dispose();
		},
	};
}

function installFileInfoReplacement(
	proto: FileInfoServiceProto,
	replace: TrackReplacement,
	parallelBatch = false,
	localUrl: (id: string) => Promise<string | undefined>,
	remoteUrl: (id: string) => string | null,
): () => void {
	const cleanup = createCleanupStack();
	const patch = createMethodPatcher(cleanup.add);
	const report = createBoundedDiagnostics();
	try {
		patch<FileInfoServiceProto["getFileInfo"]>(
			proto,
			"getFileInfo",
			(original) =>
				async function (this: FileInfoServiceProto, params, options) {
					const id = String(params?.trackId);
					const local = await localUrl(id);
					const url = local ?? remoteUrl(id);
					if (url) {
						const downloadInfo = {} as DownloadInfo;
						patchDownloadInfo(downloadInfo, url);
						if (!local) {
							try {
								await replace(id, downloadInfo);
							} catch (error) {
								report("getFileInfo replacement failed", error);
							}
						}
						return { downloadInfo };
					}
					const result = await original.call(this, params, options);
					try {
						const pending = replace(
							String(params?.trackId),
							result.downloadInfo,
						);
						if (pending) await pending;
					} catch (error) {
						report("getFileInfo replacement failed", error);
					}
					return result;
				},
		);
		patch<FileInfoServiceProto["getFileInfoBatch"]>(
			proto,
			"getFileInfoBatch",
			(original) =>
				async function (this: FileInfoServiceProto, params, options) {
					const ids = normalizeTrackIds(params?.trackIds);
					const urls = await Promise.all(
						ids.map(
							async (id) => (await localUrl(id)) ?? remoteUrl(id),
						),
					);
					if (urls.some(Boolean)) {
						const downloadInfos = await Promise.all(
							ids.map(async (id) => {
								const result = await this.getFileInfo(
									{ trackId: id },
									options,
								);
								return result.downloadInfo!;
							}),
						);
						return { downloadInfos };
					}
					const result = await original.call(this, params, options);
					try {
						const ids = normalizeTrackIds(params?.trackIds);
						const infos = result?.downloadInfos ?? [];
						if (parallelBatch) {
							await Promise.all(
								ids.map(async (id, i) => {
									if (infos[i]) await replace(id, infos[i]);
								}),
							);
						} else {
							ids.forEach((id, i) => {
								if (infos[i]) replace(id, infos[i]);
							});
						}
					} catch (error) {
						report("getFileInfoBatch replacement failed", error);
					}
					return result;
				},
		);
	} catch (error) {
		cleanup.dispose();
		throw error;
	}
	return cleanup.dispose;
}
