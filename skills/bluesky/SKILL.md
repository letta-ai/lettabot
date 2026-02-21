---
name: bluesky
description: Post, reply, like, and repost on Bluesky using the lettabot-bluesky CLI. Read-only by default; explicit actions required.
---

# Bluesky

Bluesky is **read-only by default** in Lettabot. To post, reply, like, or repost you must use the `lettabot-bluesky` CLI.

## Quick Reference

```bash
lettabot-bluesky post --text "Hello" --agent <name>
lettabot-bluesky post --reply-to at://did:plc:.../app.bsky.feed.post/... --text "Reply" --agent <name>
lettabot-bluesky post --text "Long..." --threaded --agent <name>
lettabot-bluesky like at://did:plc:.../app.bsky.feed.post/... --agent <name>
lettabot-bluesky repost at://did:plc:.../app.bsky.feed.post/... --agent <name>
lettabot-bluesky repost at://did:plc:.../app.bsky.feed.post/... --text "Quote" --agent <name> [--threaded]
```

## Read Commands (public API)

```bash
lettabot-bluesky profile <did|handle> --agent <name>
lettabot-bluesky thread <at://did:plc:.../app.bsky.feed.post/...> --agent <name>
lettabot-bluesky author-feed <did|handle> --limit 25 --agent <name>
lettabot-bluesky list-feed <listUri> --limit 25 --agent <name>
lettabot-bluesky resolve <handle> --agent <name>
lettabot-bluesky followers <did|handle> --limit 25 --agent <name>
lettabot-bluesky follows <did|handle> --limit 25 --agent <name>
lettabot-bluesky lists <did|handle> --limit 25 --agent <name>
lettabot-bluesky actor-feeds <did|handle> --limit 25 --agent <name>
```

## Auth‑Required Reads (uses app password)

```bash
lettabot-bluesky search --query "memory agents" --limit 25 --agent <name>
lettabot-bluesky timeline --limit 25 --agent <name>
lettabot-bluesky notifications --limit 25 --reasons mention,reply --agent <name>
```

## Moderation (Mute / Block)

```bash
lettabot-bluesky mute <did|handle> --agent <name>
lettabot-bluesky unmute <did|handle> --agent <name>
lettabot-bluesky block <did|handle> --agent <name>
lettabot-bluesky unblock <blockUri> --agent <name>
lettabot-bluesky blocks --limit 50 --cursor <cursor> --agent <name>
lettabot-bluesky mutes --limit 50 --cursor <cursor> --agent <name>
```

Notes:
- `unblock` requires the **block record URI** (returned by the `block` command).
- `blocks` / `mutes` support pagination via `--cursor` (use the `cursor` field from the previous response).

## Notes

- Posts are capped at 300 characters unless you pass `--threaded`.
- `--threaded` splits text into a reply thread (explicit opt‑in).
- Replies and quotes require the target `at://` URI (included in incoming Bluesky messages).
- The CLI uses the Bluesky app password from your `lettabot.yaml` for the selected agent.
