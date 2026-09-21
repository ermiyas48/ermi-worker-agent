# ERMI Worker Agent – Server-Hosted Chromium Controller

Production web app that remotely controls a **persistent server-side Chromium** browser to start an ERMI Worker Agent run in ChatGPT.

**Not** a browser extension, userscript, phone automation, or OpenAI API integration.

## Flow

```
OPEN WEBSITE → SERVER WAKES → SERVER CHROMIUM → EXISTING CHATGPT SESSION
→ NEW CHAT → PROMPT INSERTED → PLUGINS/THINKING VERIFIED → SEND ONCE
→ SUBMISSION VERIFIED → DONE
```

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
