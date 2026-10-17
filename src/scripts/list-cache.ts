import { parseRemoteList } from "./remote-list";

export const LIST_URL =
	"https://raw.githubusercontent.com/Hazzz895/FckCensorData/refs/heads/main/list_v2.json";
export const CACHE_KEY = "fckcensor:list_v2";
export const LIST_TIMEOUT_MS = 8000;

export function validatedTracks(
	data: unknown,
): ReturnType<typeof parseRemoteList> {
	const parsed = parseRemoteList(data);
	if (
		!Object.keys(parsed.tracks).length &&
		!Object.keys(parsed.trackMetadata).some(
			(id) => Object.keys(parsed.trackMetadata[id]!).length > 0,
		)
	) {
		throw new Error("List v2 contains no usable tracks or metadata");
	}
	return parsed;
}

export function readListCache(
	use: (parsed: ReturnType<typeof parseRemoteList>, source: string) => void,
): void {
	try {
		const cached = localStorage.getItem(CACHE_KEY);
		if (cached)
			use(validatedTracks(JSON.parse(cached)), "localStorage v2 cache");
	} catch (error) {
		console.warn("[FckCensor] Cannot read v2 localStorage cache:", error);
	}
}

export function saveLocalCache(data: unknown): void {
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify(data));
	} catch (error) {
		console.warn("[FckCensor] Cannot save v2 localStorage cache:", error);
	}
}
