import { createLogger } from '../../logger.js';
const log = createLogger('IndexedDB');
/**
 * IndexedDB Polyfill for Node.js — Persistent SQLite Backend
 *
 * Uses indexeddbshim (backed by sqlite3) to provide a REAL persistent IndexedDB
 * implementation. Crypto keys, sessions, and device state are written to SQLite
 * databases in databaseDir and survive process restarts.
 *
 * This replaces the previous fake-indexeddb (in-memory only) approach.
 * With persistence, the bot keeps the same device identity across restarts —
 * no re-verification needed after code changes.
 *
 * Storage: {databaseDir}/*.db (one SQLite file per IDB database name)
 */

import { existsSync, mkdirSync } from "node:fs";

interface PolyfillOptions {
	databaseDir: string;
}

let initialized = false;

/**
 * Initialize IndexedDB polyfill with persistent SQLite backend
 *
 * @param options.databaseDir - Directory where SQLite .db files are stored
 */
export async function initIndexedDBPolyfill(options: PolyfillOptions): Promise<void> {
	if (initialized) {
		log.info("Polyfill already initialized");
		return;
	}

	const { databaseDir } = options;

	// Ensure directory exists
	if (!existsSync(databaseDir)) {
		mkdirSync(databaseDir, { recursive: true });
	}

	try {
		// indexeddbshim v16 — SQLite-backed IndexedDB for Node.js
		// Sets global.indexedDB, global.IDBKeyRange, etc.
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore — indexeddbshim lacks type declarations
		const { default: setGlobalVars } = await import("indexeddbshim/src/node.js");

		setGlobalVars(null, {
			checkOrigin: false,          // no origin checks in Node.js
			databaseBasePath: databaseDir, // where SQLite .db files live
			deleteDatabaseFiles: false,   // preserve data across restarts
		});

		initialized = true;
		log.info(`Persistent SQLite backend initialized at ${databaseDir}`);
		log.info("Crypto state will survive process restarts");
	} catch (err) {
		log.error("Failed to initialize persistent backend:", err);
		log.warn("Falling back to fake-indexeddb (in-memory, ephemeral)");

		try {
			// @ts-expect-error - no types for auto import
			await import("fake-indexeddb/auto");
			initialized = true;
			log.info("Fallback: in-memory IndexedDB (keys lost on restart)");
		} catch (fallbackErr) {
			log.error("Fallback also failed:", fallbackErr);
		}
	}
}

/**
 * Check if IndexedDB polyfill is available
 */
export function isIndexedDBAvailable(): boolean {
	return initialized && typeof (global as any).indexedDB !== "undefined";
}
