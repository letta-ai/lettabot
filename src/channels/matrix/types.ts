/**
 * Matrix Adapter Types
 *
 * Shared types, constants, and interfaces for the Matrix adapter.
 */

import type { DmPolicy } from "../../pairing/types.js";

// Configuration interface (extends the base MatrixConfig from config/types.ts)
export interface MatrixAdapterConfig {
	homeserverUrl: string;
	userId: string;
	accessToken?: string;
	password?: string;
	deviceId?: string;

	// Security
	dmPolicy?: DmPolicy;
	allowedUsers?: string[];
	selfChatMode?: boolean;

	// E2EE
	enableEncryption?: boolean;
	recoveryKey?: string;
	userDeviceId?: string; // User's Element device ID for proactive verification

	// Storage
	storeDir?: string;
	sessionDir?: string;  // Alias for storeDir (used by factory)
	sessionFile?: string;

	// Features
	transcriptionEnabled?: boolean;
	sttUrl?: string;
	ttsUrl?: string;
	ttsVoice?: string;
	enableAudioResponse?: boolean;
	audioRoomFilter?: "dm_only" | "all" | "none";

	// Image handling
	imageMaxSize?: number;

	// File uploads — base directory for saving received files (aligns with shared attachmentsDir)
	// Files saved to: {attachmentsDir}/uploads/YYYY-MM/{filename}
	// Defaults to process.cwd() so agent Bash tools can access them
	attachmentsDir?: string;
	attachmentsMaxBytes?: number;
	/** @deprecated use attachmentsDir */
	uploadDir?: string;

	// Reactions
	enableReactions?: boolean;

	// Streaming edits
	streaming?: boolean;

	// Auto-join rooms on invite
	autoJoinRooms?: boolean;

	// Group batching settings
	/** Debounce interval for group room messages in seconds (default: 5s, 0 = immediate) */
	groupDebounceSec?: number;
	/** Room IDs that bypass debouncing entirely */
	instantGroups?: string[];
	/** Room IDs where bot listens but doesn't respond (observer mode) */
	listeningGroups?: string[];

	// Message prefix for bot responses
	messagePrefix?: string;

	// Storage pruning
	enableStoragePruning?: boolean;
	storageRetentionDays?: number;
	storagePruningIntervalHours?: number;
}

// Session type
export interface MatrixSession {
	userId: string;
	deviceId: string;
	accessToken: string;
	homeserver: string;
	timestamp: string;
}

// Message queue types
export interface QueueItem {
	roomId: string;
	sender: string;
	message: string;
	timestamp: number;
	type: "text" | "audio" | "image";
	imageData?: {
		data: Buffer;
		format: string;
		mimeType?: string;
	};
}

// Pending image handling
export interface PendingImage {
	eventId: string;
	roomId: string;
	imageData: Buffer;
	format: string;
	mimeType?: string;
	timestamp: number;
	message?: string;
}

// Reaction definitions
export const POSITIVE_REACTIONS = new Set([
	"👍",
	":thumbsup:",
	"❤️",
	":heart:",
	"✅",
	":white_check_mark:",
	"👏",
	":clap:",
	"🎉",
	":tada:",
	"🌟",
	":star:",
]);

export const NEGATIVE_REACTIONS = new Set([
	"👎",
	":thumbsdown:",
	"😢",
	":cry:",
	"😔",
	":pensive:",
	"❌",
	":x:",
	"❎",
	":negative_squared_cross_mark:",
	"😕",
	":confused:",
]);

export const SPECIAL_REACTIONS = {
	REGENERATE_AUDIO: "🎤",
	SEND_PENDING_IMAGE: "✅",
} as const;

// Color constants (Matrix extensions)
export const MATRIX_COLORS = {
	RED: "#FF0000",
	GREEN: "#00FF00",
	BLUE: "#0000FF",
	HOT_PINK: "#FF1493",
	PURPLE: "#800080",
	ORANGE: "#FFA500",
	YELLOW: "#FFFF00",
	CYAN: "#00FFFF",
	WHITE: "#FFFFFF",
	BLACK: "#000000",
	GREY: "#808080",
} as const;

// HTML formatting constants
export const MATRIX_HTML_FORMAT = "org.matrix.custom.html";

// Default values
export const DEFAULTS = {
	TTS_VOICE: "en-Soother_woman",
	AUDIO_ROOM_FILTER: "dm_only" as const,
	IMAGE_MAX_SIZE: 2000,
	ENABLE_REACTIONS: true,
	ENABLE_ENCRYPTION: true,
};

// Event content types (inline definitions since SDK doesn't export them in v40+)
export interface ReactionEventContent {
	"m.relates_to": {
		rel_type: string;
		event_id: string;
		key: string;
	};
}

export interface RoomMessageEventContent {
	msgtype: string;
	body: string;
	format?: string;
	formatted_body?: string;
	url?: string;
	info?: {
		mimetype?: string;
		size?: number;
		w?: number;
		h?: number;
	};
}
