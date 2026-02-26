import type { InboundMessage } from '../../core/types.js';

export type DidMode = 'open' | 'listen' | 'mention-only' | 'disabled';

/**
 * AT Protocol source identifiers attached to Bluesky inbound messages.
 * Used by the adapter to construct replies, reposts, and likes.
 */
export interface BlueskySource {
  uri?: string;
  collection?: string;
  cid?: string;
  rkey?: string;
  threadRootUri?: string;
  threadParentUri?: string;
  threadRootCid?: string;
  threadParentCid?: string;
  subjectUri?: string;
  subjectCid?: string;
}

/**
 * Bluesky-specific inbound message carrying AT Protocol source metadata
 * and display context. Extends InboundMessage without polluting the core type.
 */
export interface BlueskyInboundMessage extends InboundMessage {
  source?: BlueskySource;
  extraContext?: Record<string, string>;
}

export interface BlueskyConfig {
  enabled?: boolean;
  agentName?: string;
  autoReply?: boolean; // Allow auto-replies (default: false / read-only)
  jetstreamUrl?: string;
  wantedDids?: string[] | string;
  wantedCollections?: string[] | string;
  cursor?: number;
  handle?: string;
  appPassword?: string;
  serviceUrl?: string;
  appViewUrl?: string;
  groups?: Record<string, { mode?: DidMode }>;
  lists?: Record<string, { mode?: DidMode }>;
  notifications?: {
    enabled?: boolean;
    intervalSec?: number;
    limit?: number;
    priority?: boolean;
    reasons?: string[] | string;
    backfill?: boolean;
  };
}

export interface JetstreamCommit {
  operation?: string;
  collection?: string;
  rkey?: string;
  cid?: string;
  record?: Record<string, unknown>;
}

export interface JetstreamEvent {
  kind?: string;
  did?: string;
  time_us?: number;
  commit?: JetstreamCommit;
  identity?: { handle?: string };
  account?: { handle?: string };
}
