/**
 * Matrix Session Manager
 *
 * Handles persistent session storage with backup/restore functionality.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger } from "../../logger.js";
import type { MatrixSession } from "./types.js";

const log = createLogger('MatrixSession');

interface SessionManagerConfig {
	sessionFile: string;
	backupCount?: number;
}

export class MatrixSessionManager {
	private sessionFile: string;
	private backupCount: number;

	constructor(config: SessionManagerConfig) {
		this.sessionFile = config.sessionFile;
		this.backupCount = config.backupCount ?? 3;

		// Ensure directory exists
		const dir = dirname(this.sessionFile);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	/**
	 * Load session from disk
	 */
	loadSession(): MatrixSession | null {
		try {
			if (!existsSync(this.sessionFile)) {
				return null;
			}

			const data = readFileSync(this.sessionFile, "utf-8");
			const session = JSON.parse(data) as MatrixSession;

			// Validate required fields
			if (!session.userId || !session.accessToken) {
				log.warn("[MatrixSession] Invalid session data, ignoring");
				return null;
			}

			log.info(`[MatrixSession] Loaded session for ${session.userId}`);
			return session;
		} catch (err) {
			log.error("[MatrixSession] Failed to load session:", err);
			return null;
		}
	}

	/**
	 * Save session to disk with backup
	 */
	saveSession(session: MatrixSession): void {
		try {
			// Create backup of existing session
			if (existsSync(this.sessionFile)) {
				this.rotateBackups();
			}

			// Write new session atomically
			const tempFile = `${this.sessionFile}.tmp`;
			writeFileSync(tempFile, JSON.stringify(session, null, 2), { mode: 0o600 });
			renameSync(tempFile, this.sessionFile);

			log.info(`[MatrixSession] Saved session for ${session.userId}`);
		} catch (err) {
			log.error("[MatrixSession] Failed to save session:", err);
			throw err;
		}
	}

	/**
	 * Rotate backup files
	 */
	private rotateBackups(): void {
		const dir = dirname(this.sessionFile);
		const baseName = this.sessionFile.split("/").pop() || "session.json";

		// Remove oldest backup
		const oldestBackup = join(dir, `${baseName}.backup.${this.backupCount}`);
		if (existsSync(oldestBackup)) {
			unlinkSync(oldestBackup);
		}

		// Shift existing backups
		for (let i = this.backupCount - 1; i >= 1; i--) {
			const oldBackup = join(dir, `${baseName}.backup.${i}`);
			const newBackup = join(dir, `${baseName}.backup.${i + 1}`);
			if (existsSync(oldBackup)) {
				renameSync(oldBackup, newBackup);
			}
		}

		// Create new backup
		const firstBackup = join(dir, `${baseName}.backup.1`);
		renameSync(this.sessionFile, firstBackup);
	}

	/**
	 * Restore from most recent backup
	 */
	restoreFromBackup(): MatrixSession | null {
		const dir = dirname(this.sessionFile);
		const baseName = this.sessionFile.split("/").pop() || "session.json";
		const firstBackup = join(dir, `${baseName}.backup.1`);

		if (!existsSync(firstBackup)) {
			log.warn("[MatrixSession] No backup available to restore");
			return null;
		}

		try {
			const data = readFileSync(firstBackup, "utf-8");
			const session = JSON.parse(data) as MatrixSession;
			log.info(`[MatrixSession] Restored from backup for ${session.userId}`);
			return session;
		} catch (err) {
			log.error("[MatrixSession] Failed to restore from backup:", err);
			return null;
		}
	}

	/**
	 * Clear session and backups
	 */
	clearSession(): void {
		try {
			if (existsSync(this.sessionFile)) {
				unlinkSync(this.sessionFile);
			}

			const dir = dirname(this.sessionFile);
			const baseName = this.sessionFile.split("/").pop() || "session.json";

			for (let i = 1; i <= this.backupCount; i++) {
				const backup = join(dir, `${baseName}.backup.${i}`);
				if (existsSync(backup)) {
					unlinkSync(backup);
				}
			}

			log.info("[MatrixSession] Cleared all sessions");
		} catch (err) {
			log.error("[MatrixSession] Failed to clear session:", err);
		}
	}

	/**
	 * Check if session exists
	 */
	hasSession(): boolean {
		return existsSync(this.sessionFile);
	}
}
