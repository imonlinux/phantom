/**
 * Talk 24 file-share fetching via the phantom service account (WebDAV).
 *
 * Composer uploads land in the conversation folder (/Talk/<name>-<token>)
 * which Talk shares to the room as a folder-level share. A service account
 * that is a room participant sees the folder in its own WebDAV tree, with
 * one subfolder per sharer (<display name>-<user id>). This module resolves
 * that path and downloads the file. The bot webhook payload only carries
 * the bare file name, so the folder walk is how we find the bytes.
 */
import { Buffer } from "node:buffer";

export interface TalkFileParams {
	name: string;
	// The webhook carries size as a string; parsed here for guard checks
	size?: number;
	mimetype?: string;
	// Public share URL (https://server/s/<token>) — download fallback
	link?: string;
}

/**
 * Extract the file parameter from a parsed Note content "parameters" object.
 * Returns null when the payload is not a file share (parameters.file missing
 * or malformed), which is the common case for every other message type.
 */
export function extractTalkFileParams(parameters: unknown): TalkFileParams | null {
	if (!parameters || typeof parameters !== "object") return null;
	const file = (parameters as Record<string, unknown>).file;
	if (!file || typeof file !== "object") return null;
	const record = file as Record<string, unknown>;
	if (typeof record.name !== "string" || record.name.length === 0) return null;

	const sizeRaw = typeof record.size === "string" ? Number.parseInt(record.size, 10) : Number.NaN;
	return {
		name: record.name,
		size: Number.isNaN(sizeRaw) ? undefined : sizeRaw,
		mimetype: typeof record.mimetype === "string" ? record.mimetype : undefined,
		link: typeof record.link === "string" && record.link.startsWith("http") ? record.link : undefined,
	};
}

export const MAX_TALK_FILE_BYTES = 50 * 1024 * 1024;

export type TalkFileResult = { ok: true; buffer: Buffer } | { ok: false; error: string };

export interface TalkFetcherCredentials {
	talkServer: string;
	userId: string;
	appPassword: string;
}

/** Strip the attendee-type prefix Talk puts on actor ids ("users/james" -> "james"). */
export function rawNcUserId(actorId: string): string {
	return actorId.startsWith("users/") ? actorId.slice("users/".length) : actorId;
}

function encodeSegments(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

export class TalkFileFetcher {
	private creds: TalkFetcherCredentials;
	// Folder names are stable per room/sharer; cache the two-step PROPFIND
	// walk so each file costs one GET in the common case.
	private convFolderCache = new Map<string, string>();
	private sharerFolderCache = new Map<string, string>();

	constructor(creds: TalkFetcherCredentials) {
		const talkServer = creds.talkServer
			.trim()
			.replace(/^https?:\/\//, "")
			.replace(/\/$/, "");
		this.creds = { ...creds, talkServer };
	}

	private authHeader(): string {
		return `Basic ${Buffer.from(`${this.creds.userId}:${this.creds.appPassword}`).toString("base64")}`;
	}

	private davBase(): string {
		return `https://${this.creds.talkServer}/remote.php/dav/files/${encodeURIComponent(this.creds.userId)}`;
	}

	/**
	 * Download a file shared into the conversation. Primary path is the
	 * service account's WebDAV tree; falls back to the public share link
	 * when WebDAV resolution fails (folder not mounted, renamed room, etc).
	 */
	async fetchSharedFile(roomToken: string, actorId: string, file: TalkFileParams): Promise<TalkFileResult> {
		if (file.size !== undefined && file.size > MAX_TALK_FILE_BYTES) {
			return { ok: false, error: `file exceeds ${Math.floor(MAX_TALK_FILE_BYTES / (1024 * 1024))} MB limit` };
		}

		const viaDav = await this.fetchViaDav(roomToken, actorId, file.name);
		if (viaDav.ok) return viaDav;

		if (file.link) {
			const viaLink = await this.fetchViaPublicLink(file.link);
			if (viaLink.ok) return viaLink;
			return { ok: false, error: `WebDAV: ${viaDav.error}; public link: ${viaLink.error}` };
		}
		return { ok: false, error: viaDav.error };
	}

	private async fetchViaDav(roomToken: string, actorId: string, fileName: string): Promise<TalkFileResult> {
		let convFolder = this.convFolderCache.get(roomToken);
		if (!convFolder) {
			const resolved = await this.resolveConvFolder(roomToken);
			if (!resolved.ok) return resolved;
			convFolder = resolved.folder;
			this.convFolderCache.set(roomToken, convFolder);
		}

		const sharerKey = `${roomToken}|${actorId}`;
		let sharerFolder = this.sharerFolderCache.get(sharerKey);
		if (!sharerFolder) {
			const resolved = await this.resolveSharerFolder(convFolder, actorId);
			if (!resolved.ok) return resolved;
			sharerFolder = resolved.folder;
			this.sharerFolderCache.set(sharerKey, sharerFolder);
		}

		const url = `${this.davBase()}/${encodeSegments(`Talk/${convFolder}/${sharerFolder}/${fileName}`)}`;
		let res = await fetch(url, { headers: { Authorization: this.authHeader() } });

		// Room or sharer folder renamed since caching: walk again once
		if (res.status === 404) {
			this.convFolderCache.delete(roomToken);
			this.sharerFolderCache.delete(sharerKey);
			const convRetry = await this.resolveConvFolder(roomToken);
			if (!convRetry.ok) return convRetry;
			const sharerRetry = await this.resolveSharerFolder(convRetry.folder, actorId);
			if (!sharerRetry.ok) return sharerRetry;
			this.convFolderCache.set(roomToken, convRetry.folder);
			this.sharerFolderCache.set(sharerKey, sharerRetry.folder);
			const retryUrl = `${this.davBase()}/${encodeSegments(`Talk/${convRetry.folder}/${sharerRetry.folder}/${fileName}`)}`;
			res = await fetch(retryUrl, { headers: { Authorization: this.authHeader() } });
		}

		if (!res.ok) {
			return { ok: false, error: `GET ${res.status}` };
		}
		try {
			const buffer = Buffer.from(await res.arrayBuffer());
			return { ok: true, buffer };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, error: `download failed: ${msg}` };
		}
	}

	private async fetchViaPublicLink(link: string): Promise<TalkFileResult> {
		try {
			const res = await fetch(`${link.replace(/\/$/, "")}/download`);
			if (!res.ok) return { ok: false, error: `GET ${res.status}` };
			const buffer = Buffer.from(await res.arrayBuffer());
			return { ok: true, buffer };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, error: msg };
		}
	}

	private async propfindFolderNames(
		url: string,
	): Promise<{ ok: true; names: string[] } | { ok: false; error: string }> {
		let res: Response;
		try {
			res = await fetch(url, {
				method: "PROPFIND",
				headers: {
					Authorization: this.authHeader(),
					Depth: "1",
					"Content-Type": "application/xml",
				},
				body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, error: `PROPFIND failed: ${msg}` };
		}
		if (res.status !== 207) {
			return { ok: false, error: `PROPFIND ${res.status}` };
		}
		const xml = await res.text();
		const names: string[] = [];
		const re = /<d:href>([^<]+)<\/d:href>/g;
		for (const match of xml.matchAll(re)) {
			const decoded = decodeURIComponent(match[1]);
			const base = decoded.replace(/\/$/, "").split("/").pop() ?? "";
			if (base) names.push(base);
		}
		return { ok: true, names };
	}

	private async resolveConvFolder(
		roomToken: string,
	): Promise<{ ok: true; folder: string } | { ok: false; error: string }> {
		const listing = await this.propfindFolderNames(`${this.davBase()}/Talk`);
		if (!listing.ok) return listing;
		// Conversation folders are named "<display name>-<room token>"
		const folder = listing.names.find((n) => n.endsWith(`-${roomToken}`));
		if (!folder) {
			return {
				ok: false,
				error: `no conversation folder for token ${roomToken} (is the service account a room participant?)`,
			};
		}
		return { ok: true, folder };
	}

	private async resolveSharerFolder(
		convFolder: string,
		actorId: string,
	): Promise<{ ok: true; folder: string } | { ok: false; error: string }> {
		const listing = await this.propfindFolderNames(`${this.davBase()}/${encodeSegments(`Talk/${convFolder}`)}`);
		if (!listing.ok) return listing;
		// Sharer subfolders are named "<display name>-<user id>"
		const rawId = rawNcUserId(actorId);
		const folder = listing.names.find((n) => n.endsWith(`-${rawId}`));
		if (!folder) {
			return { ok: false, error: `no sharer folder for ${rawId} in conversation folder` };
		}
		return { ok: true, folder };
	}
}
