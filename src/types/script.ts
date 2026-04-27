import type { NextMusicApi } from "./api";

export interface WebpackRequire {
	(id: number | string): any;
	m?: Record<string, unknown>;
}

export type WebpackChunkEntry = [
	symbol[],
	Record<string, unknown>,
	(r: WebpackRequire) => void,
];

export type WebpackChunk = Array<unknown> & {
	push(entry: WebpackChunkEntry): number;
	pop(): unknown;
};

export interface FileInfoServiceProto {
	getFileInfo(
		params: GetFileInfoParams,
		options?: unknown,
	): Promise<FileInfoResult>;
	getFileInfoBatch(
		params: GetFileInfoBatchParams,
		options?: unknown,
	): Promise<FileInfoBatchResult>;
	[key: string]: unknown;
}

export interface QueueEntityMeta {
	id: string | number;
	realId?: string | number;
	durationMs: number;
}

export interface QueueEntityEntry {
	entity?: {
		entityData?: {
			meta?: QueueEntityMeta;
		};
	};
}

export interface GetFileInfoParams {
	trackId?: string | number;
}

export interface GetFileInfoBatchParams {
	trackIds?: string | number | Array<string | number>;
}

export interface DownloadInfo {
	url: string;
	urls: string[];
	transport: string;
	codec: string;
	key: string;
}

export interface FileInfoResult {
	downloadInfo?: DownloadInfo;
}

export interface FileInfoBatchResult {
	downloadInfos?: DownloadInfo[];
}

export interface PatchedNextMusicApi extends NextMusicApi {
	__fckCensorPatched?: boolean;
}
