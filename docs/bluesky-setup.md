# Bluesky Jetstream Setup

LettaBot can ingest Bluesky events using the Jetstream WebSocket feed. This channel is read-only by default, with optional reply posting if you provide a Bluesky app password.

## Overview

- Jetstream provides a firehose of ATProto commit events.
- You filter by DID(s) and optionally by collection.
- Events are delivered to the agent in listening mode by default (read-only).
- If enabled, the bot can auto-reply to posts using the ATProto XRPC API.

## Configuration (lettabot.yaml)

```yaml
channels:
  bluesky:
    enabled: true
    # autoReply: true  # Enable auto-replies (default: false / read-only)
    wantedDids: ["did:plc:..."]
    # lists:
    #   "at://did:plc:.../app.bsky.graph.list/xyz": { mode: listen }
    # wantedCollections: ["app.bsky.feed.post"]
    # notifications:
    #   enabled: true
    #   intervalSec: 60
    #   reasons: ["mention", "reply", "quote"]
    # handle: you.bsky.social
    # appPassword: xxxx-xxxx-xxxx-xxxx
    # serviceUrl: https://bsky.social
    # appViewUrl: https://public.api.bsky.app
```

### Conversation routing

If you want Bluesky to keep its own conversation history while other channels stay shared, add a per-channel override:

```yaml
conversations:
  mode: shared
  perChannel: ["bluesky"]
```

### Filters (how Jetstream is narrowed)

- `wantedDids`: list of DID(s) to include. Multiple entries are ORed.
- `wantedCollections`: list of collections to include. Multiple entries are ORed.
- Both filters are ANDed together.
  - Example: wantedDids=[A] + wantedCollections=[app.bsky.feed.post] => only posts by DID A.

If you omit `wantedCollections`, you'll see all collections for the included DIDs (posts, likes, reposts, follows, blocks, etc.).

If there are no `wantedDids` (after list expansion), Jetstream does not connect. Notifications polling can still run if auth is configured.

### Manual posting (skill/CLI)

Bluesky is read-only by default. To post, reply, like, or repost, use the CLI:

```bash
lettabot-bluesky post --text "Hello" --agent <name>
lettabot-bluesky post --reply-to at://did:plc:.../app.bsky.feed.post/... --text "Reply" --agent <name>
lettabot-bluesky like at://did:plc:.../app.bsky.feed.post/... --agent <name>
lettabot-bluesky repost at://did:plc:.../app.bsky.feed.post/... --agent <name>
```

Posts over 300 characters require `--threaded` to explicitly split into a reply thread.

If there are **no** `wantedDids` (after list expansion), Jetstream does **not** connect. Notifications polling can still run if auth is configured.

### Mentions

Jetstream does not provide mention notifications. Mentions are surfaced via the Notifications API (see below). `mention-only` mode only triggers replies for mention notifications.

## Notifications (mentions, replies, likes, etc.)

Jetstream does not include notifications. To get mentions/replies like the Bluesky app, enable polling via the Notifications API:

```yaml
channels:
  bluesky:
    notifications:
      enabled: true
      intervalSec: 60
      reasons: ["mention", "reply", "quote"]
```

If you supply posting credentials (`handle` + `appPassword`) and do not explicitly disable notifications, polling is enabled with defaults (60s, reasons: mention/reply/quote). Notifications polling works even if `wantedDids` is empty.

Notification reasons include (non-exhaustive): `like`, `repost`, `follow`, `mention`, `reply`, `quote`, `starterpack-joined`, `verified`, `unverified`, `like-via-repost`, `repost-via-repost`, `subscribed-post`.

Only `mention`, `reply`, and `quote` are considered "actionable" for reply behavior (based on your `groups` mode). Other reasons are always listening-only.

## Runtime Kill Switch (per agent)

Disable or re-enable Bluesky without restarting the server:

```bash
lettabot bluesky disable --agent MyAgent
lettabot bluesky enable --agent MyAgent
```

Refresh list expansions on the running server:

```bash
lettabot bluesky refresh-lists --agent MyAgent
```

Kill switch state is stored in `bluesky-runtime.json` (per agent) under the data directory and polled by the running server.

When you use `bluesky add-did`, `bluesky add-list`, or `bluesky set-default`, the CLI also triggers a runtime config reload so the running server updates Jetstream subscriptions without restart.

## Per-DID Modes (using `groups` syntax)

Bluesky uses the same `groups` pattern as other channels, where `"*"` is the default:

```yaml
channels:
  bluesky:
    enabled: true
    wantedDids: ["did:plc:author1"]
    groups:
      "*": { mode: listen }
      "did:plc:author1": { mode: open }
      "did:plc:author2": { mode: listen }
      "did:plc:spammy": { mode: disabled }
```

Mode mapping:
- `open` -> reply to posts for that DID
- `listen` -> listening-only
- `mention-only` -> reply only for mention notifications
- `disabled` -> ignore events from that DID

Default behavior:
- If `"*"` is set, it is used as the default for any DID without an explicit override.
- If `"*"` is not set, default is `listen`.

## Lists

You can target a Bluesky list by URI and assign a mode. On startup, the list is expanded to member DIDs and added to the stream filter.

```yaml
channels:
  bluesky:
    lists:
      "at://did:plc:.../app.bsky.graph.list/xyz": { mode: listen }
```

If a DID appears in both `groups` and a list, the explicit `groups` mode wins.

List expansion uses the AppView API (default: `https://public.api.bsky.app`). Set `appViewUrl` if you need a different AppView (e.g., for private lists).

## Reply Posting (optional)

To allow replies, set posting credentials and choose a default mode that allows replies (`open` or `mention-only`):

```yaml
channels:
  bluesky:
    groups:
      "*": { mode: open }
    handle: you.bsky.social
    appPassword: xxxx-xxxx-xxxx-xxxx
```

Notes:
- You must use a Bluesky app password (Settings -> App Passwords).
- Replies are posted only for `app.bsky.feed.post` events.
- Replies go to the latest post from the DID currently being processed.
- Posts are capped to 300 characters.

## Embeds (summary output)

Post embeds are summarized in a compact form, for example:
- `Embed: 2 image(s) (alt: ...)`
- `Embed: link "Title" https://...`
- `Embed: record at://...`

## Troubleshooting

### No messages appearing
- Ensure `wantedDids` contains DID values (e.g. `did:plc:...`), not handles.
- Confirm `wantedCollections` isn't filtering out posts (omit it to see all collections).
- Check logs for the warning about missing `wantedDids` (firehose may be too noisy).
- Verify the Jetstream URL is reachable.
