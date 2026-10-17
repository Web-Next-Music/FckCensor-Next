export type TrackMetadataMap = Record<string, Record<string, unknown>>;

type JsonObject = Record<string, unknown>;
const own = (value: object, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(value, key);
const object = (value: unknown): value is JsonObject =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const ignored = (key: string): boolean =>
	key === "durationMs" || key === "__fckCensor";
const set = (target: JsonObject, key: string, value: unknown): void => {
	if (own(target, key)) {
		if (target[key] === value) return;
		if (value !== null && typeof value === "object") {
			try {
				if (JSON.stringify(target[key]) === JSON.stringify(value))
					return;
			} catch {}
		}
		if (key !== "__proto__") {
			target[key] = value;
			return;
		}
	}
	Object.defineProperty(target, key, {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
};

export function previousMetadataEntity(
	item: unknown,
	previous: unknown,
): unknown {
	if (
		!object(item) ||
		(typeof item.id !== "string" && typeof item.id !== "number") ||
		!Array.isArray(previous)
	)
		return undefined;
	const matches = previous.filter(
		(candidate) =>
			object(candidate) &&
			(typeof candidate.id === "string" ||
				typeof candidate.id === "number") &&
			String(candidate.id) === String(item.id),
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function copy(value: unknown, previous: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) =>
			copy(item, previousMetadataEntity(item, previous)),
		);
	}
	if (!object(value)) return value;
	const result: JsonObject = {};
	if (object(previous) && own(previous, "durationMs"))
		set(result, "durationMs", previous.durationMs);
	for (const key of Object.keys(value)) {
		if (!ignored(key))
			set(
				result,
				key,
				copy(value[key], object(previous) ? previous[key] : undefined),
			);
	}
	return result;
}

function merge(target: JsonObject, patch: JsonObject, top: boolean): void {
	for (const key of Object.keys(patch)) {
		if (ignored(key) || (top && (key === "id" || key === "realId")))
			continue;
		const next = patch[key];
		if (object(next) && own(target, key) && object(target[key]))
			merge(target[key], next, false);
		else
			set(
				target,
				key,
				copy(next, own(target, key) ? target[key] : undefined),
			);
	}
}

export function applyTrackMetadataToTrack<T>(
	track: T,
	metadata: TrackMetadataMap,
): T {
	if (
		!object(track) ||
		!own(track, "id") ||
		(typeof track.id !== "string" && typeof track.id !== "number")
	)
		return track;
	const id = String(track.id);
	if (!own(metadata, id) || !object(metadata[id])) return track;
	const patch = metadata[id];
	const previousCover = track.coverUrl;
	merge(track, patch, true);
	if (typeof patch.coverUri === "string") {
		const size =
			typeof previousCover === "string"
				? previousCover.match(/(?:\/|=)(\d+x\d+)(?=[/?#&]|$)/)
				: null;
		const uri = patch.coverUri.replace(/%%/g, size ? size[1] : "400x400");
		set(
			track,
			"coverUrl",
			/^https?:\/\//i.test(uri)
				? uri.replace(/^http:/i, "https:")
				: `https://${uri.replace(/^\/\//, "")}`,
		);
	}
	return track;
}

export function applyTrackMetadata(
	value: unknown,
	metadata: TrackMetadataMap,
): unknown {
	const seen = new Set<object>();
	function* children(node: JsonObject | unknown[]): Generator<unknown> {
		if (Array.isArray(node)) {
			const length = node.length;
			for (let index = 0; index < length; index++)
				if (index in node) yield node[index];
		} else {
			for (const key of Object.keys(node))
				if (!ignored(key)) yield node[key];
		}
	}
	const pending: {
		node: JsonObject | unknown[];
		children: Iterator<unknown>;
	}[] = [];
	const enter = (node: unknown): void => {
		if (node === null || typeof node !== "object" || seen.has(node)) return;
		seen.add(node);
		const record = node as JsonObject | unknown[];
		pending.push({ node: record, children: children(record) });
	};
	enter(value);
	while (pending.length) {
		const frame = pending[pending.length - 1];
		const child = frame.children.next();
		if (!child.done) {
			enter(child.value);
			continue;
		}
		pending.pop();
		const record = frame.node;
		if (
			!Array.isArray(record) &&
			(own(record, "durationMs") ||
				own(record, "realId") ||
				(Array.isArray(record.albums) && Array.isArray(record.artists)))
		)
			applyTrackMetadataToTrack(record, metadata);
	}
	return value;
}
