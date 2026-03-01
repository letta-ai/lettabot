import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SendMessage } from '@letta-ai/letta-code-sdk';
import type { HookHandlerConfig, MessageHookContext, ToolCallHookContext, ToolResultHookContext } from './types.js';

type HookModule = {
  preMessage?: (ctx: MessageHookContext) => Promise<unknown> | unknown;
  postReasoning?: (ctx: MessageHookContext) => Promise<unknown> | unknown;
  postMessage?: (ctx: MessageHookContext) => Promise<unknown> | unknown;
  postToolCall?: (ctx: ToolCallHookContext) => Promise<unknown> | unknown;
  postToolResult?: (ctx: ToolResultHookContext) => Promise<unknown> | unknown;
};

export type PreHookResult = {
  skip?: boolean;
  message?: SendMessage;
};

const DEFAULT_HOOK_MODE: HookHandlerConfig['mode'] = 'await';
// Default timeout for await-mode hooks. Prevents a hanging hook from blocking
// the message pipeline indefinitely. Set timeoutMs: 0 in config to disable.
const DEFAULT_AWAIT_TIMEOUT_MS = 5000;

function normalizeConfigs(config: HookHandlerConfig | HookHandlerConfig[] | undefined): HookHandlerConfig[] {
  if (!config) return [];
  return Array.isArray(config) ? config : [config];
}

function isSendMessage(value: unknown): value is SendMessage {
  return typeof value === 'string' || (Array.isArray(value) && value.every(item => typeof item === 'object' && item !== null));
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

  /**
   * Run preMessage hooks in order, chaining message overrides.
   * Each hook receives the (possibly modified) message from the previous hook.
   * Hooks with mode:'parallel' are fire-and-forget and do not affect the chain.
   * If any await-mode hook returns `{ skip: true }`, processing stops immediately.
   */
  async runPre(config: HookHandlerConfig | HookHandlerConfig[] | undefined, ctx: MessageHookContext): Promise<PreHookResult> {
    const configs = normalizeConfigs(config);
    let current: SendMessage | undefined;
    for (const cfg of configs) {
      const mode = cfg.mode ?? DEFAULT_HOOK_MODE;
      const hookCtx = current !== undefined ? { ...ctx, message: current } : ctx;
      const timeoutMs = cfg.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
      if (mode === 'parallel') {
        void this.invokeHook('preMessage', cfg, hookCtx, timeoutMs);
        continue;
      }
      const result = await this.invokeHook('preMessage', cfg, hookCtx, timeoutMs);
      if (result && typeof result === 'object' && !Array.isArray(result) && (result as Record<string, unknown>).skip === true) {
        return { skip: true };
      }
      const extracted = extractSendMessage(result);
      if (extracted !== undefined) current = extracted;
    }
    return current !== undefined ? { message: current } : {};
  }

  /**
   * Run postMessage hooks in order, chaining response overrides.
   * Each hook receives the (possibly modified) response from the previous hook.
   * Hooks with mode:'parallel' are fire-and-forget and do not affect the chain.
   */
  async runPost(config: HookHandlerConfig | HookHandlerConfig[] | undefined, ctx: MessageHookContext): Promise<string | undefined> {
    const configs = normalizeConfigs(config);
    let current: string | undefined;
    for (const cfg of configs) {
      const mode = cfg.mode ?? DEFAULT_HOOK_MODE;
      const hookCtx = current !== undefined ? { ...ctx, response: current } : ctx;
      const timeoutMs = cfg.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
      if (mode === 'parallel') {
        void this.invokeHook('postMessage', cfg, hookCtx, timeoutMs);
        continue;
      }
      const result = await this.invokeHook('postMessage', cfg, hookCtx, timeoutMs);
      const extracted = extractResponseText(result);
      if (extracted !== undefined) current = extracted;
    }
    return current;
  }

  async runPostReasoning(config: HookHandlerConfig | HookHandlerConfig[] | undefined, ctx: MessageHookContext): Promise<void> {
    for (const cfg of normalizeConfigs(config)) {
      const timeoutMs = cfg.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
      const mode = cfg.mode ?? DEFAULT_HOOK_MODE;
      if (mode === 'parallel') {
        void this.invokeHook('postReasoning', cfg, ctx, timeoutMs);
        continue;
      }
      await this.invokeHook('postReasoning', cfg, ctx, timeoutMs);
    }
  }

  private async invokeToolHook<Ctx>(
    stageName: string,
    fn: (ctx: Ctx) => Promise<unknown> | unknown,
    ctx: Ctx,
    cfg: HookHandlerConfig,
  ): Promise<void> {
    const mode = cfg.mode ?? DEFAULT_HOOK_MODE;
    const timeoutMs = cfg.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
    const task = fn(ctx);
    if (mode === 'parallel') {
      void this.invokeWithTimeout(task, timeoutMs);
      return;
    }
    try {
      await this.invokeWithTimeout(task, timeoutMs);
    } catch (err) {
      console.warn(`[Hooks] ${stageName} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async runToolCall(config: HookHandlerConfig | HookHandlerConfig[] | undefined, ctx: ToolCallHookContext): Promise<void> {
    for (const cfg of normalizeConfigs(config)) {
      const module = await this.loadModule(cfg.file);
      if (!module || typeof module.postToolCall !== 'function') continue;
      await this.invokeToolHook('postToolCall', module.postToolCall.bind(module), ctx, cfg);
    }
  }

  async runToolResult(config: HookHandlerConfig | HookHandlerConfig[] | undefined, ctx: ToolResultHookContext): Promise<void> {
    for (const cfg of normalizeConfigs(config)) {
      const module = await this.loadModule(cfg.file);
      if (!module || typeof module.postToolResult !== 'function') continue;
      await this.invokeToolHook('postToolResult', module.postToolResult.bind(module), ctx, cfg);
    }
  }
}
