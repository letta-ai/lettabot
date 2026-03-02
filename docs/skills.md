# Skills

Skills extend your LettaBot agent with CLI tools and specialized knowledge. They follow the open [Agent Skills](https://docs.letta.com/letta-code/skills) standard used by Letta Code, Cursor, Claude Code, and other compatible agents.

This document covers how skills work within lettabot specifically -- directory hierarchy, feature-gated installation, the SKILL.md format, and how to author new skills.

## How skills work

Skills go through two phases:

1. **Installation** -- Feature-gated skills (scheduling, Google, voice memo) are automatically copied to the agent's skill directory based on config flags in `lettabot.yaml`. Non-feature-gated skills are discovered directly from the directory hierarchy.
2. **Runtime** -- When a session starts, skill directories containing executables are prepended to `PATH` so the agent can invoke them as CLI tools.

## Directory hierarchy

LettaBot scans these directories in priority order. Same-name skills at higher priority override lower ones:

| Priority | Path | Scope | Description |
|----------|------|-------|-------------|
| 1 (highest) | `.skills/` | Project | Skills specific to this lettabot project |
| 2 | `~/.letta/agents/{id}/skills/` | Agent | Skills for one specific agent |
| 3 | `~/.letta/skills/` | Global | Shared across all agents on this machine |
| 4 | `skills/` (in lettabot repo) | Bundled | Ships with lettabot |
| 5 (lowest) | `~/.agents/skills/` | skills.sh | Installed via [skills.sh](https://skills.sh) |

Feature-gated skills are copied from source directories into the agent-scoped directory (`~/.letta/agents/{id}/skills/`) when a session is first acquired. The copy is idempotent -- skills already present in the target are skipped.

## Feature-gated skills

Some skills are only installed when their corresponding feature is enabled in `lettabot.yaml`:

| Config flag | Skills installed | Purpose |
|------------|-----------------|---------|
| `features.cron: true` | `scheduling` | Cron jobs and one-off reminders via `lettabot-schedule` |
| `integrations.google.enabled: true` or `polling.gmail.enabled: true` | `gog`, `google` | Google Workspace and Gmail integration |
| TTS provider configured (ElevenLabs or OpenAI key set) | `voice-memo` | Voice memo replies via `lettabot-tts` |

The mapping from config flags to skill names lives in `FEATURE_SKILLS` in `src/skills/loader.ts`. The code also supports passing explicit skill names programmatically via `additionalSkills` in `SkillsInstallConfig`.

## SKILL.md format

Each skill is a directory containing a `SKILL.md` file with YAML frontmatter and a body written for the agent (not humans). The body is loaded into the agent's context when the skill is relevant -- it's a prompt, not documentation.

```markdown
---
name: scheduling
description: Create scheduled tasks and one-off reminders.
---

# Scheduling

(Agent-facing instructions: CLI usage, when to use the skill, examples, constraints...)
```

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill identifier (must be unique within its scope) |
| `description` | No | Brief description shown to the agent |
| `emoji` | No | Display emoji |
| `homepage` | No | URL for the skill's homepage or docs |
| `metadata` | No | JSON-encoded object with a `clawdbot` key (see below) |

### ClawdBot metadata

The `metadata` field can contain a JSON-encoded `clawdbot` object for requirements and install specs:

```yaml
metadata: >-
  {"clawdbot": {
    "emoji": "📦",
    "requires": {"bins": ["mycli"], "env": ["MY_API_KEY"]},
    "install": [{"kind": "brew", "formula": "mycli"}]
  }}
```

**`requires`** -- prerequisites for the skill to be eligible:

| Field | Type | Description |
|-------|------|-------------|
| `bins` | `string[]` | All of these binaries must exist on PATH |
| `anyBins` | `string[]` | At least one of these must exist |
| `env` | `string[]` | Required environment variables |

Run `lettabot skills status` to see which skills are eligible and which have missing binaries, environment variables, or platform mismatches.

**`install`** -- how to install dependencies (tried in order, filtered by platform):

| Field | Type | Description |
|-------|------|-------------|
| `kind` | `'brew' \| 'node' \| 'go' \| 'uv' \| 'download'` | Package manager |
| `formula` | `string` | Homebrew formula (for `brew`) |
| `package` | `string` | npm/uv package name (for `node`/`uv`) |
| `module` | `string` | Go module path (for `go`) |
| `url` | `string` | Download URL (for `download`) |
| `bins` | `string[]` | Binaries this installs |
| `os` | `string[]` | Platform filter (`darwin`, `linux`, `win32`) |
| `label` | `string` | Display label for the install option |

**Other metadata fields:**

| Field | Type | Description |
|-------|------|-------------|
| `os` | `string[]` | Restrict skill to these platforms |
| `always` | `boolean` | Always eligible regardless of requirements |
| `skillKey` | `string` | Override the skill's key identifier |
| `primaryEnv` | `string` | Primary environment variable for the skill |

## Skill execution

When a session starts, `withAgentSkillsOnPath()` in `src/skills/loader.ts` prepends the agent's skill directories to `PATH`. Only directories containing at least one non-`.md` file (i.e., executables or scripts) are added.

PATH mutations are serialized via a lock to avoid races when multiple sessions initialize concurrently. The original PATH is restored after the session operation completes.

## Bundled skills

LettaBot ships with two built-in skills in the `skills/` directory:

- **scheduling** -- Create recurring cron jobs and one-off reminders via the `lettabot-schedule` CLI. Enabled by `features.cron: true`. See [Cron Setup](./cron-setup.md) for details.
- **voice-memo** -- Reply with voice notes using the `<voice>` directive and `lettabot-tts` CLI. Enabled when a TTS provider (ElevenLabs or OpenAI) is configured.

## Installing external skills

Use the interactive CLI to discover and enable skills:

```bash
# Interactive skill selector
lettabot skills

# Enable/disable skills from Clawdhub, skills.sh, and built-in sources
lettabot skills sync

# Check status of all discovered skills
lettabot skills status
```

External skill sources:

- [Clawdhub](https://clawdhub.com/) -- `npx clawdhub@latest install <skill>`
- [skills.sh](https://skills.sh) -- community skill repositories

See the [Letta Code skills documentation](https://docs.letta.com/letta-code/skills) for the general skill installation flow and additional skill sources.

## Authoring a new skill

To add a skill to lettabot:

1. Create a directory under `skills/<name>/` with a `SKILL.md` file. The frontmatter declares metadata (see above). The body is a prompt loaded into the agent's context -- write it as instructions the agent will follow, not as human documentation.
2. Place any executables or scripts alongside `SKILL.md` in the same directory. These become available on the agent's PATH at runtime.
3. If the skill should be feature-gated (only installed when a config flag is set), add an entry to `FEATURE_SKILLS` in `src/skills/loader.ts` and wire up the corresponding config flag in `main.ts`.
4. Verify with `lettabot skills status` that the skill is discovered and eligible.

For project-local skills that don't ship with lettabot, place them in `.skills/<name>/` instead.
