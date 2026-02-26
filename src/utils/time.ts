/**
 * Shared timing helpers used across startup and persistence paths.
 */

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
let warnedAboutBusyWait = false;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sleepSync(ms: number, onBusyWait?: () => void): void {
  if (typeof Atomics.wait === 'function') {
    Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
    return;
  }
  if (!warnedAboutBusyWait) {
    onBusyWait?.();
    warnedAboutBusyWait = true;
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy-wait fallback -- should not be reached in standard Node.js (v8+)
  }
}
