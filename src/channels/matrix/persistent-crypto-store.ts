import { createLogger } from '../../logger.js';
const log = createLogger('CryptoStore');
/**
 * Persistent Crypto Store for Node.js
 *
 * Wraps MemoryCryptoStore and serializes to disk on changes
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface CryptoData {
  deviceKeys?: Record<string, unknown>;
  rooms?: Record<string, unknown>;
  sessions?: Record<string, unknown>;
  inboundGroupSessions?: Record<string, unknown>;
  outboundGroupSessions?: Record<string, unknown>;
  userDevices?: Record<string, unknown>;
  crossSigningInfo?: unknown;
  privateKeys?: Record<string, unknown>;
}

export class PersistentCryptoStore {
  private data: CryptoData = {};
  private filePath: string;
  private memoryStore: any;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.loadFromDisk();
    this.memoryStore = this.createMemoryStore();
  }

  private loadFromDisk(): void {
    try {
      if (existsSync(this.filePath)) {
        const content = readFileSync(this.filePath, "utf-8");
        this.data = JSON.parse(content);
        log.info(`Loaded from ${this.filePath}`);
      }
    } catch (err) {
      log.warn("Failed to load, starting fresh:", err);
      this.data = {};
    }
  }

  private saveToDisk(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      log.error("Failed to save:", err);
    }
  }

  private createMemoryStore(): any {
    // Simple memory store implementation that syncs to disk
    const store = {
      getItem: (key: string) => {
        return this.data[key as keyof CryptoData];
      },
      setItem: (key: string, value: any) => {
        (this.data as any)[key] = value;
        this.saveToDisk();
      },
      removeItem: (key: string) => {
        delete (this.data as any)[key];
        this.saveToDisk();
      },
    };
    return store;
  }

  // Implement the CryptoStore interface
  async getDeviceKeys(): Promise<Record<string, unknown> | null> {
    return this.data.deviceKeys || null;
  }

  async setDeviceKeys(keys: Record<string, unknown>): Promise<void> {
    this.data.deviceKeys = keys;
    this.saveToDisk();
  }

  async getRoom(roomId: string): Promise<unknown | null> {
    return this.data.rooms?.[roomId] || null;
  }

  async setRoom(roomId: string, data: unknown): Promise<void> {
    if (!this.data.rooms) this.data.rooms = {};
    this.data.rooms[roomId] = data;
    this.saveToDisk();
  }

  async getSession(deviceKey: string, sessionId: string): Promise<unknown | null> {
    return this.data.sessions?.[`${deviceKey}:${sessionId}`] || null;
  }

  async setSession(deviceKey: string, sessionId: string, data: unknown): Promise<void> {
    if (!this.data.sessions) this.data.sessions = {};
    this.data.sessions[`${deviceKey}:${sessionId}`] = data;
    this.saveToDisk();
  }

  async getInboundGroupSession(roomId: string, sessionId: string): Promise<unknown | null> {
    return this.data.inboundGroupSessions?.[`${roomId}:${sessionId}`] || null;
  }

  async setInboundGroupSession(roomId: string, sessionId: string, data: unknown): Promise<void> {
    if (!this.data.inboundGroupSessions) this.data.inboundGroupSessions = {};
    this.data.inboundGroupSessions[`${roomId}:${sessionId}`] = data;
    this.saveToDisk();
  }

  async getUserDevices(userId: string): Promise<Record<string, unknown> | null> {
    const devices = this.data.userDevices?.[userId] as Record<string, unknown> | undefined;
    return devices !== undefined ? devices : null;
  }

  async setUserDevices(userId: string, devices: Record<string, unknown>): Promise<void> {
    if (!this.data.userDevices) this.data.userDevices = {};
    this.data.userDevices[userId] = devices;
    this.saveToDisk();
  }

  async getCrossSigningInfo(): Promise<unknown | null> {
    return this.data.crossSigningInfo || null;
  }

  async setCrossSigningInfo(info: unknown): Promise<void> {
    this.data.crossSigningInfo = info;
    this.saveToDisk();
  }

  async getPrivateKey(keyType: string): Promise<unknown | null> {
    return this.data.privateKeys?.[keyType] || null;
  }

  async setPrivateKey(keyType: string, key: unknown): Promise<void> {
    if (!this.data.privateKeys) this.data.privateKeys = {};
    this.data.privateKeys[keyType] = key;
    this.saveToDisk();
  }
}
