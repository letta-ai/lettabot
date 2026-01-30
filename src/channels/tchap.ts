/**
 * Tchap Channel Adapter
 *
 * Uses matrix-bot-sdk for Matrix/Tchap integration.
 * Tchap is the French government's messaging platform built on Matrix.
 *
 * Reference: https://aide.tchap.numerique.gouv.fr/fr/article/documentation-technique-bot-et-integrations-tchap-1z3dfx/
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { InboundMessage, OutboundMessage } from "../core/types.js";
import {
	formatPairingMessage,
	isUserAllowed,
	upsertPairingRequest,
} from "../pairing/store.js";
import type { DmPolicy } from "../pairing/types.js";
import type { ChannelAdapter } from "./types.js";

// Dynamic import types to avoid requiring Matrix deps if not used
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type MatrixClientType = import("matrix-bot-sdk").MatrixClient;

export interface TchapConfig {
	// Required
	homeserverUrl: string; // e.g., https://matrix.agent.dinum.tchap.gouv.fr
	accessToken: string; // Pre-obtained via password login

	// Storage (critical for E2EE)
	storagePath?: string; // Default: ./data/tchap
	cryptoStoragePath?: string; // Default: ./data/tchap/crypto

	// Encryption
	encryptionEnabled?: boolean; // Default: true (required for most Tchap rooms)

	// Access control
	dmPolicy?: DmPolicy; // 'pairing', 'allowlist', or 'open'
	allowedUsers?: string[]; // Matrix user IDs: @user:agent.dinum.tchap.gouv.fr

	// Behavior
	autoJoinRooms?: boolean; // Default: true
	messagePrefix?: string; // Optional prefix for bot messages (e.g., "[BOT]")
}

export class TchapAdapter implements ChannelAdapter {
	readonly id = "tchap" as const;
	readonly name = "Tchap";

	private client: MatrixClientType | null = null;
	private config: TchapConfig;
	private running = false;
	private userId: string | null = null;

	onMessage?: (msg: InboundMessage) => Promise<void>;
	onCommand?: (command: string) => Promise<string | null>;

	constructor(config: TchapConfig) {
		this.config = {
			storagePath: "./data/tchap",
			cryptoStoragePath: "./data/tchap/crypto",
			encryptionEnabled: true,
			autoJoinRooms: true,
			dmPolicy: "pairing",
			...config,
		};
	}

	async start(): Promise<void> {
		if (this.running) return;

		// Dynamic import
		const sdk = await import("matrix-bot-sdk");
		const {
			MatrixClient,
			SimpleFsStorageProvider,
			AutojoinRoomsMixin,
			RustSdkCryptoStorageProvider,
		} = sdk;

		// Ensure storage directories exist
		const storagePath = this.config.storagePath ?? "./data/tchap";
		const cryptoPath = this.config.cryptoStoragePath ?? "./data/tchap/crypto";
		mkdirSync(storagePath, { recursive: true });
		mkdirSync(cryptoPath, { recursive: true });

		// Setup storage providers
		const storage = new SimpleFsStorageProvider(join(storagePath, "bot.json"));

		// Setup crypto storage if encryption is enabled
		let cryptoStorage:
			| InstanceType<typeof RustSdkCryptoStorageProvider>
			| undefined;
		if (this.config.encryptionEnabled) {
			try {
				// RustSdkCryptoStorageProvider requires the crypto-nodejs bindings to be built
				// Import the StoreType enum from the sdk
				const { RustSdkCryptoStoreType } = sdk;
				cryptoStorage = new RustSdkCryptoStorageProvider(
					cryptoPath,
					RustSdkCryptoStoreType.Sqlite,
				);
				console.log("[Tchap] Crypto storage initialized");
			} catch (error) {
				console.warn("[Tchap] Failed to initialize crypto storage:", error);
				console.warn(
					"[Tchap] E2EE will not be available. For E2EE, run: pnpm approve-builds",
				);
			}
		}

		// Create client with optional crypto store
		this.client = new MatrixClient(
			this.config.homeserverUrl,
			this.config.accessToken,
			storage,
			cryptoStorage,
		);

		// Prepare encryption if crypto is available
		if (this.config.encryptionEnabled && cryptoStorage) {
			try {
				await this.client.crypto.prepare([]);
				console.log("[Tchap] E2EE encryption enabled");
			} catch (error) {
				console.error("[Tchap] Failed to setup encryption:", error);
				console.warn(
					"[Tchap] Continuing without E2EE support - encrypted rooms will not work!",
				);
			}
		}

		// Auto-join rooms on invite
		if (this.config.autoJoinRooms) {
			AutojoinRoomsMixin.setupOnClient(this.client);
		}

		// Get our user ID
		this.userId = await this.client.getUserId();

		// Register message handler
		this.client.on("room.message", this.handleMessage.bind(this));

		// Register decryption failure handler (for E2EE rooms)
		this.client.on(
			"room.failed_decryption",
			this.handleDecryptionFailure.bind(this),
		);

		console.log(`[Tchap] Connecting to ${this.config.homeserverUrl}...`);
		await this.client.start();
		console.log(`[Tchap] Bot started as ${this.userId}`);
		this.running = true;
	}

	private async handleMessage(
		roomId: string,
		event: Record<string, unknown>,
	): Promise<void> {
		try {
			const content = event.content as Record<string, unknown> | undefined;

			// Skip if not a text message
			if (content?.msgtype !== "m.text") return;

			// Skip our own messages
			const sender = event.sender as string;
			if (sender === this.userId) return;

			const text = (content.body as string) || "";
			const messageId = event.event_id as string;

			// Check access control
			const access = await this.checkAccess(sender);
			if (access !== "allowed") {
				if (access === "pairing") {
					const { code, created } = await upsertPairingRequest(
						"tchap",
						sender,
						{
							username: sender,
						},
					);
					if (created && code) {
						console.log(`[Tchap] New pairing request from ${sender}: ${code}`);
						await this.sendTextToRoom(roomId, formatPairingMessage(code));
					}
				} else {
					await this.sendTextToRoom(
						roomId,
						"Sorry, you're not authorized to use this bot.",
					);
				}
				return;
			}

			// Determine if this is a DM or group
			let isGroup = false;
			let groupName: string | undefined;

			try {
				if (!this.client) return;
				const members = await this.client.getJoinedRoomMembers(roomId);
				isGroup = members.length > 2;
				if (isGroup) {
					const roomState = await this.client.getRoomState(roomId);
					const nameEvent = roomState.find(
						(e: Record<string, unknown>) => e.type === "m.room.name",
					);
					groupName = (
						nameEvent?.content as Record<string, unknown> | undefined
					)?.name as string | undefined;
				}
			} catch {
				// Ignore errors getting room info
			}

			if (this.onMessage) {
				await this.onMessage({
					channel: "tchap",
					chatId: roomId,
					userId: sender,
					userName: this.extractUsername(sender),
					messageId,
					text,
					timestamp: new Date((event.origin_server_ts as number) || Date.now()),
					isGroup,
					groupName,
				});
			}
		} catch (error) {
			console.error("[Tchap] Error handling message:", error);
		}
	}

	private async handleDecryptionFailure(
		roomId: string,
		event: Record<string, unknown>,
	): Promise<void> {
		const eventId = event.event_id as string;
		console.error(`[Tchap] Failed to decrypt message ${eventId} in ${roomId}`);

		try {
			await this.sendTextToRoom(
				roomId,
				"⚠️ Failed to decrypt your message. Please ensure E2EE is properly configured.",
			);
		} catch {
			// Ignore errors sending failure notice
		}
	}

	private extractUsername(matrixId: string): string {
		// Extract username from @user:server format
		const match = matrixId.match(/^@([^:]+):/);
		return match ? match[1] : matrixId;
	}

	private async checkAccess(
		userId: string,
	): Promise<"allowed" | "blocked" | "pairing"> {
		const policy = this.config.dmPolicy || "pairing";

		if (policy === "open") return "allowed";

		const allowed = await isUserAllowed(
			"tchap",
			userId,
			this.config.allowedUsers,
		);
		if (allowed) return "allowed";

		return policy === "allowlist" ? "blocked" : "pairing";
	}

	async stop(): Promise<void> {
		if (!this.running || !this.client) return;
		this.client.stop();
		this.running = false;
		console.log("[Tchap] Bot stopped");
	}

	isRunning(): boolean {
		return this.running;
	}

	private async sendTextToRoom(roomId: string, text: string): Promise<string> {
		if (!this.client) throw new Error("Tchap not started");

		const body = this.config.messagePrefix
			? `${this.config.messagePrefix}\n\n${text}`
			: text;

		const eventId = await this.client.sendText(roomId, body);
		return eventId;
	}

	async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
		if (!this.client) throw new Error("Tchap not started");

		const text = this.config.messagePrefix
			? `${this.config.messagePrefix}\n\n${msg.text}`
			: msg.text;

		// Send as HTML for rich formatting
		// sendHtmlText takes (roomId, html) - it auto-generates plain text fallback
		const eventId = await this.client.sendHtmlText(
			msg.chatId,
			this.markdownToHtml(text),
		);

		return { messageId: eventId };
	}

	async editMessage(
		chatId: string,
		messageId: string,
		text: string,
	): Promise<void> {
		if (!this.client) throw new Error("Tchap not started");

		// Matrix uses m.replace relation for edits
		await this.client.sendEvent(chatId, "m.room.message", {
			msgtype: "m.text",
			body: `* ${text}`, // Fallback shows edit marker
			"m.new_content": {
				msgtype: "m.text",
				body: text,
				format: "org.matrix.custom.html",
				formatted_body: this.markdownToHtml(text),
			},
			"m.relates_to": {
				rel_type: "m.replace",
				event_id: messageId,
			},
		});
	}

	async sendTypingIndicator(chatId: string): Promise<void> {
		if (!this.client) throw new Error("Tchap not started");
		await this.client.setTyping(chatId, true, 5000); // 5 second timeout
	}

	supportsEditing(): boolean {
		return true; // Matrix supports message editing
	}

	private markdownToHtml(markdown: string): string {
		// Basic markdown to HTML conversion
		// For production, consider using a library like 'marked'
		return markdown
			.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
			.replace(/\*(.*?)\*/g, "<em>$1</em>")
			.replace(/`(.*?)`/g, "<code>$1</code>")
			.replace(/\n/g, "<br>");
	}
}
