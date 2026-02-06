import { describe, expect, it } from 'vitest';
import { formatMessageEnvelope, SYSTEM_REMINDER_OPEN, SYSTEM_REMINDER_CLOSE } from './formatter.js';
import type { InboundMessage } from './types.js';

// Helper to create base message
function createMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'telegram',
    chatId: '123456789',
    userId: 'user123',
    text: 'Hello world',
    timestamp: new Date('2026-02-02T12:00:00Z'),
    ...overrides,
  };
}

describe('formatMessageEnvelope', () => {
  describe('XML tag structure', () => {
    it('wraps metadata in system-reminder tags', () => {
      const msg = createMessage();
      const result = formatMessageEnvelope(msg);
      expect(result).toContain(SYSTEM_REMINDER_OPEN);
      expect(result).toContain(SYSTEM_REMINDER_CLOSE);
    });

    it('places user message text outside the tags', () => {
      const msg = createMessage({ text: 'Test message' });
      const result = formatMessageEnvelope(msg);
      const closeIdx = result.indexOf(SYSTEM_REMINDER_CLOSE);
      const textIdx = result.indexOf('Test message');
      expect(textIdx).toBeGreaterThan(closeIdx);
    });

    it('has Message Metadata section', () => {
      const msg = createMessage();
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('## Message Metadata');
    });

    it('has Chat Context section', () => {
      const msg = createMessage();
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('## Chat Context');
    });
  });

  describe('basic envelope metadata', () => {
    it('includes channel name (capitalized)', () => {
      const msg = createMessage({ channel: 'telegram', chatId: '123' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Channel**: Telegram');
    });

    it('includes chatId', () => {
      const msg = createMessage({ chatId: '123' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Chat ID**: 123');
    });

    it('includes messageId when present', () => {
      const msg = createMessage({ messageId: 'msg456' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Message ID**: msg456');
    });

    it('omits messageId when not present', () => {
      const msg = createMessage({ messageId: undefined });
      const result = formatMessageEnvelope(msg);
      expect(result).not.toContain('**Message ID**');
    });

    it('includes message text after closing tag', () => {
      const msg = createMessage({ text: 'Test message' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('Test message');
      // Verify it's after the closing tag
      const parts = result.split(SYSTEM_REMINDER_CLOSE);
      expect(parts[1]).toContain('Test message');
    });
  });

  describe('sender formatting', () => {
    it('uses userName when available', () => {
      const msg = createMessage({ userName: 'John Doe' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Sender**: John Doe');
    });

    it('formats Slack users with @ prefix', () => {
      const msg = createMessage({ 
        channel: 'slack', 
        userName: undefined,
        userHandle: 'cameron' 
      });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Sender**: @cameron');
    });

    it('formats Discord users with @ prefix', () => {
      const msg = createMessage({ 
        channel: 'discord', 
        userName: undefined,
        userHandle: 'user#1234' 
      });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Sender**: @user#1234');
    });

    it('formats US phone numbers nicely for WhatsApp', () => {
      const msg = createMessage({ 
        channel: 'whatsapp', 
        userName: undefined,
        userId: '+15551234567' 
      });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('+1 (555) 123-4567');
    });

    it('formats 10-digit phone numbers as US', () => {
      const msg = createMessage({ 
        channel: 'whatsapp', 
        userName: undefined,
        userId: '5551234567' 
      });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('+1 (555) 123-4567');
    });
  });

  describe('chat context', () => {
    it('marks DMs as direct message', () => {
      const msg = createMessage({ isGroup: false });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Type**: Direct message');
    });

    it('marks groups as group chat', () => {
      const msg = createMessage({ isGroup: true });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Type**: Group chat');
    });

    it('includes group name for group chats', () => {
      const msg = createMessage({ 
        isGroup: true, 
        groupName: 'Test Group' 
      });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Group**: Test Group');
    });

    it('adds # prefix for Slack channels', () => {
      const msg = createMessage({ 
        channel: 'slack',
        isGroup: true, 
        groupName: 'general' 
      });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Group**: #general');
    });

    it('adds # prefix for Discord channels', () => {
      const msg = createMessage({ 
        channel: 'discord',
        isGroup: true, 
        groupName: 'chat' 
      });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Group**: #chat');
    });

    it('omits group info for DMs', () => {
      const msg = createMessage({ isGroup: false });
      const result = formatMessageEnvelope(msg);
      expect(result).not.toContain('**Group**');
    });

    it('includes mentioned flag when bot is mentioned', () => {
      const msg = createMessage({ isGroup: true, wasMentioned: true });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Mentioned**: yes');
    });

    it('includes no-reply hint for group chats', () => {
      const msg = createMessage({ isGroup: true });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('<no-reply/>');
    });

    it('omits no-reply hint for DMs', () => {
      const msg = createMessage({ isGroup: false });
      const result = formatMessageEnvelope(msg);
      expect(result).not.toContain('no-reply');
    });
  });

  describe('format hints', () => {
    it('includes Slack format hint', () => {
      const msg = createMessage({ channel: 'slack' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Format support**: mrkdwn:');
    });

    it('includes Telegram format hint', () => {
      const msg = createMessage({ channel: 'telegram' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Format support**: MarkdownV2:');
    });

    it('includes WhatsApp format hint', () => {
      const msg = createMessage({ channel: 'whatsapp' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Format support**:');
      expect(result).toContain('NO: headers');
    });

    it('includes Signal format hint', () => {
      const msg = createMessage({ channel: 'signal' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Format support**: ONLY:');
    });
  });

  describe('attachments', () => {
    it('includes attachment info', () => {
      const msg = createMessage({
        attachments: [{
          id: 'att1',
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: 1024,
        }]
      });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Attachments**');
      expect(result).toContain('photo.jpg');
      expect(result).toContain('image/jpeg');
    });

    it('formats file sizes correctly', () => {
      const msg = createMessage({
        attachments: [
          { id: '1', name: 'small.txt', size: 500 },
          { id: '2', name: 'medium.txt', size: 2048 },
          { id: '3', name: 'large.txt', size: 1048576 },
        ]
      });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('500 B');
      expect(result).toContain('2.0 KB');
      expect(result).toContain('1.0 MB');
    });

    it('includes local path when available', () => {
      const msg = createMessage({
        attachments: [{
          id: 'att1',
          name: 'doc.pdf',
          localPath: '/tmp/lettabot/attachments/doc.pdf',
        }]
      });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('saved to /tmp/lettabot/attachments/doc.pdf');
    });
  });

  describe('options', () => {
    it('respects includeSender: false', () => {
      const msg = createMessage({ userName: 'John' });
      const result = formatMessageEnvelope(msg, { includeSender: false });
      expect(result).not.toContain('**Sender**');
    });

    it('respects includeGroup: false', () => {
      const msg = createMessage({ isGroup: true, groupName: 'TestGroup' });
      const result = formatMessageEnvelope(msg, { includeGroup: false });
      expect(result).not.toContain('**Group**: TestGroup');
    });

    it('respects includeDay: false', () => {
      const msg = createMessage();
      const result = formatMessageEnvelope(msg, { includeDay: false });
      // Should not include day of week
      expect(result).not.toMatch(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/);
    });
  });

  describe('reactions', () => {
    it('includes reaction metadata when present', () => {
      const msg = createMessage({
        messageId: '1710000000.000000',
        reaction: {
          emoji: ':thumbsup:',
          messageId: '1710000000.000000',
          action: 'added',
        },
      });

      const result = formatMessageEnvelope(msg);
      expect(result).toContain('**Reaction**: added :thumbsup: on message 1710000000.000000');
    });

    it('omits reaction metadata when not present', () => {
      const result = formatMessageEnvelope(createMessage());
      expect(result).not.toContain('**Reaction**');
    });
  });

  describe('session context', () => {
    it('includes session context section when provided', () => {
      const msg = createMessage();
      const result = formatMessageEnvelope(msg, {}, {
        agentId: 'agent-abc123',
        agentName: 'lettabot',
        serverUrl: 'https://api.letta.com',
      });
      expect(result).toContain('## Session Context');
      expect(result).toContain('**Agent**: lettabot (agent-abc123)');
      expect(result).toContain('**Server**: https://api.letta.com');
    });

    it('omits session context section when not provided', () => {
      const msg = createMessage();
      const result = formatMessageEnvelope(msg);
      expect(result).not.toContain('## Session Context');
    });

    it('session context appears before message metadata', () => {
      const msg = createMessage();
      const result = formatMessageEnvelope(msg, {}, {
        agentName: 'lettabot',
      });
      const sessionIdx = result.indexOf('## Session Context');
      const metadataIdx = result.indexOf('## Message Metadata');
      expect(sessionIdx).toBeLessThan(metadataIdx);
    });
  });
});
