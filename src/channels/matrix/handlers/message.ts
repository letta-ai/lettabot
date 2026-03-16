/**
 * Message Handler
 *
 * Handles text messages and access control for Matrix.
 */

import type * as sdk from "matrix-js-sdk";
import type { InboundMessage } from "../../../core/types.js";
import type { DmPolicy } from "../../../pairing/types.js";
import { upsertPairingRequest } from "../../../pairing/store.js";
import { checkDmAccess } from "../../shared/access-control.js";
import { formatMatrixHTML } from "../html-formatter.js";
import { createLogger } from "../../../logger.js";

const log = createLogger('MatrixMessage');

interface MessageHandlerContext {
	client: sdk.MatrixClient;
	room: sdk.Room;
	event: sdk.MatrixEvent;
	ourUserId: string;
	config: {
		selfChatMode: boolean;
		dmPolicy: DmPolicy;
		allowedUsers: string[];
	};
	sendMessage: (roomId: string, text: string) => Promise<void>;
	onCommand?: (command: string, chatId?: string, args?: string) => Promise<string | null>;
	// !commands processor — handles pause/resume/status/ignorebot-add/ignorebot-remove/heartbeat/restore/turns
	commandProcessor?: {
		handleCommand(
			body: string,
			roomId: string,
			sender: string,
			roomMeta?: { isDm: boolean; roomName: string },
		): Promise<string | undefined>;
		isRoomPaused(roomId: string): boolean;
		isIgnoredBot(userId: string): boolean;
		shouldRespondToBot(roomId: string, body: string, ourUserId: string): boolean;
	};
}

/**
 * Handle a text message event
 */
export async function handleTextMessage(
	ctx: MessageHandlerContext,
): Promise<InboundMessage | null> {
	const { client, room, event, ourUserId, config, sendMessage, onCommand } = ctx;

	const sender = event.getSender();
	const content = event.getClearContent() || event.getContent();
	const body = content.body as string;

	if (!sender || !body) return null;

	// Skip our own messages
	if (sender === ourUserId) return null;

	// Multi-bot rooms: determine observer mode for known bots
	let observeOnly = false;
	if (ctx.commandProcessor?.isIgnoredBot(sender)) {
		if (!ctx.commandProcessor.shouldRespondToBot(room.roomId, body, ourUserId)) {
			observeOnly = true; // forward to Letta for context, suppress response delivery
		}
		// else: Bot is @mentioning us or !turns is active — process normally (observeOnly stays false)
	}

	// Observer messages skip access check, commands, and paused check —
	// they go straight to Letta for context building with no side effects.
	if (!observeOnly) {
		// Check self-chat mode
		if (!config.selfChatMode && sender === ourUserId) {
			return null;
		}

		// Handle slash commands
		if (body.startsWith("/")) {
			const result = await handleCommand(body, room.roomId, onCommand);
			if (result) {
				await sendMessage(room.roomId, result);
				return null;
			}
		}

		// Check access control
		const access = await checkDmAccess('matrix', sender, config.dmPolicy, config.allowedUsers);

		if (access === "blocked") {
			await sendMessage(room.roomId, "Sorry, you're not authorized to use this bot.");
			return null;
		}

		if (access === "pairing") {
			const { code, created } = await upsertPairingRequest("matrix", sender, {
				firstName: extractDisplayName(sender),
			});

			if (!code) {
				await sendMessage(
					room.roomId,
					"Too many pending pairing requests. Please try again later.",
				);
				return null;
			}

			if (created) {
				const pairingMessage = `Hi! This bot requires pairing.

Your code: *${code}*

Ask the owner to run:
\`lettabot pairing approve matrix ${code}\`

This code expires in 1 hour.`;
				await sendMessage(room.roomId, pairingMessage);
			}
			return null;
		}

		// Handle !commands — only reachable if sender passed access check above
		if (body.startsWith("!") && ctx.commandProcessor) {
			const isDm = isDirectMessage(room);
			const roomMeta = { isDm, roomName: room.name || room.roomId };
			const reply = await ctx.commandProcessor.handleCommand(body, room.roomId, sender, roomMeta);
			if (reply !== undefined) {
				if (reply) await sendMessage(room.roomId, reply);
				return null;
			}
			// Unrecognized !command — fall through to Letta as normal text
		}

		// Drop message if room is paused (allowed users handled commands above so !resume still works)
		if (ctx.commandProcessor?.isRoomPaused(room.roomId)) return null;
	}

	// Build inbound message
	const isDm = isDirectMessage(room);
	const messageId = event.getId();
	if (!messageId) {
		log.warn(`[MatrixMessage] No messageId for event in room ${room.roomId} (${isDm ? 'DM' : 'group'}), sender=${sender}, body length=${body.length}`);
	}

	const message: InboundMessage = {
		channel: "matrix",
		chatId: room.roomId,
		userId: sender,
		userName: extractDisplayName(sender),
		userHandle: sender,
		messageId: messageId || undefined,
		text: body,
		timestamp: new Date(event.getTs()),
		isGroup: !isDm,
		groupName: isDm ? undefined : room.name,
	};

	return message;
}

/**
 * Handle a slash command
 */
async function handleCommand(
	command: string,
	chatId: string,
	onCommand?: (command: string, chatId?: string, args?: string) => Promise<string | null>,
): Promise<string | null> {
	if (!onCommand) return null;

	const parts = command.slice(1).trim().split(/\s+/);
	const cmd = parts[0];
	const args = parts.slice(1).join(' ') || undefined;
	return await onCommand(cmd, chatId, args);
}

/**
 * Check if a room is a direct message
 */
function isDirectMessage(room: sdk.Room): boolean {
	const members = room.getJoinedMembers();
	return members.length === 2;
}

/**
 * Extract display name from Matrix user ID
 */
function extractDisplayName(userId: string): string {
	// Extract from @user:server format
	const match = userId.match(/^@([^:]+):/);
	return match ? match[1] : userId;
}
