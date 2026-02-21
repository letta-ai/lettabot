import { isRecord, readString, readStringArray, truncate } from './utils.js';

export function parseReplyRefs(record: Record<string, unknown>): {
  rootUri?: string;
  rootCid?: string;
  parentUri?: string;
  parentCid?: string;
} {
  const reply = isRecord(record.reply) ? record.reply : undefined;
  if (!reply) return {};
  const root = isRecord(reply.root) ? reply.root : undefined;
  const parent = isRecord(reply.parent) ? reply.parent : undefined;
  return {
    rootUri: readString(root?.uri),
    rootCid: readString(root?.cid),
    parentUri: readString(parent?.uri),
    parentCid: readString(parent?.cid),
  };
}

export function extractPostDetails(record: Record<string, unknown>): {
  text?: string;
  createdAt?: string;
  langs: string[];
  replyRefs: ReturnType<typeof parseReplyRefs>;
  embedLines: string[];
} {
  const text = readString(record.text)?.trim();
  const createdAt = readString(record.createdAt);
  const langs = readStringArray(record.langs);
  const replyRefs = parseReplyRefs(record);
  const embedLines = summarizeEmbed(record.embed);
  return { text, createdAt, langs, replyRefs, embedLines };
}

export function summarizeEmbed(embed: unknown): string[] {
  if (!isRecord(embed)) return [];

  const embedType = readString(embed.$type);
  const lines: string[] = [];

  if (embedType === 'app.bsky.embed.images') {
    const images = Array.isArray(embed.images) ? embed.images : [];
    const altTexts = images
      .map((img) => (isRecord(img) ? readString(img.alt) : undefined))
      .filter((alt): alt is string => !!alt && alt.trim().length > 0);
    const summary = `Embed: ${images.length} image(s)`;
    if (altTexts.length > 0) {
      lines.push(`${summary} (alt: ${truncate(altTexts[0], 120)})`);
    } else {
      lines.push(summary);
    }
    return lines;
  }

  if (embedType === 'app.bsky.embed.external') {
    const external = isRecord(embed.external) ? embed.external : undefined;
    const title = external ? readString(external.title) : undefined;
    const uri = external ? readString(external.uri) : undefined;
    const description = external ? readString(external.description) : undefined;
    const titlePart = title ? ` "${truncate(title, 160)}"` : '';
    const uriPart = uri ? ` ${uri}` : '';
    lines.push(`Embed: link${titlePart}${uriPart}`);
    if (description) {
      lines.push(`Embed description: ${truncate(description, 240)}`);
    }
    return lines;
  }

  if (embedType === 'app.bsky.embed.record') {
    const record = isRecord(embed.record) ? embed.record : undefined;
    const uri = record ? readString(record.uri) : undefined;
    if (uri) {
      lines.push(`Embed: record ${uri}`);
    } else {
      lines.push('Embed: record');
    }
    return lines;
  }

  if (embedType === 'app.bsky.embed.recordWithMedia') {
    const record = isRecord(embed.record) ? embed.record : undefined;
    const uri = record ? readString(record.uri) : undefined;
    if (uri) {
      lines.push(`Embed: record ${uri}`);
    } else {
      lines.push('Embed: record');
    }
    lines.push(...summarizeEmbed(embed.media));
    return lines;
  }

  if (embedType) {
    lines.push(`Embed: ${embedType}`);
  }

  return lines;
}
