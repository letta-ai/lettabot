import { createLogger } from '../../logger.js';
const log = createLogger('MatrixQueue');
/**
 * Message Queue
 *
 * Handles message queuing for busy states with size limiting and retry logic.
 */

import type { QueueItem } from "./types.js";

interface QueueConfig {
	maxSize?: number;
	processIntervalMs?: number;
}

type QueueProcessor = (item: QueueItem) => Promise<void>;

export class MessageQueue {
	private queue: QueueItem[] = [];
	private maxSize: number;
	private processIntervalMs: number;
	private processor: QueueProcessor | null = null;
	private intervalId: NodeJS.Timeout | null = null;
	private processing = false;

	constructor(config: QueueConfig = {}) {
		this.maxSize = config.maxSize ?? 100;
		this.processIntervalMs = config.processIntervalMs ?? 1000;
	}

	/**
	 * Add item to queue
	 */
	enqueue(item: QueueItem): boolean {
		if (this.queue.length >= this.maxSize) {
			log.warn("Queue full, dropping message");
			return false;
		}

		this.queue.push(item);
		log.info(`Enqueued message from ${item.sender} (queue size: ${this.queue.length})`);
		return true;
	}

	/**
	 * Start processing queue
	 */
	startProcessing(processor: QueueProcessor): void {
		if (this.intervalId) {
			return; // Already running
		}

		this.processor = processor;
		this.intervalId = setInterval(() => {
			this.processNext();
		}, this.processIntervalMs);

		log.info("Started processing");
	}

	/**
	 * Stop processing queue
	 */
	stopProcessing(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.processor = null;
		log.info("Stopped processing");
	}

	/**
	 * Process next item in queue
	 */
	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0 || !this.processor) {
			return;
		}

		this.processing = true;
		const item = this.queue.shift();

		if (item) {
			try {
				await this.processor(item);
			} catch (err) {
				log.error("Failed to process item:", err);
				// Could re-enqueue here if needed
			}
		}

		this.processing = false;
	}

	/**
	 * Get current queue size
	 */
	getSize(): number {
		return this.queue.length;
	}

	/**
	 * Clear all items from queue
	 */
	clear(): void {
		this.queue = [];
		log.info("Cleared all items");
	}

	/**
	 * Check if queue is full
	 */
	isFull(): boolean {
		return this.queue.length >= this.maxSize;
	}

	/**
	 * Check if queue is empty
	 */
	isEmpty(): boolean {
		return this.queue.length === 0;
	}
}
