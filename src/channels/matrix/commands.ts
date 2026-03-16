/**
 * Matrix Bot Command Processor
 *
 * Handles !commands sent by allowed users in Matrix rooms.
 *
 * Matrix-specific commands (per-room state, bot-loop prevention):
 *   !commands          — list all available commands
 *   !pause             — silence bot in current room (SQLite persisted)
 *   !resume            — re-enable bot in current room
 *   !ignorebot-add @u:s — add user to global ignore list (prevents bot loops)
 *   !ignorebot-remove @u:s — remove user from ignore list
 *   !turns N           — respond to bot messages for N turns
 *   !timeout           — kill stuck heartbeat run
 *
 * Delegated to upstream bot commands (full store + session lifecycle):
 *   !reset             — delegates to /reset (clear conversation + new session)
 *   !cancel            — delegates to /cancel (abort active run)
 *   !status            — delegates to /status (agent info + conversation keys)
 *   !heartbeat         — delegates to /heartbeat (trigger) or toggle on/off locally
 *
 * Commands run AFTER access control (allowedUsers) but BEFORE the paused-room
 * check, so !resume always works even in a paused room.
 * Unrecognized !x commands fall through to Letta as normal text.
 */

import { createLogger } from "../../logger.js";
import type { MatrixStorage } from "./storage.js";
const log = createLogger('MatrixCommands');

interface CommandCallbacks {
  onHeartbeatStop?: () => void;
  onHeartbeatStart?: () => void;
  isHeartbeatEnabled?: () => boolean;
  onTimeoutHeartbeat?: () => void;
  /** Delegate to upstream bot /commands (reset, cancel, status, heartbeat, model) */
  onCommand?: (command: string, chatId?: string, args?: string) => Promise<string | null>;
}

export class MatrixCommandProcessor {
  // Per-room bot-turn counters: roomId → remaining turns
  private botTurns = new Map<string, number>();

  constructor(
    private storage: MatrixStorage,
    private callbacks: CommandCallbacks = {},
  ) {}

  /**
   * Process a !command.
   * Returns:
   *   - string  → send as reply
   *   - ''      → silent ack (no reply sent)
   *   - undefined → not a recognized command, fall through to Letta
   */
  async handleCommand(
    body: string,
    roomId: string,
    sender: string,
    _roomMeta?: { isDm: boolean; roomName: string },
  ): Promise<string | undefined> {
    const parts = body.slice(1).trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      // Matrix-specific commands (per-room state)
      case "commands":
        return this.doCommands();
      case "pause":
        return this.doPause(roomId, sender);
      case "resume":
        return this.doResume(roomId);
      case "ignorebot-add":
        return this.doBotAdd(args[0], sender);
      case "ignorebot-remove":
        return this.doBotRemove(args[0]);
      case "turns":
        return this.doTurns(args[0], roomId);
      case "timeout":
        return this.doTimeout();

      // Heartbeat: on/off toggles locally, bare !heartbeat delegates to /heartbeat (trigger)
      case "heartbeat":
        return this.doHeartbeat(args[0], roomId);

      // Delegate to upstream /commands
      case "reset":
      case "cancel":
      case "status":
      case "model":
        return await this.delegateToBot(cmd, roomId, args.join(' ') || undefined);

      default:
        return undefined;
    }
  }

  isRoomPaused(roomId: string): boolean {
    return this.storage.isRoomPaused(roomId);
  }

  isIgnoredBot(userId: string): boolean {
    return this.storage.isIgnoredBot(userId);
  }

  /**
   * Check if a bot message should be processed in this room.
   * Known bots are silenced UNLESS:
   *   - The message @mentions our userId (body contains display name or m.mentions)
   *   - !turns N is active for this room (and decrements the counter)
   */
  shouldRespondToBot(roomId: string, body: string, ourUserId: string): boolean {
    // Check @mention — body contains our display name or full user ID
    const displayName = ourUserId.match(/^@([^:]+):/)?.[1];
    if (displayName && body.toLowerCase().includes(displayName.toLowerCase())) {
      return true;
    }
    if (body.includes(ourUserId)) {
      return true;
    }

    // Check !turns counter
    const remaining = this.botTurns.get(roomId);
    if (remaining !== undefined && remaining > 0) {
      this.botTurns.set(roomId, remaining - 1);
      log.info(`[Commands] !turns: ${remaining - 1} turns remaining in ${roomId}`);
      if (remaining - 1 === 0) this.botTurns.delete(roomId);
      return true;
    }

    return false;
  }

  // ─── Delegate to upstream bot commands ──────────────────────────────────

  private async delegateToBot(
    command: string,
    roomId: string,
    args?: string,
  ): Promise<string> {
    if (!this.callbacks.onCommand) {
      return `⚠️ !${command} not available (bot command handler not wired)`;
    }
    const result = await this.callbacks.onCommand(command, roomId, args);
    return result ?? `(No response from /${command})`;
  }

  // ─── Matrix-specific command implementations ────────────────────────────

  private doCommands(): string {
    const lines = [
      "📜 **Available Commands**",
      "",
      "**Room Control**",
      "  `!pause`       — Silence bot in current room",
      "  `!resume`      — Re-enable bot in current room",
      "  `!status`      — Show agent status and conversation info",
      "",
      "**Bot Loop Prevention**",
      "  `!ignorebot-add @user:server`   — Add bot to ignore list",
      "  `!ignorebot-remove @user:server` — Remove from ignore list",
      "  `!turns N` (1-50) — Respond to bot messages for N turns",
      "",
      "**Conversation**",
      "  `!reset`       — Reset conversation for this room (fresh start)",
      "  `!cancel`      — Cancel active run",
      "  `!model [handle]` — View or change LLM model",
      "",
      "**Heartbeat**",
      "  `!heartbeat on/off` — Toggle heartbeat cron",
      "  `!heartbeat`   — Trigger heartbeat now",
      "  `!timeout`     — Kill stuck heartbeat run",
    ];
    return lines.join("\n");
  }

  private doPause(roomId: string, sender: string): string {
    this.storage.pauseRoom(roomId, sender);
    return "⏸️ Bot paused in this room. Use !resume to re-enable.";
  }

  private doResume(roomId: string): string {
    this.storage.resumeRoom(roomId);
    return "▶️ Bot resumed in this room.";
  }

  private doBotAdd(userId: string | undefined, sender: string): string {
    if (!userId?.startsWith("@")) {
      return "⚠️ Usage: !ignorebot-add @user:server";
    }
    this.storage.addIgnoredBot(userId, sender);
    return `🚫 Added ${userId} to ignore list`;
  }

  private doBotRemove(userId: string | undefined): string {
    if (!userId?.startsWith("@")) {
      return "⚠️ Usage: !ignorebot-remove @user:server";
    }
    this.storage.removeIgnoredBot(userId);
    return `✅ Removed ${userId} from ignore list`;
  }

  private async doHeartbeat(arg: string | undefined, roomId: string): Promise<string> {
    const normalized = arg?.toLowerCase();
    // !heartbeat on/off — local toggle
    if (normalized === "off" || normalized === "stop") {
      this.callbacks.onHeartbeatStop?.();
      return "⏸️ Heartbeat cron stopped";
    }
    if (normalized === "on" || normalized === "start") {
      this.callbacks.onHeartbeatStart?.();
      return "▶️ Heartbeat cron started";
    }
    // Bare !heartbeat — delegate to /heartbeat (trigger)
    return await this.delegateToBot('heartbeat', roomId);
  }

  private doTurns(arg: string | undefined, roomId: string): string {
    const n = parseInt(arg || "", 10);
    if (!n || n < 1 || n > 50) {
      const current = this.botTurns.get(roomId);
      if (current) return `🔄 ${current} bot turns remaining in this room`;
      return "⚠️ Usage: !turns N (1-50) — respond to bot messages for the next N turns";
    }
    this.botTurns.set(roomId, n);
    return `🔄 Will respond to bot messages for the next ${n} turns in this room`;
  }

  private doTimeout(): string {
    if (this.callbacks.onTimeoutHeartbeat) {
      this.callbacks.onTimeoutHeartbeat();
      return "⏹ Killing stuck heartbeat run";
    }
    return "⚠️ No heartbeat timeout handler registered";
  }
}
