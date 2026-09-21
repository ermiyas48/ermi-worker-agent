# ERMI Worker Agent – Server-Hosted Chromium Controller

Production web app that remotely controls a **persistent server-side Chromium** browser to start an ERMI Worker Agent run in ChatGPT.

**Not** a browser extension, userscript, phone automation, or OpenAI API integration.

## Flow

```
OPEN WEBSITE → SERVER WAKES → SERVER CHROMIUM → EXISTING CHATGPT SESSION
→ NEW CHAT → PROMPT INSERTED → PLUGINS/THINKING VERIFIED → SEND ONCE
→ SUBMISSION VERIFIED → DONE
```

## State machine

```
BROWSER_STARTING → CHATGPT_LOADING → CHATGPT_READY → AUTHENTICATED
→ NEW_CHAT_READY → COMPOSER_READY → PROMPT_INSERTED → PLUS_MENU_OPEN
→ PLUGIN_STATE_CONFIRMED → THINKING_STATE_CONFIRMED → READY_TO_SEND
→ MESSAGE_SENT → MESSAGE_VERIFIED → COMPLETE
```

Safety exits: `FAILED`, `NEEDS_REVIEW`, `REAUTH_REQUIRED`

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | none | Liveness |
| GET | `/status` | none | Public run state |
| POST | `/run` | Bearer token | Start ERMI run (202) |
| GET | `/run/status` | Bearer token | Detailed status |
| POST | `/setup/browser` | Bearer token | First-time browser launch |
| GET | `/setup/status` | Bearer token | Auth detection |
| GET | `/setup` | token in query | Temporary setup page |

## Security

- Strong `OWNER_TOKEN` required for control endpoints.
- Profile only on persistent volume; never in app DB.
- No passwords, OTPs, cookies, or conversation storage.
- Setup route disabled after `setupComplete=true`.
- One execution lock; never resend on ambiguous result.

## Railway

Volume at `/data`. Env: `OWNER_TOKEN`, `PROFILE_PATH=/data/profiles/chatgpt`, `DATA_PATH=/data/state`, `HEADLESS=true`.

## First-time setup

1. Set `OWNER_TOKEN` in Railway variables.
2. Open `https://<your-app>/setup?token=<OWNER_TOKEN>`.
3. Click **Start browser** and complete ChatGPT login in the server browser session (visible via Railway logs / remote display if configured).
4. When auth is detected, setup marks complete and `/setup` disables.
5. Use the white frontend **Start ERMI Worker** button (or `POST /run` with Bearer token).

## Local development

```bash
npm install
export OWNER_TOKEN=dev-secret-at-least-16-chars
export PROFILE_PATH=./data/profiles/chatgpt
export DATA_PATH=./data/state
export HEADLESS=false
node src/server.js
```
