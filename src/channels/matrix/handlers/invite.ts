import { createLogger } from '../../../logger.js';
const log = createLogger('MatrixInvite');
/**
 * Invite Handler
 *
 * Handles room membership events (invites, joins, leaves).
 */

import type * as sdk from "matrix-js-sdk";
import type { DmPolicy } from "../../../pairing/types.js";

interface InviteHandlerContext {
	client: sdk.MatrixClient;
	event: sdk.MatrixEvent;
	member: sdk.RoomMember;
	dmPolicy: DmPolicy;
	allowedUsers: string[];
	autoAccept: boolean;
	storage?: Record<string, never>; // reserved for future use
	ourUserId?: string;
}

/**
 * Handle a room membership event
 */
export async function handleMembershipEvent(ctx: InviteHandlerContext): Promise<void> {
	const { client, event, member, dmPolicy, allowedUsers, autoAccept, storage, ourUserId } = ctx;

	const membership = member.membership;
	const sender = event.getSender();

	if (!sender) return;

	switch (membership) {
		case "invite":
			await handleInvite(client, member, sender, dmPolicy, allowedUsers, autoAccept);
			break;
		case "join":
			handleJoin(member);
			break;
		case "leave":
			handleLeave(member, storage, ourUserId);
			break;
	}
}

/**
 * Handle an invite
 */
async function handleInvite(
	client: sdk.MatrixClient,
	member: sdk.RoomMember,
	sender: string,
	dmPolicy: DmPolicy,
	allowedUsers: string[],
	autoAccept: boolean,
): Promise<void> {
	log.info(`Received invite to ${member.roomId} from ${sender}`);

	if (!autoAccept) {
		log.info(`Auto-accept disabled, ignoring invite`);
		return;
	}

	// Check if we should accept based on policy
	if (dmPolicy === "allowlist") {
		const isAllowed = allowedUsers.includes(sender);
		if (!isAllowed) {
			log.info(`Rejecting invite from non-allowed user: ${sender}`);
			return;
		}
	}

	try {
		await client.joinRoom(member.roomId);
		log.info(`Joined room: ${member.roomId}`);
	} catch (err) {
		log.error(`Failed to join room: ${err}`);
	}
}

/**
 * Handle a join
 */
function handleJoin(member: sdk.RoomMember): void {
	log.info(`User ${member.userId} joined ${member.roomId}`);
}

/**
 * Handle a leave
 */
function handleLeave(
	member: sdk.RoomMember,
	_storage?: Record<string, never>,
	ourUserId?: string,
): void {
	log.info(`User ${member.userId} left ${member.roomId}`);
	if (ourUserId && member.userId === ourUserId) {
		log.info(`Our user left room ${member.roomId}`);
		// Conversation history is managed by bot.ts per-chat mode — no local cleanup needed
	}
}
