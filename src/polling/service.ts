/**
 * Polling Service
 * 
 * System-level background polling for integrations (Gmail, etc.)
 * Runs independently of agent cron jobs.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSession } from '../core/interfaces.js';

import { createLogger } from '../logger.js';

const log = createLogger('Polling');
/**
 * Parse Gmail accounts from a string (comma-separated) or string array.
 * Deduplicates and trims whitespace.
 */
export function parseGmailAccounts(raw?: string | string[]): string[] {
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : raw.split(',');
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
  }
  return Array.from(seen);
}

export interface PollingConfig {
  intervalMs: number;  // Polling interval in milliseconds
  workingDir: string;  // For persisting state
  gmail?: {
    enabled: boolean;
    accounts: string[];
  };
}

export class PollingService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private bot: AgentSession;
  private config: PollingConfig;
  
  // Track seen email IDs per account to detect new emails (persisted to disk)
  private seenEmailIdsByAccount: Map<string, Set<string>> = new Map();
  private seenEmailsPath: string;
  
  constructor(bot: AgentSession, config: PollingConfig) {
    this.bot = bot;
    this.config = config;
    this.seenEmailsPath = join(config.workingDir, 'seen-emails.json');
    this.loadSeenEmails();
  }
  
  /**
   * Load seen email IDs from disk
   */
  private loadSeenEmails(): void {
    try {
      if (existsSync(this.seenEmailsPath)) {
        const data = JSON.parse(readFileSync(this.seenEmailsPath, 'utf-8'));

        // New per-account format: { accounts: { "email": { ids: [...] } } }
        if (data && typeof data === 'object' && data.accounts && typeof data.accounts === 'object') {
          for (const [account, accountData] of Object.entries(data.accounts)) {
            const ids = Array.isArray((accountData as { ids?: string[] }).ids)
              ? (accountData as { ids?: string[] }).ids!
              : [];
            this.seenEmailIdsByAccount.set(account, new Set(ids));
          }
          log.info(`Loaded seen email IDs for ${this.seenEmailIdsByAccount.size} account(s)`);
          return;
        }

        // Legacy single-account format: { ids: [...] }
        if (data && Array.isArray(data.ids)) {
          const accounts = this.config.gmail?.accounts || [];
          const targetAccount = accounts[0];
          if (targetAccount) {
            this.seenEmailIdsByAccount.set(targetAccount, new Set(data.ids));
            log.info(`Migrated legacy seen emails to ${targetAccount}`);
          }
        }
      }
    } catch (e) {
      log.error('Failed to load seen emails:', e);
    }
  }
  
  /**
   * Save seen email IDs to disk
   */
  private saveSeenEmails(): void {
    try {
      const accounts: Record<string, { ids: string[]; updatedAt: string }> = {};
      const now = new Date().toISOString();
      for (const [account, ids] of this.seenEmailIdsByAccount.entries()) {
        accounts[account] = {
          ids: Array.from(ids),
          updatedAt: now,
        };
      }
      writeFileSync(this.seenEmailsPath, JSON.stringify({
        accounts,
        updatedAt: now,
      }, null, 2));
    } catch (e) {
      log.error('Failed to save seen emails:', e);
    }
  }
  
  /**
   * Start the polling service
   */
  start(): void {
    if (this.intervalId) {
      log.info('Already running');
      return;
    }
    
    const enabledPollers: string[] = [];
    if (this.config.gmail?.enabled) {
      if (this.config.gmail.accounts.length > 0) {
        enabledPollers.push(`Gmail (${this.config.gmail.accounts.length} account${this.config.gmail.accounts.length === 1 ? '' : 's'})`);
      } else {
        log.info('Gmail enabled but no accounts configured');
      }
    }
    
    if (enabledPollers.length === 0) {
      log.info('No pollers enabled');
      return;
    }
    
    log.info(`Starting (every ${this.config.intervalMs / 1000}s): ${enabledPollers.join(', ')}`);
    
    // Run immediately on start
    this.poll();
    
    // Then run on interval
    this.intervalId = setInterval(() => this.poll(), this.config.intervalMs);
  }
  
  /**
   * Stop the polling service
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      log.info('Stopped');
    }
  }
  
  /**
   * Run all enabled pollers
   */
  private async poll(): Promise<void> {
    if (this.config.gmail?.enabled) {
      for (const account of this.config.gmail.accounts) {
        await this.pollGmail(account);
      }
    }
  }
  
  /**
   * Poll Gmail for new unread messages
   */
  private async pollGmail(account: string): Promise<void> {
    if (!account) return;
    if (!this.seenEmailIdsByAccount.has(account)) {
      this.seenEmailIdsByAccount.set(account, new Set());
    }
    const seenEmailIds = this.seenEmailIdsByAccount.get(account)!;
    
    try {
      // Check for unread emails (use longer window to catch any we might have missed)
      const result = spawnSync('gog', [
        'gmail', 'search',
        'is:unread',
        '--account', account,
        '--max', '20'
      ], { 
        encoding: 'utf-8',
        timeout: 30000,
      });
      
      if (result.status !== 0) {
        log.info(`Gmail check failed for ${account}: ${result.stderr || 'unknown error'}`);
        return;
      }
      
      const output = result.stdout?.trim() || '';
      const lines = output.split('\n').filter(l => l.trim());
      
      // Parse email IDs from output (first column after header)
      // Format: ID  DATE  FROM  SUBJECT  LABELS  THREAD
      const currentEmailIds = new Set<string>();
      const newEmails: string[] = [];
      
      for (let i = 1; i < lines.length; i++) { // Skip header
        const line = lines[i];
        const id = line.split(/\s+/)[0]; // First column is ID
        if (id) {
          currentEmailIds.add(id);
          if (!seenEmailIds.has(id)) {
            newEmails.push(line);
          }
        }
      }
      
      // Add new IDs to seen set (don't replace - we want to remember all seen emails)
      for (const id of currentEmailIds) {
        seenEmailIds.add(id);
      }
      this.saveSeenEmails();
      
      // Only notify if there are NEW emails we haven't seen before
      if (newEmails.length === 0) {
        log.info(`No new emails for ${account} (${currentEmailIds.size} unread total)`);
        return;
      }
      
      log.info(`Found ${newEmails.length} NEW email(s) for ${account}!`);
      
      // Build output with header + new emails only
      const header = lines[0];
      const newEmailsOutput = [header, ...newEmails].join('\n');
      
      // Send to agent for processing (SILENT MODE - no auto-delivery)
      // Agent must use `lettabot-message` CLI to notify user
      const message = [
        '╔════════════════════════════════════════════════════════════════╗',
        '║  [SILENT MODE] - Your text output is NOT sent to anyone.       ║',
        '║  To send a message, use: lettabot-message send --text "..."    ║',
        '╚════════════════════════════════════════════════════════════════╝',
        '',
        `[email] ${newEmails.length} new unread email(s) for ${account}:`,
        '',
        newEmailsOutput,
        '',
        'Review and summarize important emails. Use `lettabot-message send --text "..."` to notify the user if needed.',
      ].join('\n');
      
      const response = await this.bot.sendToAgent(message);
      
      // Log response but do NOT auto-deliver (silent mode)
      log.info(`Agent finished (SILENT MODE)`);
      log.info(`  - Response: ${response?.slice(0, 100)}${(response?.length || 0) > 100 ? '...' : ''}`);
      log.info(`  - (Response NOT auto-delivered - agent uses lettabot-message CLI)`)
    } catch (e) {
      log.error(`Gmail error for ${account}:`, e);
    }
  }
}
