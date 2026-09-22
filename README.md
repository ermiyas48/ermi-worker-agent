# ERMI Worker Agent

Server-hosted Chromium controller for ERMI Worker / Discovery runs in ChatGPT.

## Architecture

- Railway + Playwright Chromium + persistent profile at `/data/profiles/chatgpt`
- State and run counter on `/data/state`
- No OpenAI API keys, no password storage outside the Chromium profile

## First-time setup

1. Open `https://<your-host>/setup?token=<OWNER_TOKEN>`
2. Tap **Sign in with ChatGPT**
3. Complete normal ChatGPT login/MFA in the live view
4. Authenticated state is detected automatically → setup complete

Profile persists across restarts. If the session later expires, runs return `REAUTH_REQUIRED` and you re-open `/setup`.

## Trigger a run

```
GET /run?token=<OWNER_TOKEN>
GET /run?token=<OWNER_TOKEN>&prompt=worker
GET /run?token=<OWNER_TOKEN>&prompt=discovery
```

Also accepts `Authorization: Bearer <OWNER_TOKEN>` and `POST /run`.

Response (202):

```json
{
  "ok": true,
  "status": "queued",
  "runId": "...",
  "promptId": "worker",
  "runNumber": 1,
  "message": "Run accepted and executing"
}
```

### Prompt sequence (persistent)

Accepted runs only:

1. worker  
2. worker  
3. worker  
4. discovery  
5. worker  
…  

Counter lives in `/data/state/run-counter.json` and survives Railway restarts.

## Status

- `GET /health` — uptime, setupComplete, runCounter  
- `GET /status` — current run state  

## Env

| Variable | Purpose |
|----------|---------|
| `OWNER_TOKEN` | Shared secret for /run and setup (min 16 chars) |
| `PROFILE_PATH` | Chromium profile dir (default `/data/profiles/chatgpt`) |
| `DATA_PATH` | State dir (default `/data/state`) |
| `HEADLESS` | `true` on Railway |
| `PORT` | `3000` |

## Local

```bash
npm install
npx playwright install chromium
OWNER_TOKEN=your-long-secret npm start
```
