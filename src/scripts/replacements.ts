export function normalizeTrackIds(
	trackIds: string | number | Array<string | number> | null | undefined,
): string[] {
	if (trackIds == null) return [];
	const ids = Array.isArray(trackIds) ? trackIds : [trackIds];
	const normalized: string[] = [];
	for (const id of ids) {
		normalized.push(
			...String(id)
				.split(",")
				.map((part) => part.trim()),
		);
	}
	return normalized;
}

export function getReplacement(
	tracks: Record<string, string>,
	trackId: string | number,
): string | null {
	const ids = normalizeTrackIds(trackId);
	const [id] = ids;
	if (!id || ids.length !== 1) return null;
	return Object.prototype.hasOwnProperty.call(tracks, id) ? tracks[id] : null;
}
