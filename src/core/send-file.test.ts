import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { inferFileKind, isPathAllowed, LettaBot } from './bot.js';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('inferFileKind', () => {
  it('returns image for common image extensions', () => {
    expect(inferFileKind('/tmp/photo.png')).toBe('image');
    expect(inferFileKind('/tmp/photo.jpg')).toBe('image');
    expect(inferFileKind('/tmp/photo.jpeg')).toBe('image');
    expect(inferFileKind('/tmp/photo.gif')).toBe('image');
    expect(inferFileKind('/tmp/photo.webp')).toBe('image');
    expect(inferFileKind('/tmp/photo.bmp')).toBe('image');
    expect(inferFileKind('/tmp/photo.tiff')).toBe('image');
  });

  it('returns file for non-image extensions', () => {
    expect(inferFileKind('/tmp/report.pdf')).toBe('file');
    expect(inferFileKind('/tmp/data.csv')).toBe('file');
    expect(inferFileKind('/tmp/document.docx')).toBe('file');
    expect(inferFileKind('/tmp/archive.zip')).toBe('file');
    expect(inferFileKind('/tmp/script.ts')).toBe('file');
  });

  it('returns audio for common audio extensions', () => {
    expect(inferFileKind('/tmp/voice.ogg')).toBe('audio');
    expect(inferFileKind('/tmp/voice.opus')).toBe('audio');
    expect(inferFileKind('/tmp/voice.mp3')).toBe('audio');
    expect(inferFileKind('/tmp/voice.m4a')).toBe('audio');
    expect(inferFileKind('/tmp/voice.wav')).toBe('audio');
    expect(inferFileKind('/tmp/voice.aac')).toBe('audio');
    expect(inferFileKind('/tmp/voice.flac')).toBe('audio');
  });

  it('is case insensitive', () => {
    expect(inferFileKind('/tmp/PHOTO.PNG')).toBe('image');
    expect(inferFileKind('/tmp/photo.JPG')).toBe('image');
    expect(inferFileKind('/tmp/photo.Jpeg')).toBe('image');
    expect(inferFileKind('/tmp/VOICE.OGG')).toBe('audio');
  });

  it('returns file for extensionless paths', () => {
    expect(inferFileKind('/tmp/noext')).toBe('file');
  });
});

describe('isPathAllowed', () => {
  // These use non-existent paths, so isPathAllowed falls back to resolve() (textual check)
  it('allows files inside the allowed directory', async () => {
    expect(await isPathAllowed('/home/bot/data/report.pdf', '/home/bot/data')).toBe(true);
  });

  it('allows files in nested subdirectories', async () => {
    expect(await isPathAllowed('/home/bot/data/sub/deep/file.txt', '/home/bot/data')).toBe(true);
  });

  it('blocks files outside the allowed directory', async () => {
    expect(await isPathAllowed('/etc/passwd', '/home/bot/data')).toBe(false);
    expect(await isPathAllowed('/home/bot/.env', '/home/bot/data')).toBe(false);
  });

  it('blocks path traversal attempts', async () => {
    expect(await isPathAllowed('/home/bot/data/../.env', '/home/bot/data')).toBe(false);
    expect(await isPathAllowed('/home/bot/data/../../etc/passwd', '/home/bot/data')).toBe(false);
  });

  it('allows the directory itself', async () => {
    expect(await isPathAllowed('/home/bot/data', '/home/bot/data')).toBe(true);
  });

  it('blocks sibling directories with similar prefixes', async () => {
    // /home/bot/data-evil should NOT be allowed when allowedDir is /home/bot/data
    expect(await isPathAllowed('/home/bot/data-evil/secret.txt', '/home/bot/data')).toBe(false);
  });

  it('handles trailing slashes in allowed directory', async () => {
    expect(await isPathAllowed('/home/bot/data/file.txt', '/home/bot/data/')).toBe(true);
  });

  // Symlink escape test: symlink inside allowed dir pointing outside
  describe('symlink handling', () => {
    const testDir = join(tmpdir(), 'lettabot-test-sendfile-' + Date.now());
    const allowedDir = join(testDir, 'allowed');
    const outsideFile = join(testDir, 'secret.txt');
    const symlinkPath = join(allowedDir, 'evil-link');

    beforeAll(() => {
      mkdirSync(allowedDir, { recursive: true });
      writeFileSync(outsideFile, 'secret content');
      symlinkSync(outsideFile, symlinkPath);
    });

    afterAll(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it('blocks symlinks that resolve outside the allowed directory', async () => {
      // The symlink is inside allowedDir textually, but resolves to outsideFile
      expect(await isPathAllowed(symlinkPath, allowedDir)).toBe(false);
    });

    it('allows real files inside the allowed directory', async () => {
      const realFile = join(allowedDir, 'legit.txt');
      writeFileSync(realFile, 'safe content');
      expect(await isPathAllowed(realFile, allowedDir)).toBe(true);
    });
  });
});

describe('send-file directive execution', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lettabot-sendfile-workdir-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function createAdapter() {
    return {
      id: 'mock',
      name: 'Mock',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => true),
      sendMessage: vi.fn(async () => ({ messageId: 'msg-1' })),
      editMessage: vi.fn(async () => {}),
      sendTypingIndicator: vi.fn(async () => {}),
      sendFile: vi.fn(async () => ({ messageId: 'file-1' })),
    };
  }

  it('resolves relative directive paths from workingDir (not process cwd)', async () => {
    const outboundDir = join(workDir, 'data', 'outbound');
    const filePath = join(outboundDir, 'report.txt');
    mkdirSync(outboundDir, { recursive: true });
    writeFileSync(filePath, 'ok');

    const bot = new LettaBot({
      workingDir: workDir,
      allowedTools: [],
    });
    const adapter = createAdapter();

    const acted = await (bot as any).executeDirectives(
      [{ type: 'send-file', path: 'data/outbound/report.txt' }],
      adapter,
      'chat-1',
    );

    expect(acted).toBe(true);
    expect(adapter.sendFile).toHaveBeenCalledTimes(1);
    expect(adapter.sendFile).toHaveBeenCalledWith(expect.objectContaining({
      filePath,
      kind: 'file',
    }));
  });

  it('resolves relative sendFileDir config from workingDir', async () => {
    const exportsDir = join(workDir, 'exports');
    const filePath = join(exportsDir, 'report.csv');
    mkdirSync(exportsDir, { recursive: true });
    writeFileSync(filePath, 'id,name\n1,test');

    const bot = new LettaBot({
      workingDir: workDir,
      allowedTools: [],
      sendFileDir: './exports',
    });
    const adapter = createAdapter();

    const acted = await (bot as any).executeDirectives(
      [{ type: 'send-file', path: 'exports/report.csv' }],
      adapter,
      'chat-1',
    );

    expect(acted).toBe(true);
    expect(adapter.sendFile).toHaveBeenCalledTimes(1);
    expect(adapter.sendFile).toHaveBeenCalledWith(expect.objectContaining({
      filePath,
      kind: 'file',
    }));
  });
});
