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

## Notes

- Posts are capped at 300 characters unless you pass `--threaded`.
- `--threaded` splits text into a reply thread (explicit opt‑in).
- Replies and quotes require the target `at://` URI (included in incoming Bluesky messages).
- The CLI uses the Bluesky app password from your `lettabot.yaml` for the selected agent.
