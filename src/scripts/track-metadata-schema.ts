import {
	previousMetadataEntity,
	type TrackMetadataMap,
} from "./track-metadata";

type RecordValue = Record<string, unknown>;
export type Schema = {
	properties?: Record<string, Schema>;
	subtype?: Schema;
	_subType?: Schema;
	types?: Schema[];
	is?: (value: unknown) => boolean;
};
export const isRecord = (value: unknown): value is RecordValue =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(value, key);
const excluded = new Set([
	"id",
	"realId",
	"durationMs",
	"__fckCensor",
	"coverUrl",
]);

export function schemaProperties(
	type: Schema | undefined,
	depth = 0,
): Record<string, Schema> | undefined {
	if (!type || depth > 8) return undefined;
	if (isRecord(type.properties)) return type.properties;
	for (const child of [
		type.subtype,
		type._subType,
		...(Array.isArray(type.types) ? type.types : []),
	]) {
		const result = schemaProperties(child, depth + 1);
		if (result) return result;
	}
	return undefined;
}

export function normalizeMetadata(
	value: unknown,
	previous: unknown,
	type: Schema | undefined,
	artists = false,
	depth = 0,
): unknown {
	if (depth > 12) throw new Error("Metadata nesting limit exceeded");
	if (Array.isArray(value)) {
		return value.map((item) =>
			normalizeMetadata(
				item,
				previousMetadataEntity(item, previous),
				type,
				artists,
				depth + 1,
			),
		);
	}
	const props = schemaProperties(type);
	if (!isRecord(value)) return value;
	const result: RecordValue = isRecord(previous) ? { ...previous } : {};
	const input = { ...value };
	if (props && own(props, "isAvailable") && own(value, "available"))
		input.isAvailable = value.available;
	if (props && own(props, "hasLyrics") && own(value, "lyricsAvailable"))
		input.hasLyrics = value.lyricsAvailable;
	if (
		props &&
		own(props, "averageColor") &&
		isRecord(value.derivedColors) &&
		own(value.derivedColors, "average")
	)
		input.averageColor = value.derivedColors.average;
	if (artists) {
		input.id = String(value.id ?? result.id ?? "");
		input.name = value.name ?? result.name ?? "";
		input.isAvailable =
			value.isAvailable ?? value.available ?? result.isAvailable ?? true;
	}
	for (const key of Object.keys(input)) {
		if (
			(props && !own(props, key)) ||
			key === "durationMs" ||
			key === "__fckCensor" ||
			key === "coverUrl"
		)
			continue;
		const fieldType = props?.[key];
		let next = normalizeMetadata(
			input[key],
			result[key],
			fieldType,
			key === "artists",
			depth + 1,
		);
		if (
			key === "id" &&
			typeof next === "number" &&
			fieldType?.is &&
			!fieldType.is(next) &&
			fieldType.is(String(next))
		)
			next = String(next);
		result[key] = next;
	}
	return result;
}

export function trackProperties(type?: Schema) {
	const props = schemaProperties(type);
	return props &&
		["id", "title", "durationMs", "artists"].every((key) => own(props, key))
		? props
		: undefined;
}

export function isExcludedMetadataField(key: string): boolean {
	return excluded.has(key);
}

export function mergeTrackMetadata(
	value: RecordValue,
	type: Schema | undefined,
	props: Record<string, Schema>,
	metadata: TrackMetadataMap,
	onRejected: (key: string) => void,
): RecordValue {
	const id = String(value.id);
	if (!own(metadata, id) || !isRecord(metadata[id])) return value;
	const normalized = normalizeMetadata(
		metadata[id],
		value,
		type,
	) as RecordValue;
	const result = { ...value };
	for (const key of Object.keys(normalized)) {
		if (excluded.has(key) || !own(props, key)) continue;
		if (
			typeof props[key].is !== "function" ||
			!props[key].is(normalized[key])
		) {
			onRejected(key);
			continue;
		}
		result[key] = normalized[key];
	}
	return result;
}
