export type DidMode = 'open' | 'listen' | 'mention-only' | 'disabled';

export interface BlueskyConfig {
  enabled?: boolean;
  agentName?: string;
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
