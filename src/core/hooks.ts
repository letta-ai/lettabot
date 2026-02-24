import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SendMessage } from '@letta-ai/letta-code-sdk';
import type { HookHandlerConfig, MessageHookContext } from './types.js';

type HookModule = {
  preMessage?: (ctx: MessageHookContext) => Promise<unknown> | unknown;
  postReasoning?: (ctx: MessageHookContext) => Promise<unknown> | unknown;
  postMessage?: (ctx: MessageHookContext) => Promise<unknown> | unknown;
};

const DEFAULT_HOOK_MODE: HookHandlerConfig['mode'] = 'await';
// Default timeout for await-mode hooks. Prevents a hanging hook from blocking
// the message pipeline indefinitely. Set timeoutMs: 0 in config to disable.
const DEFAULT_AWAIT_TIMEOUT_MS = 5000;

function isSendMessage(value: unknown): value is SendMessage {
  return typeof value === 'string' || Array.isArray(value);
}

function extractSendMessage(result: unknown): SendMessage | undefined {
  if (!result) return undefined;
  if (isSendMessage(result)) return result;
  if (typeof result === 'object' && result !== null && 'message' in result) {
    const msg = (result as { message?: unknown }).message;
    if (isSendMessage(msg)) return msg;
  }
  return undefined;
}

function extractResponseText(result: unknown): string | undefined {
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && result !== null && 'response' in result) {
    const value = (result as { response?: unknown }).response;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

export class MessageHookRunner {
  private moduleCache = new Map<string, HookModule>();
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private resolveFile(file: string): string {
    return isAbsolute(file) ? file : resolve(this.baseDir, file);
  }

  private async loadModule(file: string): Promise<HookModule | null> {
    const resolved = this.resolveFile(file);
    const cached = this.moduleCache.get(resolved);
    if (cached) return cached;

    if (!existsSync(resolved)) {
      console.warn(`[Hooks] File not found: ${resolved}`);
      return null;
    }

    try {
      const mod = await import(pathToFileURL(resolved).href);
      const hookModule = mod as HookModule;
      this.moduleCache.set(resolved, hookModule);
      return hookModule;
    } catch (err) {
      console.warn(`[Hooks] Failed to load ${resolved}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  private async invokeWithTimeout<T>(
    task: Promise<T> | T,
    timeoutMs?: number,
  ): Promise<T> {
    const ms = timeoutMs ?? 0;
    if (!Number.isFinite(ms) || ms <= 0) {
      return await task;
    }

    let timeoutId: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        Promise.resolve(task),
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Hook timed out after ${ms}ms`));
          }, ms);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private async invokeHook(
    stage: 'preMessage' | 'postReasoning' | 'postMessage',
    config: HookHandlerConfig,
    ctx: MessageHookContext,
    effectiveTimeoutMs?: number,
  ): Promise<unknown> {
    const module = await this.loadModule(config.file);
    if (!module || typeof module[stage] !== 'function') {
      return undefined;
    }

    try {
      return await this.invokeWithTimeout(module[stage]!(ctx), effectiveTimeoutMs);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[Hooks] ${stage} failed: ${detail}`);
      return undefined;
    }
  }

  async runPre(config: HookHandlerConfig | undefined, ctx: MessageHookContext): Promise<SendMessage | undefined> {
    if (!config) return undefined;
    const mode = config.mode ?? DEFAULT_HOOK_MODE;
    if (mode === 'parallel') {
      void this.invokeHook('preMessage', config, ctx);
      return undefined;
    }
    // Apply default timeout for await mode to prevent pipeline stalls
    const timeoutMs = config.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
    const result = await this.invokeHook('preMessage', config, ctx, timeoutMs);
    return extractSendMessage(result);
  }

  async runPostReasoning(config: HookHandlerConfig | undefined, ctx: MessageHookContext): Promise<void> {
    if (!config) return;
    const mode = config.mode ?? DEFAULT_HOOK_MODE;
    if (mode === 'parallel') {
      void this.invokeHook('postReasoning', config, ctx);
      return;
    }
    const timeoutMs = config.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
    await this.invokeHook('postReasoning', config, ctx, timeoutMs);
  }

  async runPost(config: HookHandlerConfig | undefined, ctx: MessageHookContext): Promise<string | undefined> {
    if (!config) return undefined;
    const mode = config.mode ?? DEFAULT_HOOK_MODE;
    if (mode === 'parallel') {
      void this.invokeHook('postMessage', config, ctx);
      return undefined;
    }
    const timeoutMs = config.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
    const result = await this.invokeHook('postMessage', config, ctx, timeoutMs);
    return extractResponseText(result);
  }
}
