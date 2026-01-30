
# Tchap / Matrix Setup Guide

LettaBot supports Tchap (the French government's messaging platform) and other Matrix-based servers.

## Prerequisites

1.  **A Tchap/Matrix Account**:
    - For Tchap: A `*.gouv.fr` email address (Agent) or an external account (Guest).
    - For Matrix: Any Matrix account (e.g., `matrix.org`).

2.  **Node.js 18+**

## Configuration

LettaBot provides a built-in interactive setup wizard:

```bash
lettabot onboard
```

Select "Tchap" and follow the prompts.

### Obtaining an Access Token

For security, Tchap uses short-lived tokens in the browser. To get a stable token for your bot, we provide a helper script:

```bash
npm run tchap-login
```

This script will prompt for your:
- **Homeserver URL**:
    - Production: `https://matrix.agent.dinum.tchap.gouv.fr`
    - Test/Dev (Agent): `https://matrix.i.tchap.gouv.fr` or `https://matrix.dev01.tchap.incubateur.net`
    - Test/Dev (External): `https://matrix.ext01.tchap.incubateur.net`
    - Matrix.org: `https://matrix.org`
- **Username**: Full Matrix ID (e.g., `@user:server.tchap.gouv.fr`)
- **Password**: Your account password

It will output a valid `TCHAP_ACCESS_TOKEN` and `TCHAP_HOMESERVER_URL`.

### Manual Configuration (.env)

Add the following to your `.env` file:

```bash
# Tchap / Matrix
TCHAP_HOMESERVER_URL=https://matrix.agent.dinum.tchap.gouv.fr
TCHAP_ACCESS_TOKEN=your_access_token
TCHAP_ENCRYPTION_ENABLED=true  # Required for Tchap private rooms
TCHAP_DM_POLICY=pairing        # Recommended
```

## Usage

1.  Start the bot:
    ```bash
    lettabot server
    ```
2.  Send a message to your bot user on Tchap/Element.
3.  The bot will reply with a pairing request (in French for Tchap, usually).
4.  Approve the pairing code:
    ```bash
    lettabot pairing approve tchap <CODE>
    ```

## Development

If you encounter "Zombie Device" errors (keys already exist), clear the local storage:

```bash
rm -rf data/tchap
```

This forces the bot to create a new session. Ensure you generate a fresh token if the error persists.
