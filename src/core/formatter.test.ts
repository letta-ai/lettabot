import { describe, expect, it } from 'vitest';
import { formatMessageEnvelope } from './formatter.js';
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
  describe('basic envelope structure', () => {
    it('includes channel and chatId', () => {
      const msg = createMessage({ channel: 'telegram', chatId: '123' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('[telegram:123');
    });

    it('includes messageId when present', () => {
      const msg = createMessage({ messageId: 'msg456' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('msg:msg456');
    });

    it('omits messageId when not present', () => {
      const msg = createMessage({ messageId: undefined });
      const result = formatMessageEnvelope(msg);
      expect(result).not.toContain('msg:');
    });

    it('includes message text after envelope', () => {
      const msg = createMessage({ text: 'Test message' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('] Test message');
    });
  });

  describe('sender formatting', () => {
    it('uses userName when available', () => {
      const msg = createMessage({ userName: 'John Doe' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('John Doe');
    });

    it('formats Slack users with @ prefix', () => {
      const msg = createMessage({ 
        channel: 'slack', 
        userName: undefined,
        userHandle: 'cameron' 
      });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('@cameron');
    });

    it('formats Discord users with @ prefix', () => {
      const msg = createMessage({ 
        channel: 'discord', 
        userName: undefined,
        userHandle: 'user#1234' 
      });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('@user#1234');
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

  describe('group formatting', () => {
    it('includes group name for group chats', () => {
      const msg = createMessage({ 
        isGroup: true, 
        groupName: 'Test Group' 
      });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('Test Group');
    });

    it('adds # prefix for Slack channels', () => {
      const msg = createMessage({ 
        channel: 'slack',
        isGroup: true, 
        groupName: 'general' 
      });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('#general');
    });

    it('adds # prefix for Discord channels', () => {
      const msg = createMessage({ 
        channel: 'discord',
        isGroup: true, 
        groupName: 'chat' 
      });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('#chat');
    });

    it('omits group name for DMs', () => {
      const msg = createMessage({ isGroup: false });
      const result = formatMessageEnvelope(msg);
      expect(result).not.toContain('#');
    });
  });

  describe('format hints', () => {
    it('includes Slack format hint', () => {
      const msg = createMessage({ channel: 'slack' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('(Format: mrkdwn:');
    });

    it('includes Telegram format hint', () => {
      const msg = createMessage({ channel: 'telegram' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('(Format: MarkdownV2:');
    });

    it('includes WhatsApp format hint', () => {
      const msg = createMessage({ channel: 'whatsapp' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('(Format:');
      expect(result).toContain('NO: headers');
    });

    it('includes Signal format hint', () => {
      const msg = createMessage({ channel: 'signal' });
      const result = formatMessageEnvelope(msg);
      expect(result).toContain('(Format: ONLY:');
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
      expect(result).toContain('Attachments:');
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
      expect(result).not.toContain('John');
    });

    it('respects includeGroup: false', () => {
      const msg = createMessage({ isGroup: true, groupName: 'TestGroup' });
      const result = formatMessageEnvelope(msg, { includeGroup: false });
      expect(result).not.toContain('TestGroup');
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
      expect(result).toContain('Reaction: added :thumbsup: (msg:1710000000.000000)');
    });

    it('omits reaction metadata when not present', () => {
      const result = formatMessageEnvelope(createMessage());
      expect(result).not.toContain('Reaction:');
    });
  });
});
