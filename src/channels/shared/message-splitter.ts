/**
 * Shared message text splitting for channels with length limits.
 *
 * Splits at paragraph boundaries (double newlines), falling back
 * to single newlines, then hard-splitting at the threshold.
 */

/**
 * Split text into chunks that fit within a channel's character limit.
 *
 * @param text      - Raw text to split
 * @param threshold - Soft limit to start splitting at (leave headroom for formatting overhead)
 * @returns Array of text chunks
 */
export function splitMessageText(text: string, threshold: number): string[] {
  if (text.length <= threshold) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > threshold) {
    let splitIdx = -1;

    const searchRegion = remaining.slice(0, threshold);

    // Try paragraph boundary (double newline)
    const lastParagraph = searchRegion.lastIndexOf('\n\n');
    if (lastParagraph > threshold * 0.3) {
      splitIdx = lastParagraph;
    }

    // Fall back to single newline
    if (splitIdx === -1) {
      const lastNewline = searchRegion.lastIndexOf('\n');
      if (lastNewline > threshold * 0.3) {
        splitIdx = lastNewline;
      }
    }

    // Hard split as last resort
    if (splitIdx === -1) {
      splitIdx = threshold;
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.trim()) {
    chunks.push(remaining.trim());
  }

  return chunks;
}

/**
 * Split already-formatted text at an absolute character limit.
 * Used as a safety net when formatting expands text beyond the limit.
 *
 * @param text      - Formatted text to split
 * @param maxLength - Hard character limit
 * @returns Array of text chunks
 */
export function splitFormattedText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const searchRegion = remaining.slice(0, maxLength);
    let splitIdx = searchRegion.lastIndexOf('\n');
    if (splitIdx < maxLength * 0.3) {
      // No good newline found - hard split
      splitIdx = maxLength;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}
