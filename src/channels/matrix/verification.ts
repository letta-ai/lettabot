/**
 * Matrix E2EE Device Verification Handler
 *
 * Handles SAS (emoji) device verification for matrix-js-sdk v28 with rust crypto.
 *
 * KEY FIXES:
 * - Event handlers MUST be set up BEFORE startClient()
 * - Use literal string event names: "show_sas", "cancel", "change"
 * - Call verifier.verify() to actually start the verification flow
 * - Accept when NOT in accepting state (!request.accepting)
 */

import { createLogger } from "../../logger.js";
import * as sdk from "matrix-js-sdk";

const log = createLogger('MatrixVerification');

interface VerificationCallbacks {
  onShowSas?: (emojis: string[]) => void;
  onComplete?: () => void;
  onCancel?: (reason: string) => void;
  onError?: (error: Error) => void;
}

interface ActiveVerification {
  userId: string;
  deviceId: string;
  verifier: sdk.Crypto.Verifier | null;
  request: sdk.Crypto.VerificationRequest;
  sasCallbacks?: sdk.Crypto.ShowSasCallbacks | null;
}

/**
 * Matrix Verification Handler for rust crypto backend
 *
 * Event flow (Matrix spec-compliant):
 * 1. m.key.verification.request (incoming)
 * 2. m.key.verification.ready (we accept)
 * 3. m.key.verification.start (SAS method)
 * 4. m.key.verification.key (exchange keys)
 * 5. SAS computed - we call confirm()
 * 6. m.key.verification.mac (send MAC)
 * 7. m.key.verification.done
 *
 * CRITICAL: setupEventHandlers() MUST be called BEFORE client.startClient()
 */
export class MatrixVerificationHandler {
  private client: sdk.MatrixClient;
  private activeVerifications = new Map<string, ActiveVerification>();
  private callbacks: VerificationCallbacks;

  constructor(client: sdk.MatrixClient, callbacks: VerificationCallbacks = {}) {
    this.client = client;
    this.callbacks = callbacks;
  }

  /**
   * CRITICAL: Call this BEFORE client.startClient()
   */
  setupEventHandlers(): void {
    // Log all verification to-device messages for debugging
    this.client.on(sdk.ClientEvent.ToDeviceEvent, (event: sdk.MatrixEvent) => {
      const type = event.getType();
      if (type.startsWith("m.key.verification")) {
        log.info(`[MatrixVerification] To-device: ${type} from ${event.getSender()}`, event.getContent());
      }
    });

    // Listen for verification requests from rust crypto
    // This is the PRIMARY event for incoming verification requests
    this.client.on(sdk.CryptoEvent.VerificationRequestReceived, (request: sdk.Crypto.VerificationRequest) => {
      log.info(`[MatrixVerification] VerificationRequestReceived: ${request.otherUserId}:${request.otherDeviceId}, phase=${this.phaseName(request.phase)}`);
      this.handleVerificationRequest(request);
    });

    // Listen for device verification status changes
    this.client.on(sdk.CryptoEvent.DevicesUpdated, (userIds: string[]) => {
      log.info(`[MatrixVerification] Devices updated: ${userIds.join(", ")}`);
    });

    log.info("[MatrixVerification] Event handlers configured (ready BEFORE startClient())");
  }

  private phaseName(phase: sdk.Crypto.VerificationPhase): string {
    const phases = ["Unsent", "Requested", "Ready", "Started", "Cancelled", "Done"];
    return phases[phase - 1] || `Unknown(${phase})`;
  }

  private handleVerificationRequest(request: sdk.Crypto.VerificationRequest): void {
    const otherUserId = request.otherUserId;
    const otherDeviceId = request.otherDeviceId || "unknown";
    const key = `${otherUserId}|${otherDeviceId}`;

    // Check if already handling - but allow new requests if the old one is cancelled/timed out
    const existing = this.activeVerifications.get(key);
    if (existing) {
      // If existing request is in a terminal state, clear it and proceed
      if (existing.request.phase === sdk.Crypto.VerificationPhase.Cancelled ||
          existing.request.phase === sdk.Crypto.VerificationPhase.Done) {
        log.info(`[MatrixVerification] Clearing stale verification: ${otherUserId}:${otherDeviceId}`);
        this.activeVerifications.delete(key);
      } else if (request.phase === sdk.Crypto.VerificationPhase.Requested) {
        // New request coming in while old one pending - replace it
        log.info(`[MatrixVerification] Replacing stale verification: ${otherUserId}:${otherDeviceId}`);
        this.activeVerifications.delete(key);
      } else {
        log.info(`[MatrixVerification] Already handling: ${otherUserId}:${otherDeviceId}`);
        return;
      }
    }

    log.info(`[MatrixVerification] *** REQUEST from ${otherUserId}:${otherDeviceId} ***`);
    log.info(`[MatrixVerification] Phase: ${this.phaseName(request.phase)}`);

    // NOTE: request.methods throws "not implemented" for RustVerificationRequest
    // Rust crypto with SAS uses m.sas.v1 method by default

    // Store the request immediately
    this.activeVerifications.set(key, {
      userId: otherUserId,
      deviceId: otherDeviceId,
      verifier: null,
      request,
      sasCallbacks: null,
    });

    // Handle based on phase
    if (request.phase === sdk.Crypto.VerificationPhase.Requested) {
      // Automatically accept incoming requests
      this.acceptAndStartSAS(request, key);
    } else if (request.phase === sdk.Crypto.VerificationPhase.Ready) {
      // Already ready, start SAS
      this.startSASVerification(request, key);
    } else if (request.phase === sdk.Crypto.VerificationPhase.Started && request.verifier) {
      // Verification already started, attach listeners
      this.attachVerifierListeners(request.verifier, request, key);
    }
  }

  private async acceptAndStartSAS(request: sdk.Crypto.VerificationRequest, key: string): Promise<void> {
    try {
      log.info("[MatrixVerification] Accepting verification request...");
      await request.accept();
      log.info(`[MatrixVerification] Accepted, phase is now: ${this.phaseName(request.phase)}`);

      // Check if already Ready (phase might change immediately)
      if (request.phase === sdk.Crypto.VerificationPhase.Ready) {
        log.info("[MatrixVerification] Already Ready, starting SAS immediately...");
        this.startSASVerification(request, key);
        return;
      }

      // The SDK will emit a 'change' event when phase changes to Ready
      // Listen for that and then start SAS
      const onChange = () => {
        log.info(`[MatrixVerification] Phase changed to: ${this.phaseName(request.phase)}`);
        if (request.phase === sdk.Crypto.VerificationPhase.Ready) {
          log.info("[MatrixVerification] Now in Ready phase, starting SAS...");
          request.off("change" as any, onChange);
          this.startSASVerification(request, key);
        } else if (request.phase === sdk.Crypto.VerificationPhase.Done) {
          request.off("change" as any, onChange);
        }
      };
      request.on("change" as any, onChange);

      // Also check after a short delay in case event doesn't fire
      setTimeout(() => {
        if (request.phase === sdk.Crypto.VerificationPhase.Ready) {
          log.info("[MatrixVerification] Ready detected via timeout, starting SAS...");
          request.off("change" as any, onChange);
          this.startSASVerification(request, key);
        }
      }, 1000);
    } catch (err) {
      log.error("[MatrixVerification] Failed to accept:", err);
      this.callbacks.onError?.(err as Error);
    }
  }

  private async startSASVerification(request: sdk.Crypto.VerificationRequest, key: string): Promise<void> {
    try {
      log.info("[MatrixVerification] Starting SAS verification with m.sas.v1...");

      // CRITICAL: Fetch device keys for the other user BEFORE starting SAS
      // Without this, rust crypto says "device doesn't exist"
      const crypto = this.client.getCrypto();
      if (crypto && request.otherUserId) {
        log.info(`[MatrixVerification] Fetching device keys for ${request.otherUserId}...`);
        await crypto.getUserDeviceInfo([request.otherUserId], true);
        log.info("[MatrixVerification] Device keys fetched");
        // Small delay to let the crypto module process the keys
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Check if verifier already exists
      const existingVerifier = request.verifier;
      log.info(`[MatrixVerification] Verifier exists: ${!!existingVerifier}`);

      if (existingVerifier) {
        log.info("[MatrixVerification] Verifier already exists, attaching listeners...");
        this.attachVerifierListeners(existingVerifier, request, key);
        return;
      }

      log.info("[MatrixVerification] Calling request.startVerification()...");
      // Start the SAS verification
      const verifier = await request.startVerification("m.sas.v1");

      log.info(`[MatrixVerification] startVerification() returned: ${!!verifier}`);

      if (!verifier) {
        throw new Error("startVerification returned undefined");
      }

      log.info("[MatrixVerification] SAS verifier created");

      // Update stored verification
      const stored = this.activeVerifications.get(key);
      if (stored) {
        stored.verifier = verifier;
      }

      // Attach listeners
      log.info("[MatrixVerification] Attaching verifier listeners...");
      this.attachVerifierListeners(verifier, request, key);

      log.info("[MatrixVerification] Calling verifier.verify()...");
      // Start the verification flow - this sends the accept message
      await verifier.verify();

      log.info("[MatrixVerification] verifier.verify() completed successfully");

    } catch (err) {
      log.error("[MatrixVerification] Error starting SAS:", err);
      this.callbacks.onError?.(err as Error);
    }
  }

  private attachVerifierListeners(verifier: sdk.Crypto.Verifier, request: sdk.Crypto.VerificationRequest, key: string): void {
    // CRITICAL: Use the literal string "show_sas", not an enum property
    verifier.on("show_sas" as any, (sas: sdk.Crypto.ShowSasCallbacks) => {
      log.info("[MatrixVerification] *** SHOW SAS (EMOJI) ***");

      if (!sas) {
        log.error("[MatrixVerification] No SAS data received!");
        return;
      }

      const sasData = verifier.getShowSasCallbacks();
      if (!sasData?.sas?.emoji) {
        log.error("[MatrixVerification] No emoji data in SAS!");
        return;
      }

      const emojis = sasData.sas.emoji.map((e: [string, string]) => `${e[0]} ${e[1]}`);
      log.info("[MatrixVerification] Emojis:", emojis.join(" | "));
      log.info("[MatrixVerification] *** COMPARE THESE EMOJIS IN ELEMENT ***");

      // Store callbacks and notify user
      const stored = this.activeVerifications.get(key);
      if (stored) {
        stored.sasCallbacks = sasData;
      }

      this.callbacks.onShowSas?.(emojis);

      // Auto-confirm after delay for bot
      setTimeout(() => {
        this.confirmVerification(key);
      }, 5000); // 5 seconds for emoji comparison
    });

    // CRITICAL: Use the literal string "cancel"
    verifier.on("cancel" as any, (err: Error | sdk.MatrixEvent) => {
      log.error("[MatrixVerification] Verification cancelled:", err);
      this.activeVerifications.delete(key);

      const reason = err instanceof Error ? err.message : "Verification cancelled";
      this.callbacks.onCancel?.(reason);
    });

    // Listen for verification request phase changes
    request.on("change" as any, () => {
      const phase = request.phase;
      log.info(`[MatrixVerification] Request phase changed: ${this.phaseName(phase)}`);

      if (phase === sdk.Crypto.VerificationPhase.Done) {
        log.info("[MatrixVerification] *** VERIFICATION DONE ***");
        this.activeVerifications.delete(key);
        this.callbacks.onComplete?.();
      } else if (phase === sdk.Crypto.VerificationPhase.Cancelled) {
        log.info("[MatrixVerification] *** VERIFICATION CANCELLED ***");
        this.activeVerifications.delete(key);
        this.callbacks.onCancel?.(request.cancellationCode || "Unknown");
      }
    });
  }

  async confirmVerification(key: string): Promise<void> {
    const stored = this.activeVerifications.get(key);
    if (!stored?.sasCallbacks) {
      log.info("[MatrixVerification] No pending verification to confirm");
      return;
    }

    log.info("[MatrixVerification] Confirming verification (sending MAC)...");
    try {
      await stored.sasCallbacks.confirm();
      log.info("[MatrixVerification] Verification confirmed (MAC sent). Waiting for Done...");
    } catch (err) {
      log.error("[MatrixVerification] Failed to confirm:", err);
      this.callbacks.onError?.(err as Error);
    }
  }

  /**
   * Request verification with a specific device (initiated by us)
   */
  async requestVerification(userId: string, deviceId: string): Promise<sdk.Crypto.VerificationRequest> {
    const crypto = this.client.getCrypto();
    if (!crypto) {
      throw new Error("Crypto not initialized");
    }

    log.info(`[MatrixVerification] Requesting verification with ${userId}:${deviceId}`);

    const request = await crypto.requestDeviceVerification(userId, deviceId);
    const key = `${userId}|${deviceId}`;

    this.activeVerifications.set(key, {
      userId,
      deviceId,
      verifier: null,
      request,
    });

    // Listen for the request to be ready, then start SAS
    const onReadyOrStarted = () => {
      const phase = request.phase;
      if (phase === sdk.Crypto.VerificationPhase.Ready) {
        log.info("[MatrixVerification] Outgoing request ready, starting SAS...");
        this.startSASVerification(request, key);
        request.off("change" as any, onReadyOrStarted);
      } else if (phase === sdk.Crypto.VerificationPhase.Started && request.verifier) {
        log.info("[MatrixVerification] Outgoing request already started, attaching listeners...");
        this.attachVerifierListeners(request.verifier, request, key);
        request.off("change" as any, onReadyOrStarted);
      }
    };
    request.on("change" as any, onReadyOrStarted);

    return request;
  }

  /**
   * Get all pending verification requests for a user
   */
  getVerificationRequests(userId: string): sdk.Crypto.VerificationRequest[] {
    const requests: sdk.Crypto.VerificationRequest[] = [];
    for (const [key, value] of Array.from(this.activeVerifications.entries())) {
      if (key.startsWith(`${userId}|`)) {
        requests.push(value.request);
      }
    }
    return requests;
  }

  dispose(): void {
    this.activeVerifications.forEach((v) => {
      try {
        // Note: EventEmitter.off() requires the specific handler reference
        // Since we used anonymous functions, we can't easily remove them
        // The map clear below will allow garbage collection anyway
      } catch (e) {
        // Ignore cleanup errors
      }
    });
    this.activeVerifications.clear();
  }
}

/**
 * Format emojis for display
 */
export function formatEmojis(emojis: unknown[]): string {
  if (!Array.isArray(emojis)) return "";

  return emojis
    .map((e) => {
      if (Array.isArray(e) && e.length >= 2) {
        return `${e[0]} ${e[1]}`;
      }
      return "";
    })
    .filter(Boolean)
    .join(" | ");
}
