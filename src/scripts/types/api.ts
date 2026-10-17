import type { Track } from "./track";

export interface NextMusicApi {
	getCurrentTrack(): Track | undefined;
	getPlayers?(): import("./script").QueuePlayer[];
	onQueueChange?(listener: () => void): unknown;
	onTrackChange?(listener: () => void): unknown;
	downloadAsset?(
		url: string,
		fileName: string,
		addonName: string,
	): Promise<void>;
}

export interface LrclibResponse {
	syncedLyrics?: string | null;
	[key: string]: unknown;
}
