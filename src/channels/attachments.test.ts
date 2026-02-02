import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from './attachments.js';

describe('sanitizeFilename', () => {
  it('preserves safe filenames', () => {
    expect(sanitizeFilename('photo.jpg')).toBe('photo.jpg');
    expect(sanitizeFilename('my-file_123.png')).toBe('my-file_123.png');
  });

  it('replaces unsafe characters with underscores', () => {
    expect(sanitizeFilename('my file.jpg')).toBe('my_file.jpg');
    expect(sanitizeFilename('file (1).jpg')).toBe('file__1_.jpg');
    expect(sanitizeFilename('file<>:"/\\|?*.jpg')).toBe('file_________.jpg');
  });

  it('strips leading/trailing underscores', () => {
    expect(sanitizeFilename('___file___')).toBe('file');
    expect(sanitizeFilename('  file  ')).toBe('file');
  });

  it('returns "attachment" for empty input', () => {
    expect(sanitizeFilename('')).toBe('attachment');
    expect(sanitizeFilename('   ')).toBe('attachment');
    expect(sanitizeFilename('___')).toBe('attachment');
  });

  it('handles path traversal attempts', () => {
    const result = sanitizeFilename('../../../etc/passwd');
    // Note: dots are allowed, so '..' becomes '.._' - but slashes are stripped
    // Path traversal is prevented by buildAttachmentPath using join() on sanitized components
    expect(result).not.toContain('/');
    expect(result).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('handles unicode characters', () => {
    const result = sanitizeFilename('photo_日本語.jpg');
    expect(result).not.toContain('日');
    expect(result).toContain('photo_');
    expect(result).toContain('.jpg');
  });
});
