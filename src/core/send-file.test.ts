import { describe, it, expect } from 'vitest';
import { inferFileKind, isPathAllowed } from './bot.js';

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

  it('is case insensitive', () => {
    expect(inferFileKind('/tmp/PHOTO.PNG')).toBe('image');
    expect(inferFileKind('/tmp/photo.JPG')).toBe('image');
    expect(inferFileKind('/tmp/photo.Jpeg')).toBe('image');
  });

  it('returns file for extensionless paths', () => {
    expect(inferFileKind('/tmp/noext')).toBe('file');
  });
});

describe('isPathAllowed', () => {
  it('allows files inside the allowed directory', () => {
    expect(isPathAllowed('/home/bot/data/report.pdf', '/home/bot/data')).toBe(true);
  });

  it('allows files in nested subdirectories', () => {
    expect(isPathAllowed('/home/bot/data/sub/deep/file.txt', '/home/bot/data')).toBe(true);
  });

  it('blocks files outside the allowed directory', () => {
    expect(isPathAllowed('/etc/passwd', '/home/bot/data')).toBe(false);
    expect(isPathAllowed('/home/bot/.env', '/home/bot/data')).toBe(false);
  });

  it('blocks path traversal attempts', () => {
    expect(isPathAllowed('/home/bot/data/../.env', '/home/bot/data')).toBe(false);
    expect(isPathAllowed('/home/bot/data/../../etc/passwd', '/home/bot/data')).toBe(false);
  });

  it('allows the directory itself', () => {
    expect(isPathAllowed('/home/bot/data', '/home/bot/data')).toBe(true);
  });

  it('blocks sibling directories with similar prefixes', () => {
    // /home/bot/data-evil should NOT be allowed when allowedDir is /home/bot/data
    expect(isPathAllowed('/home/bot/data-evil/secret.txt', '/home/bot/data')).toBe(false);
  });

  it('handles trailing slashes in allowed directory', () => {
    expect(isPathAllowed('/home/bot/data/file.txt', '/home/bot/data/')).toBe(true);
  });
});
