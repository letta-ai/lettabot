import { createLogger } from '../../../logger.js';
const log = createLogger('MatrixReaction');
/**
 * Reaction Handler
 *
 * Handles emoji reactions on bot messages:
 * - 👍/❤️/👏/🎉 → positive feedback to Letta
 * - 👎/😢/😔/❌ → negative feedback to Letta
 * - 🎤 → regenerate TTS audio
 */
import type * as sdk from "matrix-js-sdk";
import { POSITIVE_REACTIONS, NEGATIVE_REACTIONS, SPECIAL_REACTIONS } from "../types.js";
import type { MatrixStorage } from "../storage.js";
import { Letta } from '@letta-ai/letta-client';

interface ReactionHandlerContext {
  client: sdk.MatrixClient;
  event: sdk.MatrixEvent;
  ourUserId: string;
  storage: MatrixStorage;
  sendMessage: (roomId: string, text: string) => Promise<void>;
  regenerateTTS: (text: string, roomId: string) => Promise<void>;
  // Forward non-special reactions to the Letta agent so it can see and respond to them
  forwardToLetta?: (text: string, roomId: string, sender: string) => Promise<void>;
  // Check if a ✅ reaction targets a pending image — if so, trigger the image send
  sendPendingImageToAgent?: (targetEventId: string, roomId: string, sender: string) => boolean;
}

export async function handleReactionEvent(ctx: ReactionHandlerContext): Promise<void> {
  const { event, ourUserId, storage } = ctx;
  const content = event.getContent();
  const relatesTo = content["m.relates_to"];

  if (!relatesTo || relatesTo.rel_type !== "m.annotation") return;

  const reactionKey = relatesTo.key as string;
  const targetEventId = relatesTo.event_id as string;
  const sender = event.getSender();
  const roomId = event.getRoomId();

  // Ignore reactions from the bot itself
  if (sender === ourUserId) return;

  log.info(`${reactionKey} on ${targetEventId} from ${sender}`);

  // Handle 🎤 → regenerate TTS
  if (reactionKey === SPECIAL_REACTIONS.REGENERATE_AUDIO) {
    const originalText = storage.getOriginalTextForAudio(targetEventId);
    if (originalText && roomId) {
      log.info("Regenerating TTS audio");
      await ctx.regenerateTTS(originalText, roomId);
    } else {
      log.info("No original text found for audio event");
    }
    return;
  }

  // Handle feedback reactions (👍/👎 etc.)
  if (POSITIVE_REACTIONS.has(reactionKey) || NEGATIVE_REACTIONS.has(reactionKey)) {
    const isPositive = POSITIVE_REACTIONS.has(reactionKey);
    const score = isPositive ? 1.0 : -1.0;
    const stepIds = storage.getStepIdsForEvent(targetEventId);

    if (stepIds.length > 0) {
      const agentId = process.env.LETTA_AGENT_ID;
      if (agentId) {
        const client = new Letta({ apiKey: process.env.LETTA_API_KEY || '', baseURL: process.env.LETTA_BASE_URL || 'https://api.letta.com' });
        for (const stepId of stepIds) {
          try {
            await client.steps.feedback.create(stepId, { feedback: isPositive ? 'positive' : 'negative' });
            log.info(`Feedback ${isPositive ? "+" : "-"} for step ${stepId}: sent`);
          } catch (err) {
            log.warn(`Feedback for step ${stepId} failed:`, err);
          }
        }
      }
    } else {
      log.info(`No step IDs mapped for event ${targetEventId}`);
    }
    // Feedback reactions are still forwarded to Letta so the agent is aware
  }

  // ✅ on a pending image → trigger multimodal send (Python bridge parity)
  // The pending image stays in the buffer; bot.ts will pick it up via getPendingImage(chatId)
  if (reactionKey === '✅' && ctx.sendPendingImageToAgent && sender && roomId) {
    const triggered = ctx.sendPendingImageToAgent(targetEventId, roomId, sender);
    if (triggered) {
      log.info(`✅ triggered pending image send for ${targetEventId}`);
      return; // Don't forward as a regular reaction
    }
  }

  // Forward ALL reactions (including feedback ones) to Letta so the agent can see them
  // Format matches Python bridge: "🎭 {sender} reacted with: {emoji}"
  if (ctx.forwardToLetta && sender && roomId) {
    const reactionMsg = `🎭 ${sender} reacted with: ${reactionKey}`;
    log.info(`Forwarding to Letta: ${reactionMsg}`);
    await ctx.forwardToLetta(reactionMsg, roomId, sender).catch((err) => {
      log.warn("Failed to forward reaction to Letta:", err);
    });
  }
}

export function isSpecialReaction(reaction: string): boolean {
  return Object.values(SPECIAL_REACTIONS).includes(reaction as any);
}
