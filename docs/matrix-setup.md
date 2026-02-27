# Matrix Setup Guide

Matrix is an open network for secure, decentralized communication. Lettabot supports Matrix as a channel, including end-to-end encryption (E2EE).

## Prerequisites

- A Matrix account on any homeserver (e.g., matrix.org, or self-hosted)
- An access token for the bot account

## Quick Start

### Option 1: Interactive Setup (Recommended)

Run the onboard wizard:

```bash
lettabot onboard
```

Select **Matrix** from the channel options and follow the prompts.

### Option 2: Manual Configuration

1. **Get an access token** using the helper script:

```bash
npm run matrix-login
```

Or manually from Element:
- Go to **Settings → Help & About → Access Token**
- Copy the token

2. **Add to your `lettabot.yaml`**:

```yaml
agents:
  - name: MyBot
    channels:
      matrix:
        enabled: true
        homeserverUrl: https://matrix.org
        accessToken: your_access_token_here
        encryptionEnabled: true
        autoJoinRooms: true
        dmPolicy: pairing
```

## Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `enabled` | Enable Matrix channel | `true` |
| `homeserverUrl` | Matrix homeserver URL | `https://matrix.org` |
| `accessToken` | Bot's access token | Required |
| `encryptionEnabled` | Enable E2EE support | `true` |
| `storagePath` | Path for session storage | `./data/matrix` |
| `cryptoStoragePath` | Path for E2EE keys | `./data/matrix/crypto` |
| `autoJoinRooms` | Auto-join when invited | `true` |
| `dmPolicy` | Who can message: `pairing`, `allowlist`, or `open` | `pairing` |
| `allowedUsers` | List of allowed Matrix IDs | `[]` |
| `messagePrefix` | Prefix for bot messages | None |

## Access Control

### Pairing Mode (Default)

Users must be approved before messaging the bot:

1. User sends a message to the bot
2. Bot replies with a pairing code
3. Admin runs: `lettabot pairing approve matrix CODE`

### Allowlist Mode

Only specified users can message:

```yaml
matrix:
  dmPolicy: allowlist
  allowedUsers:
    - "@alice:matrix.org"
    - "@bob:example.com"
```

### Open Mode

Anyone can message (not recommended for public bots):

```yaml
matrix:
  dmPolicy: open
```

## End-to-End Encryption

Lettabot supports E2EE using the Matrix protocol's encryption:

- **Enabled by default** - set `encryptionEnabled: false` to disable
- Keys are stored in `./data/matrix/crypto`
- First message may take longer while keys are exchanged

### E2EE Setup Requirements

**Important:** For E2EE to work correctly, encryption must be enabled on BOTH sides:

1. **In lettabot** - Set `encryptionEnabled: true` (default)
2. **In the Matrix room** - Enable encryption in your Matrix client (Element, etc.)

If encryption is enabled in lettabot but NOT in the room, you'll see:
- `M_NOT_FOUND` errors in logs (SDK trying to fetch non-existent keys)
- Messages may fail to decrypt

### E2EE Troubleshooting

**"Failed to decrypt your message" errors:**

This means the bot doesn't have the room key. Common causes:

1. **Encryption mismatch** - Room is encrypted but bot wasn't set up with E2EE from the start
   - Solution: Reset crypto storage and get a new access token:
   ```bash
   rm -rf ./data/matrix/crypto
   npm run matrix-login  # Generate new token
   # Update lettabot.yaml with new token
   lettabot server
   ```

2. **Crypto storage mismatch** - Access token changed but crypto storage is old
   - Solution: Same as above - delete crypto storage and regenerate token

3. **Device verification** - In Element, verify the bot's device for better security

### M_NOT_FOUND Errors

These errors appear when the Matrix SDK tries to fetch encryption keys that don't exist. This happens when:

- **E2EE is enabled in lettabot but NOT in the Matrix room** - The SDK expects keys but they don't exist
- Cross-signing or key backups aren't configured (harmless)

**Solution:** Ensure encryption is enabled in both lettabot AND the Matrix room.

Lettabot suppresses these errors by default. To see them for debugging:

```bash
DEBUG=1 lettabot server
```

## Environment Variables

You can also configure Matrix via environment variables:

```bash
MATRIX_HOMESERVER_URL=https://matrix.org
MATRIX_ACCESS_TOKEN=your_token
MATRIX_ENCRYPTION_ENABLED=true
MATRIX_AUTO_JOIN_ROOMS=true
MATRIX_DM_POLICY=pairing
MATRIX_ALLOWED_USERS=@user1:matrix.org,@user2:matrix.org
```

## Tchap Support

Lettabot works with Tchap (French government Matrix):

```yaml
matrix:
  homeserverUrl: https://matrix.agent.dinum.tchap.gouv.fr
  accessToken: your_tchap_token
```

Pairing messages will be displayed in French automatically.

## Testing Your Setup

1. Start the bot:
   ```bash
   lettabot server
   ```

2. Open your Matrix client (Element, etc.)

3. Start a DM with the bot's Matrix ID

4. Send a message!

## Troubleshooting

### Bot doesn't connect

- Check `homeserverUrl` is correct
- Verify `accessToken` is valid (not expired)
- Check network connectivity

### Messages not received

- Check `dmPolicy` - user may need pairing approval
- Verify bot is running: `lettabot server`

### E2EE not working

- Ensure `encryptionEnabled: true`
- Check crypto storage path exists
- Try deleting crypto storage and restarting

### Access token invalid

Access tokens can become invalid if:
- You logged out from that session
- The token was revoked
- Password was changed

Generate a new token with `npm run matrix-login`.
