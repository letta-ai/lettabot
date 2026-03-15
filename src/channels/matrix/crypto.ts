/**
 * Matrix E2EE Crypto Utilities
 *
 * Handles initialization and management of Matrix end-to-end encryption.
 * Uses rust crypto (v28) via initRustCrypto() for Node.js.
 *
 * Based on the Python bridge approach:
 * - Uses bootstrapSecretStorage with recovery key
 * - Uses bootstrapCrossSigning for cross-signing setup
 * - Sets trust to allow unverified devices (TOFU model)
 */

import { createLogger } from "../../logger.js";
import * as sdk from "matrix-js-sdk";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto/recoverykey.js";

const log = createLogger('MatrixCrypto');

interface CryptoConfig {
	enableEncryption: boolean;
	recoveryKey?: string;
	storeDir: string;
	password?: string;
	userId?: string;
}

/**
 * Get crypto callbacks for the Matrix client
 * These are needed for secret storage operations
 */
export function getCryptoCallbacks(recoveryKey?: string): sdk.ICryptoCallbacks {
	return {
		getSecretStorageKey: async (
			{ keys }: { keys: Record<string, any> },
			name: string,
		): Promise<[string, Uint8Array] | null> => {
			if (!recoveryKey) {
				log.info("[MatrixCrypto] No recovery key provided, cannot retrieve secret storage key");
				return null;
			}

			// Get the key ID from the keys object
			// The SDK passes { keys: { [keyId]: keyInfo } }, and we need to return one we have
			const keyIds = Object.keys(keys);
			if (keyIds.length === 0) {
				log.info("[MatrixCrypto] No secret storage key IDs requested");
				return null;
			}

			// Use the first available key ID
			const keyId = keyIds[0];
			log.info(`[MatrixCrypto] Providing secret storage key for keyId: ${keyId}, name: ${name}`);

			// Convert recovery key to Uint8Array
			// Recovery key uses Matrix's special format with prefix, parity byte, etc.
			try {
				const keyBytes = decodeRecoveryKey(recoveryKey);
				log.info(`[MatrixCrypto] Decoded recovery key, length: ${keyBytes.length} bytes`);
				return [keyId, keyBytes];
			} catch (err) {
				log.error("[MatrixCrypto] Failed to decode recovery key:", err);
				return null;
			}
		},
		// Cache the key to avoid prompting multiple times
		cacheSecretStorageKey: (keyId: string, _keyInfo: any, key: Uint8Array): void => {
			log.info(`[MatrixCrypto] Cached secret storage key: ${keyId}`);
		},
	};
}

/**
 * Initialize E2EE for a Matrix client using rust crypto
 *
 * This follows the Python bridge pattern:
 * 1. Initialize rust crypto
 * 2. Bootstrap secret storage with recovery key
 * 3. Bootstrap cross-signing
 * 4. Set trust settings for TOFU (Trust On First Use)
 */
export async function initE2EE(
	client: sdk.MatrixClient,
	config: CryptoConfig,
): Promise<void> {
	if (!config.enableEncryption) {
		log.info("[MatrixCrypto] Encryption disabled");
		return;
	}

	log.info("[MatrixCrypto] E2EE enabled");

	try {
		// useIndexedDB: false — ephemeral crypto mode.
		// Rust WASM crypto triggers TransactionInactiveError with IndexedDB persistence.
		// Upstream issue: matrix-org/matrix-rust-sdk-crypto-wasm#195
		// Workaround: fresh device on every restart, cross-signing auto-verifies.
		log.info("[MatrixCrypto] Initializing rust crypto (ephemeral mode)...");

		await client.initRustCrypto({ useIndexedDB: false });

		const crypto = client.getCrypto();
		if (!crypto) {
			throw new Error("Crypto not initialized after initRustCrypto");
		}

		log.info("[MatrixCrypto] Rust crypto initialized");

		// CRITICAL: Trigger outgoing request loop to upload device keys
		// Without this, the device shows as "doesn't support encryption"
		log.info("[MatrixCrypto] Triggering key upload...");
		(crypto as any).outgoingRequestLoop();
		// Give it a moment to process
		await new Promise(resolve => setTimeout(resolve, 2000));
		log.info("[MatrixCrypto] Key upload triggered");

		// Force a device key query to get the list of devices for this user
		// This is needed to verify signatures on the key backup
		if (config.userId) {
			log.info("[MatrixCrypto] Fetching device list...");
			try {
				await crypto.getUserDeviceInfo([config.userId]);
				// Wait a bit for the key query to complete - this is async in the background
				await new Promise((resolve) => setTimeout(resolve, 2000));
				log.info("[MatrixCrypto] Device list fetched");
			} catch (err) {
				log.warn("[MatrixCrypto] Failed to fetch device list:", err);
			}
		}

		// Import backup decryption key from recovery key
		// The recovery key IS the backup decryption key - when decoded it gives us
		// the raw private key needed to decrypt keys from server-side backup
		if (config.recoveryKey) {
			log.info("[MatrixCrypto] Importing backup decryption key from recovery key...");
			try {
				const backupKey = decodeRecoveryKey(config.recoveryKey);
				await crypto.storeSessionBackupPrivateKey(backupKey);
				log.info("[MatrixCrypto] Backup decryption key stored successfully");
			} catch (err) {
				log.warn("[MatrixCrypto] Failed to store backup key:", err);
			}

			log.info("[MatrixCrypto] Bootstrapping secret storage...");
			try {
				await crypto.bootstrapSecretStorage({});
				log.info("[MatrixCrypto] Secret storage bootstrapped");
			} catch (err) {
				log.warn("[MatrixCrypto] Secret storage bootstrap failed (may already exist):", err);
			}

			// Bootstrap cross-signing - this will READ existing keys from secret storage
			// DO NOT use setupNewCrossSigning: true as that would create new keys
			log.info("[MatrixCrypto] Bootstrapping cross-signing...");
			try {
				await crypto.bootstrapCrossSigning({
					// Only read existing keys from secret storage, don't create new ones
					// This preserves the user's existing cross-signing identity
					authUploadDeviceSigningKeys: async (makeRequest: any) => {
						log.info("[MatrixCrypto] Uploading cross-signing keys with auth...");
						// Try with password auth if available
						if (config.password && config.userId) {
							await makeRequest({
								type: "m.login.password",
								user: config.userId,
								password: config.password,
							});
							return;
						}
						await makeRequest({});
						return;
					},
				});
				log.info("[MatrixCrypto] Cross-signing bootstrapped");
			} catch (err) {
				log.warn("[MatrixCrypto] Cross-signing bootstrap failed:", err);
			}
		}

		// Enable trusting cross-signed devices (similar to Python's TrustState.UNVERIFIED)
		// This allows the bot to receive encrypted messages without interactive verification
		crypto.setTrustCrossSignedDevices(true);

		// CRITICAL: Disable global blacklist of unverified devices
		// This is the TypeScript equivalent of Python's allow_key_share
		// When false, the bot will:
		// 1. Encrypt messages for unverified devices
		// 2. Accept room key requests from unverified devices
		crypto.globalBlacklistUnverifiedDevices = false;
		log.info("[MatrixCrypto] Trusting cross-signed devices enabled");
		log.info("[MatrixCrypto] Unverified devices globally enabled (auto-key-share equivalent)");

		log.info("[MatrixCrypto] Crypto initialization complete");
		log.info("[MatrixCrypto] NOTE: Key backup check will run after first sync when device list is populated");
	} catch (err) {
		log.error("[MatrixCrypto] Failed to initialize crypto:", err);
		throw err;
	}
}

/**
 * Mark all devices for a user as verified (TOFU - Trust On First Use)
 * This is called after sync completes to trust devices we've seen
 */
/**
 * Check and enable key backup after sync completes
 * This must be called AFTER the initial sync so device list is populated
 */
export async function checkAndRestoreKeyBackup(
	client: sdk.MatrixClient,
	recoveryKey?: string,
): Promise<void> {
	const crypto = client.getCrypto();
	if (!crypto || !recoveryKey) return;

	log.info("[MatrixCrypto] Checking key backup after sync...");
	try {
		const backupInfo = await crypto.checkKeyBackupAndEnable();
		if (backupInfo) {
			log.info("[MatrixCrypto] Key backup enabled");
			// Check if backup exists before trying to restore
			try {
				// Verify backup version exists on server
				await client.getKeyBackupVersion();
				log.info("[MatrixCrypto] Backup version exists on server");

				// Restore keys from backup
				log.info("[MatrixCrypto] Restoring keys from backup...");
				const backupKey = decodeRecoveryKey(recoveryKey);
				const restoreResult = await (client as any).restoreKeyBackup(
					backupKey,
					undefined, // all rooms
					undefined, // all sessions
					backupInfo.backupInfo,
				);
				log.info(`[MatrixCrypto] Restored ${restoreResult.imported} keys from backup`);
			} catch (backupErr: any) {
				if (backupErr.errcode === 'M_NOT_FOUND' || backupErr.httpStatus === 404) {
					log.info("[MatrixCrypto] Key backup not found on server, skipping restore");
					// Don't treat this as an error - the backup may not exist yet
				} else {
					log.warn("[MatrixCrypto] Error accessing key backup:", backupErr);
				}
			}
		} else {
			log.info("[MatrixCrypto] No trusted key backup available");
		}
	} catch (err) {
		log.warn("[MatrixCrypto] Key backup check failed:", err);
	}
}

export async function trustUserDevices(
	client: sdk.MatrixClient,
	userId: string,
): Promise<void> {
	const crypto = client.getCrypto();
	if (!crypto) return;

	try {
		log.info(`[MatrixCrypto] Trusting devices for ${userId}...`);

		// Get all devices for this user
		const devices = await crypto.getUserDeviceInfo([userId]);
		const userDevices = devices.get(userId);

		if (!userDevices || userDevices.size === 0) {
			log.info(`[MatrixCrypto] No devices found for ${userId}`);
			return;
		}

		let verifiedCount = 0;
		for (const [deviceId, deviceInfo] of Array.from(userDevices.entries())) {
			// Skip our own device
			if (deviceId === client.getDeviceId()) continue;

			// Check current verification status
			const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
			if (!status?.isVerified()) {
				log.info(`[MatrixCrypto] Marking device ${deviceId} as verified`);
				await crypto.setDeviceVerified(userId, deviceId, true);
				verifiedCount++;
			}
		}

		log.info(`[MatrixCrypto] Verified ${verifiedCount} devices for ${userId}`);
	} catch (err) {
		log.error(`[MatrixCrypto] Failed to trust devices for ${userId}:`, err);
	}
}
