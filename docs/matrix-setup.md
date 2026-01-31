# Matrix / Tchap Setup Guide

LettaBot supports **Matrix** (including **Tchap**, the French government's secure messaging platform) with End-to-End Encryption (E2EE) enabled by default.

## Prerequisites

1.  **Matrix Account:** A bot account on any Matrix homeserver (e.g., `matrix.org` or `tchap.gouv.fr`).
2.  **Access Token:** An access token for the bot account. Use our helper script to generate one.

## Quick Setup (Recommended)

Run the onboarding wizard:

```bash
lettabot onboard
```

Select **Matrix / Tchap** and follow the prompts.

## Manual Configuration

### 1. Get Credentials

Run the helper script to login and generate a stable token:

```bash
npm run matrix-login
```

Follow the prompts:
- **Homeserver:** `https://matrix.org` (or generic Matrix server)
- **Tchap Homeserver:** `https://matrix.agent.dinum.tchap.gouv.fr` (for production Tchap)
- **Username:** Full Matrix ID (e.g., `@lettabot:matrix.org`)
- **Password:** Bot account password

The script will output `MATRIX_HOMESERVER_URL` and `MATRIX_ACCESS_TOKEN`.

### 2. Configure Environment

Add to your `.env` file:

```bash
# Matrix / Tchap Configuration
MATRIX_HOMESERVER_URL=https://matrix.org
MATRIX_ACCESS_TOKEN=syt_...
MATRIX_ENCRYPTION_ENABLED=true  # Default: true
MATRIX_DM_POLICY=pairing        # pairing, allowlist, or open
```

### 3. Configuration Options

| Variable | Description | Default |
| :--- | :--- | :--- |
| `MATRIX_HOMESERVER_URL` | URL of the Matrix homeserver | Required |
| `MATRIX_ACCESS_TOKEN` | Bot access token | Required |
| `MATRIX_ENCRYPTION_ENABLED` | Enable E2EE (recommended) | `true` |
| `MATRIX_DM_POLICY` | Who can message the bot | `pairing` |
| `MATRIX_ALLOWED_USERS` | Comma-separated list of allowed user IDs | - |
| `MATRIX_AUTO_JOIN_ROOMS` | Auto-join invited rooms | `true` |
| `MATRIX_STORAGE_PATH` | Path for bot state | `./data/matrix` |
| `MATRIX_CRYPTO_STORAGE_PATH`| Path for encryption keys | `./data/matrix/crypto`|

## Tchap Specifics

Tchap is a Matrix homeserver with specific security requirements.

- **E2EE is Mandatory:** Most Tchap conversations require encryption. Ensure `MATRIX_ENCRYPTION_ENABLED=true`.
- **External Users:** If the bot is an "external" user (e.g., on `tchap.incubateur.net`), it may have restrictions on initiating conversations with government agents.
- **Localization:** The bot automatically detects Tchap homeservers and switches pairing messages to **French**.

## Troubleshooting

### "Unknown Token" Error
Matrix access tokens obtained from a browser session (Element Web) may expire or be rotated. Use `npm run matrix-login` to generate a dedicated device ID and stable token for the bot.

### "Zombie" Device / Encryption Errors
If you reset the bot or change the `MATRIX_CRYPTO_STORAGE_PATH`, you might encounter decryption errors.
1. Delete the storage directory: `rm -rf data/matrix`
2. Log in again or clear the device list in your Matrix client settings.

### E2EE Not Working
Ensure `matrix-bot-sdk` crypto dependencies are installed. You may need to run:
```bash
pnpm rebuild
```
