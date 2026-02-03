/**
 * WhatsApp Socket Session Management
 *
 * Handles Baileys socket creation, configuration, and initial connection.
 * Based on OpenClaw's session.ts pattern.
 */

import qrcode from "qrcode-terminal";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  createCredsSaveQueue,
  maybeRestoreCredsFromBackup,
  type CredsSaveQueue,
} from "../../utils/creds-queue.js";
import type { ConnectionUpdate } from "./types.js";

// Constants
const INITIAL_CONNECT_TIMEOUT_MS = 30000; // 30 seconds
const QR_SCAN_TIMEOUT_MS = 120000; // 2 minutes
const BROWSER_INFO: [string, string, string] = ["LettaBot", "Desktop", "1.0.0"];

// Patterns to filter from console output (crypto noise from Baileys/libsignal)
const CONSOLE_FILTER_PATTERNS = [
  /closing.*session.*prekey/i,
  /closing open session/i,
  /prekey bundle/i,
  /bad mac/i,
  /session error/i,
  /sessionentry/i,
  /ratchet/i,
  /registrationid/i,
  /basekey/i,
  /remoteidentitykey/i,
];

/**
 * Install console filters to suppress Baileys crypto noise.
 * Call this once when WhatsApp channel starts.
 */
export function installConsoleFilters(): void {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  
  const shouldFilter = (...args: any[]): boolean => {
    const str = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    return CONSOLE_FILTER_PATTERNS.some(p => p.test(str));
  };
  
  console.log = (...args: any[]) => {
    if (!shouldFilter(...args)) originalLog.apply(console, args);
  };
  
  console.error = (...args: any[]) => {
    if (!shouldFilter(...args)) originalError.apply(console, args);
  };
  
  console.warn = (...args: any[]) => {
    if (!shouldFilter(...args)) originalWarn.apply(console, args);
  };
}

/**
 * Options for creating a WhatsApp socket
 */
export interface SocketOptions {
  /** Directory to store auth state */
  authDir: string;

  /** Whether to print QR code to terminal */
  printQr?: boolean;

  /** Enable verbose logging */
  verbose?: boolean;

  /** Optional QR code callback */
  onQr?: (qr: string) => void;

  /** Optional connection update callback */
  onConnectionUpdate?: (update: ConnectionUpdate) => void;

  /** Message store for getMessage callback (persists across reconnections) */
  messageStore?: Map<string, any>;
}

/**
 * Result of socket creation
 */
export interface SocketResult {
  /** Baileys socket instance */
  sock: import("@whiskeysockets/baileys").WASocket;

  /** Credentials save queue */
  credsQueue: CredsSaveQueue;

  /** Disconnect reason constants */
  DisconnectReason: typeof import("@whiskeysockets/baileys").DisconnectReason;

  /** Bot's own JID */
  myJid: string;

  /** Bot's phone number (E.164 format) */
  myNumber: string;
}

/**
 * Create a silent logger that suppresses Baileys console noise
 */
function createSilentLogger() {
  const logger = {
    level: "silent",
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => logger,
  };
  return logger;
}

/**
 * Create and configure a Baileys WhatsApp socket.
 *
 * This function:
 * 1. Restores credentials from backup if needed
 * 2. Loads auth state from disk
 * 3. Creates Baileys socket with proper configuration
 * 4. Sets up credential save queue with backup
 * 5. Waits for initial connection (with QR code support)
 * 6. Returns connected socket + helpers
 *
 * @param options - Socket configuration
 * @returns Connected socket with credentials queue
 *
 * @example
 * const result = await createWaSocket({
 *   authDir: './data/whatsapp-session',
 *   printQr: true,
 *   onQr: (qr) => console.log('QR:', qr)
 * });
 *
 * // Use the socket
 * await result.sock.sendMessage(jid, { text: 'Hello!' });
 *
 * // Queue credential saves
 * result.sock.ev.on('creds.update', () => result.credsQueue.enqueue(saveCreds));
 */
export async function createWaSocket(options: SocketOptions): Promise<SocketResult> {
  const { authDir, printQr = false, verbose = false, onQr, onConnectionUpdate } = options;

  // Ensure session directory exists
  mkdirSync(authDir, { recursive: true });

  // Restore credentials from backup if main file is corrupted
  const restored = maybeRestoreCredsFromBackup(authDir, {
    logger: {
      log: (msg) => console.log(`[WhatsApp] ${msg}`),
      warn: (msg, err) => console.warn(`[WhatsApp] ${msg}:`, err),
    },
  });

  if (restored) {
    console.log("[WhatsApp] Session recovered from backup");
  }

  // Dynamic import Baileys
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
  } = await import("@whiskeysockets/baileys");

  // Load auth state
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // Get latest WhatsApp Web version
  const { version } = await fetchLatestBaileysVersion();
  console.log("[WhatsApp] Using WA Web version:", version.join("."));

  // Create silent logger (suppress Baileys noise)
  const logger = createSilentLogger();

  // Use provided message store or create empty one
  const messageStore = options.messageStore ?? new Map<string, any>();

  // Create socket with proper configuration
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger as any),
    },
    version,
    browser: BROWSER_INFO,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    logger: logger as any,
    printQRInTerminal: false,
    // getMessage for retry capability - store is populated when we SEND messages, not here
    getMessage: async (key) => {
      if (!key.id) return undefined;
      return messageStore.get(key.id);
    },
  });

  // Handle WebSocket-level errors to prevent crashes
  if (sock.ws && typeof sock.ws.on === "function") {
    sock.ws.on("error", (err: Error) => {
      console.error("[WhatsApp] WebSocket error:", err.message);
    });
  }

  // Create credential save queue with backup
  const credsQueue = createCredsSaveQueue({
    authDir,
    logger: {
      warn: (msg, err) => console.warn(`[WhatsApp] ${msg}:`, err),
    },
  });

  // Queue credential saves on update events
  sock.ev.on("creds.update", () => credsQueue.enqueue(saveCreds));

  // Wait for initial connection
  let qrWasShown = false;

  await new Promise<void>((resolve, reject) => {
    let timeout = setTimeout(
      () => reject(new Error("Connection timeout")),
      INITIAL_CONNECT_TIMEOUT_MS
    );

    const handler = (update: Partial<import("@whiskeysockets/baileys").ConnectionState>) => {
      // Handle QR code display
      if (update.qr) {
        qrWasShown = true;

        // Extend timeout when QR is shown
        clearTimeout(timeout);
        timeout = setTimeout(
          () => reject(new Error("QR scan timeout - please try again")),
          QR_SCAN_TIMEOUT_MS
        );

        // Print QR to terminal
        if (printQr) {
          console.log("[WhatsApp] Scan this QR code in WhatsApp -> Linked Devices:");
          qrcode.generate(update.qr, { small: true });
        }

        // Notify via callback
        onQr?.(update.qr);
      }

      // Connection opened
      if (update.connection === "open") {
        clearTimeout(timeout);
        sock.ev.off("connection.update", handler);
        resolve();
      }

      // Connection closed during startup
      if (update.connection === "close") {
        clearTimeout(timeout);
        sock.ev.off("connection.update", handler);
        reject(new Error("Connection closed during startup"));
      }

      // Notify callback
      onConnectionUpdate?.(update as ConnectionUpdate);
    };

    sock.ev.on("connection.update", handler);
  });

  // Send "available" presence for better UX
  try {
    await sock.sendPresenceUpdate("available");
  } catch {
    // Ignore presence errors - not critical
  }

  // Extract bot's own JID and phone number
  const myJid = sock.user?.id || "";
  const myNumber = myJid.replace(/@.*/, "").replace(/:\d+/, "");

  console.log(`[WhatsApp] Connected as ${myNumber}`);

  return {
    sock,
    credsQueue,
    DisconnectReason,
    myJid,
    myNumber,
  };
}

/**
 * Wait for an existing socket to connect.
 *
 * @param sock - Baileys socket instance
 * @returns Promise that resolves when connected
 *
 * @example
 * const sock = makeWASocket({ ... });
 * await waitForConnection(sock);
 * console.log('Connected!');
 */
export async function waitForConnection(sock: import("@whiskeysockets/baileys").WASocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = (update: Partial<import("@whiskeysockets/baileys").ConnectionState>) => {
      if (update.connection === "open") {
        sock.ev.off("connection.update", handler);
        resolve();
      }
      if (update.connection === "close") {
        sock.ev.off("connection.update", handler);
        reject(update.lastDisconnect ?? new Error("Connection closed"));
      }
    };

    sock.ev.on("connection.update", handler);
  });
}

/**
 * Get status code from Baileys error
 */
export function getStatusCode(err: unknown): number | undefined {
  const baileys = err as BaileysError;
  return baileys?.output?.statusCode ?? baileys?.status;
}

interface BaileysError {
  output?: { statusCode?: number };
  status?: number;
}
