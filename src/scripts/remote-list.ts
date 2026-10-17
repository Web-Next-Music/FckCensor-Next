export const REMOTE_LIST_COMPATIBILITY_VERSION = "2.0.0";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareVersions(left: number[], right: number[]): number {
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const difference = (left[i] ?? 0) - (right[i] ?? 0);
		if (difference !== 0) return Math.sign(difference);
	}
	return 0;
}

function matchesRange(range: unknown): boolean {
	if (typeof range !== "string") return false;
	const match = /^(>=|<=|!=|[><=^~])?\s*(\d+(?:\.\d+)*)$/.exec(range.trim());
	if (!match) return true;
	const target = match[2]!.split(".").map(Number);
	if (!target.every(Number.isSafeInteger)) return false;
	const current = REMOTE_LIST_COMPATIBILITY_VERSION.split(".").map(Number);
	const comparison = compareVersions(current, target);
	switch (match[1] ?? ">=") {
		case ">=":
			return comparison >= 0;
		case "<=":
			return comparison <= 0;
		case "!=":
			return comparison !== 0;
		case ">":
			return comparison > 0;
		case "<":
			return comparison < 0;
		case "=":
			return comparison === 0;
		case "^":
		case "~": {
			const upper = [target[0] ?? 0, target[1] ?? 0, target[2] ?? 0];
			const pivot =
				match[1] === "~"
					? target.length === 1
						? 0
						: 1
					: upper[0]! > 0 || target.length === 1
						? 0
						: upper[1]! > 0 || target.length === 2
							? 1
							: 2;
			upper[pivot] = upper[pivot]! + 1;
			for (let i = pivot + 1; i < upper.length; i++) upper[i] = 0;
			return comparison >= 0 && compareVersions(current, upper) < 0;
		}
	}
	return false;
}

function supportsClient(source: JsonObject): boolean {
	if (source.supportedVersions === undefined) return true;
	const ranges = Array.isArray(source.supportedVersions)
		? source.supportedVersions
		: typeof source.supportedVersions === "string"
			? source.supportedVersions.split("&")
			: [source.supportedVersions];
	return ranges.every(matchesRange);
}

function audioUrl(
	value: unknown,
	template: string | undefined,
): string | undefined {
	if (
		typeof value !== "string" &&
		!(typeof value === "number" && Number.isFinite(value))
	) {
		return undefined;
	}
	let url: string;
	if (typeof value === "string" && value.includes("://")) url = value;
	else if (template) url = template.replace("%%", String(value));
	else if (typeof value === "string") url = value;
	else return undefined;
	if (!url) return undefined;
	if (url.startsWith("//")) url = `https:${url}`;
	else if (!/^[a-z][a-z\d+.-]*:/i.test(url)) url = `https://${url}`;
	return /^https?:\/\/.+/i.test(url) ? url : undefined;
}

export interface ParsedRemoteList {
	tracks: Record<string, string>;
	trackMetadata: Record<string, Record<string, unknown>>;
}

function withoutDurations(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutDurations);
	if (!isObject(value)) return value;
	const result: JsonObject = {};
	for (const key of Object.keys(value)) {
		if (key !== "durationMs") {
			Object.defineProperty(result, key, {
				value: withoutDurations(value[key]),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
	}
	return result;
}

export function parseRemoteList(data: unknown): ParsedRemoteList {
	const tracks: Record<string, string> = {};
	const trackMetadata: ParsedRemoteList["trackMetadata"] = {};
	if (!isObject(data) || !Array.isArray(data.sources))
		return { tracks, trackMetadata };
	for (const source of data.sources) {
		if (!isObject(source) || !supportsClient(source)) continue;
		if (isObject(source.tracks)) {
			for (const id of Object.keys(source.tracks)) {
				const metadata = source.tracks[id];
				if (
					!isObject(metadata) ||
					Object.prototype.hasOwnProperty.call(trackMetadata, id)
				)
					continue;
				const fields: JsonObject = {};
				for (const key of Object.keys(metadata)) {
					if (
						key === "id" ||
						key === "realId" ||
						key === "__fckCensor" ||
						key === "durationMs"
					)
						continue;
					Object.defineProperty(fields, key, {
						value: withoutDurations(metadata[key]),
						enumerable: true,
						configurable: true,
						writable: true,
					});
				}
				Object.defineProperty(trackMetadata, id, {
					value: fields,
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
		}
		if (!Array.isArray(source.tracksStorages)) continue;
		for (const storage of [...source.tracksStorages].reverse()) {
			if (!isObject(storage)) continue;
			if (
				storage.urlTemplate !== undefined &&
				typeof storage.urlTemplate !== "string"
			)
				continue;
			const template = storage.urlTemplate as string | undefined;
			const add = (id: string, value: unknown) => {
				const url = audioUrl(value, template);
				if (url !== undefined) {
					Object.defineProperty(tracks, id, {
						value: url,
						enumerable: true,
						configurable: true,
						writable: true,
					});
				}
			};
			if (template !== undefined && Array.isArray(storage.trackIds)) {
				for (const entry of storage.trackIds) {
					const id = isObject(entry) ? entry.id : entry;
					if (
						typeof id === "number" &&
						Number.isFinite(id) &&
						!(
							isObject(storage.tracks) &&
							Object.prototype.hasOwnProperty.call(
								storage.tracks,
								String(id),
							)
						)
					) {
						add(String(id), id);
					}
				}
			}
			if (isObject(storage.tracks)) {
				for (const id of Object.keys(storage.tracks)) {
					const entry = storage.tracks[id];
					add(id, isObject(entry) ? entry.url : entry);
				}
			}
		}
	}
	return { tracks, trackMetadata };
}
