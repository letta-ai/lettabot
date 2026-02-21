#!/usr/bin/env node
/**
 * lettabot-bluesky - Post, reply, like, or repost on Bluesky
 *
 * Usage:
 *   lettabot-bluesky post --text "Hello" --agent <name>
 *   lettabot-bluesky post --reply-to <at://...> --text "Reply" --agent <name>
 *   lettabot-bluesky post --text "Long..." --threaded --agent <name>
 *   lettabot-bluesky like <at://...> --agent <name>
 *   lettabot-bluesky repost <at://...> --agent <name>
 *   lettabot-bluesky repost <at://...> --text "Quote" --agent <name> [--threaded]
 *   lettabot-bluesky profile <did|handle> --agent <name>
 *   lettabot-bluesky thread <at://...> --agent <name>
 *   lettabot-bluesky author-feed <did|handle> --limit 25 --agent <name>
 *   lettabot-bluesky list-feed <listUri> --limit 25 --agent <name>
 *   lettabot-bluesky search --query "..." --limit 25 --agent <name>
 *   lettabot-bluesky notifications --limit 25 --reasons mention,reply --agent <name>
 */

import { loadAppConfigOrExit, normalizeAgents } from '../config/index.js';
import type { AgentConfig, BlueskyConfig } from '../config/types.js';
import { DEFAULT_APPVIEW_URL, DEFAULT_SERVICE_URL, POST_MAX_CHARS } from '../channels/bluesky/constants.js';

function usage(): void {
  console.log(`\nUsage:\n  lettabot-bluesky post --text "Hello" --agent <name>\n  lettabot-bluesky post --reply-to <at://...> --text "Reply" --agent <name>\n  lettabot-bluesky post --text "Long..." --threaded --agent <name>\n  lettabot-bluesky like <at://...> --agent <name>\n  lettabot-bluesky repost <at://...> --agent <name>\n  lettabot-bluesky repost <at://...> --text "Quote" --agent <name> [--threaded]\n  lettabot-bluesky profile <did|handle> --agent <name>\n  lettabot-bluesky thread <at://...> --agent <name>\n  lettabot-bluesky author-feed <did|handle> --limit 25 --agent <name>\n  lettabot-bluesky list-feed <listUri> --limit 25 --agent <name>\n  lettabot-bluesky search --query \"...\" --limit 25 --agent <name>\n  lettabot-bluesky notifications --limit 25 --reasons mention,reply --agent <name>\n`);
}

function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | undefined {
  if (!uri.startsWith('at://')) return undefined;
  const parts = uri.slice('at://'.length).split('/');
  if (parts.length < 3) return undefined;
  return { did: parts[0], collection: parts[1], rkey: parts[2] };
}

function splitPostText(text: string): string[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];
  if (chars.length <= POST_MAX_CHARS) {
    const trimmed = text.trim();
    return trimmed ? [trimmed] : [];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + POST_MAX_CHARS, chars.length);

    if (end < chars.length) {
      let split = end;
      for (let i = end - 1; i > start; i--) {
        if (/\s/.test(chars[i])) {
          split = i;
          break;
        }
      }
      end = split > start ? split : end;
    }

    let chunk = chars.slice(start, end).join('');
    chunk = chunk.replace(/^\s+/, '').replace(/\s+$/, '');
    if (chunk) chunks.push(chunk);

    start = end;
    while (start < chars.length && /\s/.test(chars[start])) {
      start++;
    }
  }

  return chunks;
}

function resolveAgentConfig(agents: AgentConfig[], agentName?: string): AgentConfig {
  if (agents.length === 0) {
    throw new Error('No agents configured.');
  }
  if (agents.length === 1 && !agentName) {
    return agents[0];
  }
  if (!agentName) {
    throw new Error('Multiple agents configured. Use --agent <name>.');
  }
  const exact = agents.find(agent => agent.name === agentName);
  if (exact) return exact;
  const lower = agentName.toLowerCase();
  const found = agents.find(agent => agent.name.toLowerCase() === lower);
  if (!found) throw new Error(`Agent not found: ${agentName}`);
  return found;
}

function resolveBlueskyConfig(agent: AgentConfig): BlueskyConfig {
  const config = agent.channels?.bluesky as BlueskyConfig | undefined;
  if (!config || config.enabled === false) {
    throw new Error(`Bluesky not configured for agent ${agent.name}.`);
  }
  if (!config.handle || !config.appPassword) {
    throw new Error('BLUESKY handle/appPassword missing in config.');
  }
  return config;
}

function getAppViewUrl(bluesky: BlueskyConfig): string {
  const raw = bluesky.appViewUrl || DEFAULT_APPVIEW_URL;
  return raw.replace(/\/+$/, '');
}

async function createSession(serviceUrl: string, handle: string, appPassword: string): Promise<{ accessJwt: string; did: string }> {
  const res = await fetch(`${serviceUrl}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`createSession failed: ${detail}`);
  }
  const data = await res.json() as { accessJwt: string; did: string };
  return data;
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Request failed: ${detail}`);
  }
  return res.json();
}

async function getRecord(serviceUrl: string, accessJwt: string, uri: string): Promise<{ cid: string; value: Record<string, unknown> }> {
  const parsed = parseAtUri(uri);
  if (!parsed) throw new Error(`Invalid at:// URI: ${uri}`);
  const qs = new URLSearchParams({
    repo: parsed.did,
    collection: parsed.collection,
    rkey: parsed.rkey,
  });
  const res = await fetch(`${serviceUrl}/xrpc/com.atproto.repo.getRecord?${qs.toString()}`, {
    headers: { 'Authorization': `Bearer ${accessJwt}` },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`getRecord failed: ${detail}`);
  }
  const data = await res.json() as { cid?: string; value?: Record<string, unknown> };
  if (!data.cid || !data.value) throw new Error('getRecord missing cid/value');
  return { cid: data.cid, value: data.value };
}

async function ensureCid(serviceUrl: string, accessJwt: string, uri: string, cid?: string): Promise<string> {
  if (cid) return cid;
  const record = await getRecord(serviceUrl, accessJwt, uri);
  return record.cid;
}

async function createRecord(
  serviceUrl: string,
  accessJwt: string,
  repo: string,
  collection: string,
  record: Record<string, unknown>,
): Promise<{ uri?: string; cid?: string }> {
  const res = await fetch(`${serviceUrl}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessJwt}`,
    },
    body: JSON.stringify({ repo, collection, record }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`createRecord failed: ${detail}`);
  }
  return res.json() as Promise<{ uri?: string; cid?: string }>;
}

async function handlePost(
  bluesky: BlueskyConfig,
  text: string,
  replyTo?: string,
  threaded = false,
): Promise<void> {
  const serviceUrl = (bluesky.serviceUrl || DEFAULT_SERVICE_URL).replace(/\/+$/, '');
  const session = await createSession(serviceUrl, bluesky.handle!, bluesky.appPassword!);
  const charCount = Array.from(text).length;
  if (charCount > POST_MAX_CHARS && !threaded) {
    throw new Error(`Post is ${charCount} chars. Use --threaded to split into a thread.`);
  }

  const chunks = threaded ? splitPostText(text) : [text.trim()];
  if (!chunks[0] || !chunks[0].trim()) {
    throw new Error('Refusing to post empty text.');
  }

  let rootUri: string | undefined;
  let rootCid: string | undefined;
  let parentUri: string | undefined;
  let parentCid: string | undefined;

  if (replyTo) {
    const parent = await getRecord(serviceUrl, session.accessJwt, replyTo);
    parentUri = replyTo;
    parentCid = parent.cid;
    const reply = (parent.value.reply as { root?: { uri?: string; cid?: string } } | undefined) || undefined;
    rootUri = reply?.root?.uri || parentUri;
    rootCid = reply?.root?.cid || parentCid;
  }

  const createdAt = new Date().toISOString();
  let lastUri = '';

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const record: Record<string, unknown> = {
      text: chunk,
      createdAt,
    };

    if (parentUri && parentCid && rootUri && rootCid) {
      record.reply = {
        root: { uri: rootUri, cid: rootCid },
        parent: { uri: parentUri, cid: parentCid },
      };
    }

    const created = await createRecord(serviceUrl, session.accessJwt, session.did, 'app.bsky.feed.post', record);
    if (!created.uri) throw new Error('createRecord returned no uri');
    lastUri = created.uri;

    if (i === 0 && !replyTo && chunks.length > 1) {
      rootUri = created.uri;
      rootCid = await ensureCid(serviceUrl, session.accessJwt, created.uri, created.cid);
      parentUri = rootUri;
      parentCid = rootCid;
    } else if (i < chunks.length - 1) {
      parentUri = created.uri;
      parentCid = await ensureCid(serviceUrl, session.accessJwt, created.uri, created.cid);
      if (!rootUri || !rootCid) {
        rootUri = parentUri;
        rootCid = parentCid;
      }
    }
  }

  console.log(`✓ Posted: ${lastUri}`);
}

async function handleQuote(
  bluesky: BlueskyConfig,
  targetUri: string,
  text: string,
  threaded = false,
): Promise<void> {
  const serviceUrl = (bluesky.serviceUrl || DEFAULT_SERVICE_URL).replace(/\/+$/, '');
  const session = await createSession(serviceUrl, bluesky.handle!, bluesky.appPassword!);
  const charCount = Array.from(text).length;
  if (charCount > POST_MAX_CHARS && !threaded) {
    throw new Error(`Post is ${charCount} chars. Use --threaded to split into a thread.`);
  }

  const target = await getRecord(serviceUrl, session.accessJwt, targetUri);
  const chunks = threaded ? splitPostText(text) : [text.trim()];
  if (!chunks[0] || !chunks[0].trim()) {
    throw new Error('Refusing to post empty text.');
  }

  let rootUri: string | undefined;
  let rootCid: string | undefined;
  let parentUri: string | undefined;
  let parentCid: string | undefined;
  const createdAt = new Date().toISOString();

  let lastUri = '';
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const record: Record<string, unknown> = {
      text: chunk,
      createdAt,
    };

    if (i === 0) {
      record.embed = {
        $type: 'app.bsky.embed.record',
        record: {
          uri: targetUri,
          cid: target.cid,
        },
      };
    }

    if (parentUri && parentCid && rootUri && rootCid) {
      record.reply = {
        root: { uri: rootUri, cid: rootCid },
        parent: { uri: parentUri, cid: parentCid },
      };
    }

    const created = await createRecord(serviceUrl, session.accessJwt, session.did, 'app.bsky.feed.post', record);
    if (!created.uri) throw new Error('createRecord returned no uri');
    lastUri = created.uri;

    if (i === 0 && chunks.length > 1) {
      rootUri = created.uri;
      rootCid = await ensureCid(serviceUrl, session.accessJwt, created.uri, created.cid);
      parentUri = rootUri;
      parentCid = rootCid;
    } else if (i < chunks.length - 1) {
      parentUri = created.uri;
      parentCid = await ensureCid(serviceUrl, session.accessJwt, created.uri, created.cid);
      if (!rootUri || !rootCid) {
        rootUri = parentUri;
        rootCid = parentCid;
      }
    }
  }

  console.log(`✓ Quoted: ${lastUri}`);
}

async function handleSubjectRecord(
  bluesky: BlueskyConfig,
  uri: string,
  collection: 'app.bsky.feed.like' | 'app.bsky.feed.repost',
): Promise<void> {
  const serviceUrl = (bluesky.serviceUrl || DEFAULT_SERVICE_URL).replace(/\/+$/, '');
  const session = await createSession(serviceUrl, bluesky.handle!, bluesky.appPassword!);
  const record = await getRecord(serviceUrl, session.accessJwt, uri);

  const createdAt = new Date().toISOString();
  const res = await createRecord(serviceUrl, session.accessJwt, session.did, collection, {
    subject: { uri, cid: record.cid },
    createdAt,
  });

  if (!res.uri) throw new Error('createRecord returned no uri');
  console.log(`✓ ${collection === 'app.bsky.feed.like' ? 'Liked' : 'Reposted'}: ${uri}`);
}

async function handleReadCommand(
  bluesky: BlueskyConfig,
  command: string,
  uriArg: string,
  query: string,
  limit?: number,
  reasons?: string[],
  priority?: boolean,
): Promise<void> {
  const appViewUrl = getAppViewUrl(bluesky);
  const serviceUrl = (bluesky.serviceUrl || DEFAULT_SERVICE_URL).replace(/\/+$/, '');
  const effectiveLimit = limit ?? 25;

  if (command === 'resolve') {
    if (!uriArg) throw new Error('Missing handle');
    const url = `${appViewUrl}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(uriArg)}`;
    const data = await fetchJson(url);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === 'profile') {
    if (!uriArg) throw new Error('Missing actor');
    const url = `${appViewUrl}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(uriArg)}`;
    const data = await fetchJson(url);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === 'thread') {
    if (!uriArg) throw new Error('Missing post URI');
    const url = `${appViewUrl}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uriArg)}`;
    const data = await fetchJson(url);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === 'author-feed') {
    if (!uriArg) throw new Error('Missing actor');
    const url = `${appViewUrl}/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(uriArg)}&limit=${effectiveLimit}`;
    const data = await fetchJson(url);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === 'list-feed') {
    if (!uriArg) throw new Error('Missing list URI');
    const url = `${appViewUrl}/xrpc/app.bsky.feed.getListFeed?list=${encodeURIComponent(uriArg)}&limit=${effectiveLimit}`;
    const data = await fetchJson(url);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === 'actor-feeds') {
    if (!uriArg) throw new Error('Missing actor');
    const url = `${appViewUrl}/xrpc/app.bsky.feed.getActorFeeds?actor=${encodeURIComponent(uriArg)}&limit=${effectiveLimit}`;
    const data = await fetchJson(url);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === 'followers') {
    if (!uriArg) throw new Error('Missing actor');
    const url = `${appViewUrl}/xrpc/app.bsky.graph.getFollowers?actor=${encodeURIComponent(uriArg)}&limit=${effectiveLimit}`;
    const data = await fetchJson(url);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === 'follows') {
    if (!uriArg) throw new Error('Missing actor');
    const url = `${appViewUrl}/xrpc/app.bsky.graph.getFollows?actor=${encodeURIComponent(uriArg)}&limit=${effectiveLimit}`;
    const data = await fetchJson(url);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === 'lists') {
    if (!uriArg) throw new Error('Missing actor');
    const url = `${appViewUrl}/xrpc/app.bsky.graph.getLists?actor=${encodeURIComponent(uriArg)}&limit=${effectiveLimit}`;
    const data = await fetchJson(url);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === 'search' || command === 'timeline' || command === 'notifications') {
    const session = await createSession(serviceUrl, bluesky.handle!, bluesky.appPassword!);
    if (command === 'search') {
      if (!query) throw new Error('Missing query');
      const url = `${serviceUrl}/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=${effectiveLimit}`;
      const data = await fetchJson(url, { 'Authorization': `Bearer ${session.accessJwt}` });
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (command === 'timeline') {
      const url = `${serviceUrl}/xrpc/app.bsky.feed.getTimeline?limit=${effectiveLimit}`;
      const data = await fetchJson(url, { 'Authorization': `Bearer ${session.accessJwt}` });
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (command === 'notifications') {
      const qs = new URLSearchParams();
      qs.set('limit', String(effectiveLimit));
      if (priority) qs.set('priority', 'true');
      if (reasons && reasons.length > 0) {
        for (const reason of reasons) qs.append('reasons', reason);
      }
      const url = `${serviceUrl}/xrpc/app.bsky.notification.listNotifications?${qs.toString()}`;
      const data = await fetchJson(url, { 'Authorization': `Bearer ${session.accessJwt}` });
      console.log(JSON.stringify(data, null, 2));
      return;
    }
  }

  throw new Error(`Unknown read command: ${command}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    process.exit(command ? 0 : 1);
  }

  let agentName = '';
  let text = '';
  let replyTo = '';
  let threaded = false;
  let uriArg = '';
  let query = '';
  let limit: number | undefined;
  let reasons: string[] | undefined;
  let priority = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--agent' && next) {
      agentName = next;
      i++;
    } else if ((arg === '--text' || arg === '-t') && next) {
      text = next;
      i++;
    } else if ((arg === '--query' || arg === '-q') && next) {
      query = next;
      i++;
    } else if (arg === '--reply-to' && next) {
      replyTo = next;
      i++;
    } else if (arg === '--threaded') {
      threaded = true;
    } else if (arg === '--limit' && next) {
      const parsed = parseInt(next, 10);
      if (!Number.isNaN(parsed)) limit = parsed;
      i++;
    } else if (arg === '--reasons' && next) {
      reasons = next.split(',').map(v => v.trim()).filter(Boolean);
      i++;
    } else if (arg === '--priority') {
      priority = true;
    } else if (arg === '--quote' && next) {
      uriArg = next;
      i++;
    } else if (!arg.startsWith('-') && !uriArg) {
      uriArg = arg;
    } else {
      console.warn(`Unknown arg: ${arg}`);
    }
  }

  const config = loadAppConfigOrExit();
  const agents = normalizeAgents(config);
  const agent = resolveAgentConfig(agents, agentName || undefined);
  const bluesky = resolveBlueskyConfig(agent);

  if (command === 'post') {
    if (!text) throw new Error('Missing --text');
    await handlePost(bluesky, text, replyTo || undefined, threaded);
    return;
  }

  if (command === 'like') {
    if (!uriArg) throw new Error('Missing post URI');
    await handleSubjectRecord(bluesky, uriArg, 'app.bsky.feed.like');
    return;
  }

  if (command === 'repost') {
    if (!uriArg) throw new Error('Missing post URI');
    if (text) {
      await handleQuote(bluesky, uriArg, text, threaded);
    } else {
      await handleSubjectRecord(bluesky, uriArg, 'app.bsky.feed.repost');
    }
    return;
  }

  if ([
    'resolve',
    'profile',
    'thread',
    'author-feed',
    'list-feed',
    'actor-feeds',
    'followers',
    'follows',
    'lists',
    'search',
    'timeline',
    'notifications',
  ].includes(command)) {
    await handleReadCommand(bluesky, command, uriArg, query, limit, reasons, priority);
    return;
  }

  console.error(`Unknown command: ${command}`);
  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
