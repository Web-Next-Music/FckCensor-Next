import type { PlaybackWindow } from "./types/script";
import { logger } from "./logger";

export interface LocalTrack {
	id: string;
	data: Blob;
	durationMs: number;
}
export function validateLocalTrack(track: LocalTrack): void {
	if (
		!/^[0-9]+$/.test(track.id) ||
		!track.data.size ||
		!Number.isFinite(track.durationMs) ||
		track.durationMs <= 0
	)
		throw new Error("Invalid local audio track");
}

export function getRowTrackId(row: Element): string | undefined {
	let id =
		row.getAttribute("data-track-id") ||
		row.getAttribute("data-pulsesync-track-id");
	if (id && /^[0-9]+$/.test(id)) return id;
	for (const link of row.querySelectorAll<HTMLAnchorElement>("a[href]")) {
		const url = new URL(link.href);
		id =
			url.pathname.match(/\/track\/(\d+)/)?.[1] ??
			url.searchParams.get("trackId");
		if (id && /^[0-9]+$/.test(id)) return id;
	}
	type Fiber = {
		memoizedProps?: { track?: { id?: unknown } };
		return?: Fiber;
	};
	const key = Object.keys(row).find((key) => key.startsWith("__reactFiber$"));
	let fiber = key
		? (row as unknown as Record<string, Fiber>)[key]
		: undefined;
	for (let depth = 0; fiber && depth < 20; depth++, fiber = fiber.return) {
		const value = fiber.memoizedProps?.track?.id;
		if (value != null && /^[0-9]+$/.test(String(value)))
			return String(value);
	}
	return undefined;
}

export function installLocalTracks(
	target: PlaybackWindow,
	changed: () => void,
) {
	const tracks = new Map<string, LocalTrack & { url: string }>();
	let disposed = false;
	let dialog: HTMLDialogElement | undefined;
	const database = new Promise<IDBDatabase>((resolve, reject) => {
		const request = target.indexedDB.open("FckCensorNext", 1);
		request.onupgradeneeded = () =>
			request.result.createObjectStore("tracks", { keyPath: "id" });
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	function accept(track: LocalTrack) {
		validateLocalTrack(track);
		if (disposed) return;
		const previous = tracks.get(track.id);
		tracks.set(track.id, {
			...track,
			url: target.URL.createObjectURL(track.data),
		});
		if (previous) target.URL.revokeObjectURL(previous.url);
	}
	const ready = database.then(
		(db) =>
			new Promise<void>((resolve, reject) => {
				const transaction = db.transaction("tracks", "readonly");
				const request = transaction.objectStore("tracks").getAll();
				transaction.oncomplete = () => {
					for (const track of request.result) {
						try {
							accept(track);
						} catch (error) {
							logger.warn(
								"[FckCensor] Invalid stored audio",
								error,
							);
						}
					}
					if (!disposed) changed();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			}),
	);
	async function restore(id: string, data: Blob): Promise<void> {
		await ready;
		if (disposed) throw new Error("Addon stopped");
		const url = target.URL.createObjectURL(data);
		let durationMs: number;
		try {
			durationMs = await new Promise<number>((resolve, reject) => {
				const audio = new target.Audio();
				const finish = (error?: Error) => {
					clearTimeout(timer);
					audio.onloadedmetadata = null;
					audio.onerror = null;
					const ms = Math.round(audio.duration * 1000);
					audio.removeAttribute("src");
					audio.load();
					if (error) reject(error);
					else resolve(ms);
				};
				const timer = setTimeout(
					() => finish(new Error("Audio metadata timed out")),
					30000,
				);
				audio.onloadedmetadata = () => finish();
				audio.onerror = () =>
					finish(new Error("Failed to read the audio file"));
				audio.src = url;
			});
		} finally {
			target.URL.revokeObjectURL(url);
		}
		const track = { id, data, durationMs };
		validateLocalTrack(track);
		if (disposed) throw new Error("Addon stopped");
		const db = await database;
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction("tracks", "readwrite");
			transaction.objectStore("tracks").put(track);
			transaction.oncomplete = () => resolve();
			transaction.onabort = transaction.onerror = () =>
				reject(transaction.error);
		});
		accept(track);
		if (!disposed) changed();
	}
	function open(id: string) {
		dialog?.remove();
		const element = target.document.createElement("dialog");
		dialog = element;
		element.dataset.fckcensorRestore = id;
		element.classList.add("ifxS_8bgSnwBoCsyow0E");
		element.setAttribute("aria-label", "Restore track");
		const nativeButton = target.document.querySelector<HTMLButtonElement>(
			'button[class*="VibeSettings_toggleSettingsButton"], button[class*="Tab_root"]',
		);
		const buttonClass =
			nativeButton?.className
				.split(" ")
				.filter((name) => !name.includes("_") || !name.includes("__"))
				.join(" ") ?? "";
		const title = target.document.createElement("h3");
		title.textContent = "Restore track";
		const input = target.document.createElement("input");
		input.type = "file";
		input.accept = "audio/*,.mp3,.wav,.ogg,.flac,.m4a";
		input.dataset.fckcensorAudio = "";
		const choose = target.document.createElement("label");
		choose.className = buttonClass;
		choose.dataset.primary = "";
		const chooseText = target.document.createElement("span");
		chooseText.textContent = "Choose audio file";
		input.setAttribute("aria-label", "Choose audio file");
		choose.append(chooseText, input);
		const status = target.document.createElement("p");
		status.setAttribute("role", "status");
		status.textContent = "Select a local audio file";
		const close = target.document.createElement("button");
		close.type = "button";
		const nativeClose = target.document.querySelector<HTMLButtonElement>(
			'[role="dialog"] button[aria-label="Close"]',
		);
		close.className = nativeClose?.className ?? buttonClass;
		close.dataset.close = "";
		close.setAttribute("aria-label", "Close");
		const icon = target.document.createElementNS(
			"http://www.w3.org/2000/svg",
			"svg",
		);
		icon.setAttribute("aria-hidden", "true");
		icon.setAttribute("focusable", "false");
		const use = target.document.createElementNS(
			"http://www.w3.org/2000/svg",
			"use",
		);
		use.setAttribute("href", "/icons/sprite.svg#close_xxs");
		icon.append(use);
		close.append(icon);
		close.onclick = () => element.close();
		element.onclose = () => element.remove();
		input.onchange = () => {
			const file = input.files?.[0];
			if (!file) return;
			input.disabled = true;
			chooseText.textContent = "Saving…";
			status.textContent = file.name;
			element.setAttribute("aria-busy", "true");
			void restore(id, file)
				.then(
					() => {
						choose.remove();
						status.textContent =
							"Track restored. Click the track to play it.";
					},
					(error) => {
						status.textContent = String(error);
					},
				)
				.then(() => {
					input.disabled = false;
					chooseText.textContent = "Choose audio file";
					input.value = "";
					element.setAttribute("aria-busy", "false");
				});
		};
		element.onclick = (event) => {
			if (event.target !== element) return;
			const rect = element.getBoundingClientRect();
			if (
				event.clientX < rect.left ||
				event.clientX > rect.right ||
				event.clientY < rect.top ||
				event.clientY > rect.bottom
			)
				element.close();
		};
		const header = target.document.createElement("header");
		header.append(title, close);
		const content = target.document.createElement("div");
		content.dataset.content = "";
		content.append(status, choose);
		element.append(header, content);
		target.document.body.append(element);
		element.showModal();
	}
	function click(event: MouseEvent) {
		const node =
			event.target instanceof target.Element ? event.target : null;
		const row = node?.closest('[class*="CommonTrack_root"]');
		if (!row || !row.className.includes("disabled")) return;
		const id = getRowTrackId(row);
		if (!id) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		open(id);
	}
	target.document.addEventListener("click", click, true);
	void ready.catch((error) =>
		logger.error("[FckCensor] Local tracks unavailable", error),
	);
	const api = { ready, restore, open, tracks };
	const registry = target as PlaybackWindow & {
		__fckCensorLocal?: typeof api;
	};
	registry.__fckCensorLocal = api;
	return {
		...api,
		dispose() {
			disposed = true;
			dialog?.remove();
			target.document.removeEventListener("click", click, true);
			for (const track of tracks.values())
				target.URL.revokeObjectURL(track.url);
			tracks.clear();
			void database.then(
				(db) => db.close(),
				() => {},
			);
			if (registry.__fckCensorLocal === api)
				delete registry.__fckCensorLocal;
		},
	};
}
