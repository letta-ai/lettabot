/**
 * Telegram MTProto Text Formatting
 *
 * Converts markdown to TDLib formattedText format with proper UTF-16 entity offsets.
 *
 * CRITICAL: TDLib uses UTF-16 code units for entity offsets, not byte offsets or
 * Unicode code points. JavaScript's string.length already returns UTF-16 code units,
 * so we can use it directly. However, emoji and other characters outside the BMP
 * take 2 UTF-16 code units (surrogate pairs).
 *
 * Entity types supported:
 * - Bold: **text** or __text__
 * - Italic: *text* or _text_
 * - Code: `code`
 * - Pre: ```code block```
 * - Strikethrough: ~~text~~
 */

export interface TdlibTextEntity {
  _: 'textEntity';
  offset: number;    // UTF-16 code units from start
  length: number;    // UTF-16 code units
  type: TdlibTextEntityType;
}

export type TdlibTextEntityType =
  | { _: 'textEntityTypeBold' }
  | { _: 'textEntityTypeItalic' }
  | { _: 'textEntityTypeCode' }
  | { _: 'textEntityTypePre'; language?: string }
  | { _: 'textEntityTypeStrikethrough' }
  | { _: 'textEntityTypeUnderline' }
  | { _: 'textEntityTypeTextUrl'; url: string };

export interface TdlibFormattedText {
  _: 'formattedText';
  text: string;
  entities: TdlibTextEntity[];
}

/**
 * Calculate UTF-16 length of a string.
 * JavaScript strings are UTF-16 encoded, so string.length gives UTF-16 code units.
 */
export function utf16Length(str: string): number {
  return str.length;
}

/**
 * Convert markdown text to TDLib formattedText structure.
 * Handles bold, italic, code, pre, and strikethrough.
 */
export function markdownToTdlib(markdown: string): TdlibFormattedText {
  const entities: TdlibTextEntity[] = [];
  let plainText = '';
  let i = 0;

  while (i < markdown.length) {
    // Code block: ```language\ncode``` or ```code```
    if (markdown.slice(i, i + 3) === '```') {
      const blockStart = i;
      i += 3;

      // Check for language specifier
      let language = '';
      const langMatch = markdown.slice(i).match(/^(\w+)\n/);
      if (langMatch) {
        language = langMatch[1];
        i += langMatch[0].length;
      } else if (markdown[i] === '\n') {
        i++; // Skip newline after ```
      }

      // Find closing ```
      const closeIdx = markdown.indexOf('```', i);
      if (closeIdx !== -1) {
        const content = markdown.slice(i, closeIdx);
        const entityOffset = utf16Length(plainText);
        const entityLength = utf16Length(content);

        entities.push({
          _: 'textEntity',
          offset: entityOffset,
          length: entityLength,
          type: language
            ? { _: 'textEntityTypePre', language }
            : { _: 'textEntityTypePre' }
        });

        plainText += content;
        i = closeIdx + 3;
        continue;
      }
      // No closing ```, treat as literal
      plainText += '```';
      i = blockStart + 3;
      continue;
    }

    // Inline code: `code`
    if (markdown[i] === '`') {
      const closeIdx = markdown.indexOf('`', i + 1);
      if (closeIdx !== -1 && closeIdx > i + 1) {
        const content = markdown.slice(i + 1, closeIdx);
        const entityOffset = utf16Length(plainText);
        const entityLength = utf16Length(content);

        entities.push({
          _: 'textEntity',
          offset: entityOffset,
          length: entityLength,
          type: { _: 'textEntityTypeCode' }
        });

        plainText += content;
        i = closeIdx + 1;
        continue;
      }
    }

    // Bold: **text** (check before single *)
    if (markdown.slice(i, i + 2) === '**') {
      const closeIdx = markdown.indexOf('**', i + 2);
      if (closeIdx !== -1) {
        const content = markdown.slice(i + 2, closeIdx);
        const entityOffset = utf16Length(plainText);
        const entityLength = utf16Length(content);

        entities.push({
          _: 'textEntity',
          offset: entityOffset,
          length: entityLength,
          type: { _: 'textEntityTypeBold' }
        });

        plainText += content;
        i = closeIdx + 2;
        continue;
      }
    }

    // Bold alternate: __text__ (check before single _)
    if (markdown.slice(i, i + 2) === '__') {
      const closeIdx = markdown.indexOf('__', i + 2);
      if (closeIdx !== -1) {
        const content = markdown.slice(i + 2, closeIdx);
        const entityOffset = utf16Length(plainText);
        const entityLength = utf16Length(content);

        entities.push({
          _: 'textEntity',
          offset: entityOffset,
          length: entityLength,
          type: { _: 'textEntityTypeBold' }
        });

        plainText += content;
        i = closeIdx + 2;
        continue;
      }
    }

    // Strikethrough: ~~text~~
    if (markdown.slice(i, i + 2) === '~~') {
      const closeIdx = markdown.indexOf('~~', i + 2);
      if (closeIdx !== -1) {
        const content = markdown.slice(i + 2, closeIdx);
        const entityOffset = utf16Length(plainText);
        const entityLength = utf16Length(content);

        entities.push({
          _: 'textEntity',
          offset: entityOffset,
          length: entityLength,
          type: { _: 'textEntityTypeStrikethrough' }
        });

        plainText += content;
        i = closeIdx + 2;
        continue;
      }
    }

    // Italic: *text* (single asterisk)
    if (markdown[i] === '*' && markdown[i + 1] !== '*') {
      const closeIdx = findClosingMark(markdown, i + 1, '*');
      if (closeIdx !== -1) {
        const content = markdown.slice(i + 1, closeIdx);
        const entityOffset = utf16Length(plainText);
        const entityLength = utf16Length(content);

        entities.push({
          _: 'textEntity',
          offset: entityOffset,
          length: entityLength,
          type: { _: 'textEntityTypeItalic' }
        });

        plainText += content;
        i = closeIdx + 1;
        continue;
      }
    }

    // Italic alternate: _text_ (single underscore)
    if (markdown[i] === '_' && markdown[i + 1] !== '_') {
      const closeIdx = findClosingMark(markdown, i + 1, '_');
      if (closeIdx !== -1) {
        const content = markdown.slice(i + 1, closeIdx);
        const entityOffset = utf16Length(plainText);
        const entityLength = utf16Length(content);

        entities.push({
          _: 'textEntity',
          offset: entityOffset,
          length: entityLength,
          type: { _: 'textEntityTypeItalic' }
        });

        plainText += content;
        i = closeIdx + 1;
        continue;
      }
    }

    // Regular character - copy to output
    plainText += markdown[i];
    i++;
  }

  return {
    _: 'formattedText',
    text: plainText,
    entities
  };
}

/**
 * Find closing mark that isn't preceded by backslash and isn't part of a double mark.
 */
function findClosingMark(str: string, startIdx: number, mark: string): number {
  for (let i = startIdx; i < str.length; i++) {
    if (str[i] === mark) {
      // Check it's not escaped
      if (i > 0 && str[i - 1] === '\\') continue;
      // Check it's not part of a double mark (** or __)
      if (str[i + 1] === mark) continue;
      return i;
    }
  }
  return -1;
}

/**
 * Convert plain text to formattedText with no entities.
 */
export function plainToTdlib(text: string): TdlibFormattedText {
  return {
    _: 'formattedText',
    text,
    entities: []
  };
}

/**
 * Create a bold text entity for a portion of text.
 */
export function createBoldEntity(offset: number, length: number): TdlibTextEntity {
  return {
    _: 'textEntity',
    offset,
    length,
    type: { _: 'textEntityTypeBold' }
  };
}

/**
 * Create an italic text entity.
 */
export function createItalicEntity(offset: number, length: number): TdlibTextEntity {
  return {
    _: 'textEntity',
    offset,
    length,
    type: { _: 'textEntityTypeItalic' }
  };
}

/**
 * Create a code entity (inline code).
 */
export function createCodeEntity(offset: number, length: number): TdlibTextEntity {
  return {
    _: 'textEntity',
    offset,
    length,
    type: { _: 'textEntityTypeCode' }
  };
}

/**
 * Create a pre entity (code block).
 */
export function createPreEntity(offset: number, length: number, language?: string): TdlibTextEntity {
  return {
    _: 'textEntity',
    offset,
    length,
    type: language ? { _: 'textEntityTypePre', language } : { _: 'textEntityTypePre' }
  };
}
