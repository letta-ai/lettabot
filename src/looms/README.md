# Contributing a Loom

Looms are the ASCII art displays shown when lettabot starts up. One loom is randomly selected each boot. Anyone can contribute a loom by adding a `.txt` file to this directory.

## File Format

Each loom is a plain text file with a metadata header and the art below a `---` separator:

```
# name: My Loom
# author: your-github-username
# version: 1.0
---
╔═══════════════════════════════════════╗
║       YOUR LOOM ART HERE              ║
╚═══════════════════════════════════════╝
```

### Metadata (above `---`)

Lines starting with `#` are parsed as `key: value` metadata.

| Field     | Required | Description                     |
|-----------|----------|---------------------------------|
| `name`    | Yes      | Display name of your loom       |
| `author`  | Yes      | Your GitHub username            |
| `version` | No       | Version string                  |

### Art (below `---`)

Everything below the `---` separator is printed exactly as-is to the terminal. You have full creative control:

- **Box style**: Use any Unicode box-drawing characters you like (`╔╗╚╝═║`, `┌┐└┘─│`, `+--+`, etc.)
- **Width**: Keep it under ~45 characters wide so it centers well under the LETTABOT block text
- **Height**: No strict limit, but aim for 20-35 lines for a balanced display
- **Emoji**: Supported (emoji are 2 terminal columns wide, matching their 2-char JS surrogate pairs)
- **Content**: The art is displayed between the LETTABOT ASCII banner and the agent status lines

### Example

See `memory-weaver.txt` for the reference loom.

## How It Works

At startup, `loom-loader.ts` reads all `.txt` files in this directory, parses the metadata, and picks one at random. The selected loom's art lines are printed with a centering prefix to align under the LETTABOT block text.

A small credit line `loom: <name> by <author>` is printed below the art.

## Testing Your Loom

Run lettabot in dev mode to see your loom:

```bash
npm run dev
```

Since selection is random, you may need to restart a few times to see yours (or temporarily rename other `.txt` files).

## Tips

- Use a monospace text editor to align your art
- Test in a standard 80-column terminal
- The centering prefix is 12 spaces -- your art appears indented from the left
- Look at existing looms for inspiration
