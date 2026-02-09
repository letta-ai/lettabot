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

export interface PollingConfig {
  intervalMs: number;  // Polling interval in milliseconds
  workingDir: string;  // For persisting state
  gmail?: {
    enabled: boolean;
    account: string;
  };
}

export class PollingService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private bot: AgentSession;
  private config: PollingConfig;
  
  // Track seen email IDs to detect new emails (persisted to disk)
  private seenEmailIds: Set<string> = new Set();
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
        this.seenEmailIds = new Set(data.ids || []);
        console.log(`[Polling] Loaded ${this.seenEmailIds.size} seen email IDs`);
      }
    } catch (e) {
      console.error('[Polling] Failed to load seen emails:', e);
    }
  }
  
  /**
   * Save seen email IDs to disk
   */
  private saveSeenEmails(): void {
    try {
      writeFileSync(this.seenEmailsPath, JSON.stringify({
        ids: Array.from(this.seenEmailIds),
        updatedAt: new Date().toISOString(),
      }, null, 2));
    } catch (e) {
      console.error('[Polling] Failed to save seen emails:', e);
    }
  }
  
  /**
   * Start the polling service
   */
  start(): void {
    if (this.intervalId) {
      console.log('[Polling] Already running');
      return;
    }
    
    const enabledPollers: string[] = [];
    if (this.config.gmail?.enabled) enabledPollers.push('Gmail');
    
    if (enabledPollers.length === 0) {
      console.log('[Polling] No pollers enabled');
      return;
    }
    
    console.log(`[Polling] Starting (every ${this.config.intervalMs / 1000}s): ${enabledPollers.join(', ')}`);
    
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
      console.log('[Polling] Stopped');
    }
  }
  
  /**
   * Run all enabled pollers
   */
  private async poll(): Promise<void> {
    if (this.config.gmail?.enabled) {
      await this.pollGmail();
    }
  }
  
  /**
   * Poll Gmail for new unread messages
   */
  private async pollGmail(): Promise<void> {
    const account = this.config.gmail?.account;
    if (!account) return;
    
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
        console.log(`[Polling] 📧 Gmail check failed: ${result.stderr || 'unknown error'}`);
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
          if (!this.seenEmailIds.has(id)) {
            newEmails.push(line);
          }
        }
      }
      
      // Add new IDs to seen set (don't replace - we want to remember all seen emails)
      for (const id of currentEmailIds) {
        this.seenEmailIds.add(id);
      }
      this.saveSeenEmails();
      
      // Only notify if there are NEW emails we haven't seen before
      if (newEmails.length === 0) {
        console.log(`[Polling] 📧 No new emails (${currentEmailIds.size} unread total)`);
        return;
      }
      
      console.log(`[Polling] 📧 Found ${newEmails.length} NEW email(s)!`);
      
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
        `[email] ${newEmails.length} new unread email(s):`,
        '',
        newEmailsOutput,
        '',
        'Review and summarize important emails. Use `lettabot-message send --text "..."` to notify the user if needed.',
      ].join('\n');
      
      const response = await this.bot.sendToAgent(message);
      
      // Log response but do NOT auto-deliver (silent mode)
      console.log(`[Polling] 📧 Agent finished (SILENT MODE)`);
      console.log(`  - Response: ${response?.slice(0, 100)}${(response?.length || 0) > 100 ? '...' : ''}`);
      console.log(`  - (Response NOT auto-delivered - agent uses lettabot-message CLI)`)
    } catch (e) {
      console.error('[Polling] 📧 Gmail error:', e);
    }
  }
}
