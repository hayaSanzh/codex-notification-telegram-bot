# Codex Notification Bot

Telegram remote control for existing local Codex sessions.

The bot runs on the laptop, talks to `codex app-server` over stdio, and only resumes threads that already exist in local Codex history. It never creates new Codex threads from Telegram, so start the first session in VS Code Codex extension or Codex CLI.

## Setup

1. Create a Telegram bot with BotFather and get the token.
2. Copy `.env.example` to `.env`.
3. Fill:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_ALLOWED_USER_IDS`, comma-separated Telegram numeric user ids.
4. Install and run:

```bash
npm install
npm run build
npm start
```

For development:

```bash
npm run dev
```

## Commands

- `/threads [search]` - list existing Codex threads from local history.
- `/use <number|thread_id>` - resume and select an existing thread.
- `/current` - show selected thread.
- `/status` - refresh selected thread status; if the bridge missed a completion after restart, it can recover the last turn result from history.
- `/interrupt` - interrupt active bot-started turn.

Plain text is sent to the selected thread. If a bot-started turn is still running, new text is ignored. Agent text deltas are streamed back to Telegram as one throttled intermediate preview message that is edited in place.

When selecting or starting a turn, the bridge reads the latest thread history and treats a latest `inProgress` turn as active even if the local bot app-server reports `idle`. The bridge also watches the selected thread's rollout file in the background, so turns started from VS Code can stream progress and final answers back to Telegram.

## Media

- Photos are downloaded to `UPLOAD_DIR/<threadId>/...` and sent to Codex as `localImage`.
- Photo paths are resolved to absolute local paths before being sent to Codex.
- Documents are downloaded locally and passed to Codex as a local file path in text.
- Media without a caption waits `MEDIA_TEXT_WAIT_MS` for the next text message, then sends media and text as one Codex turn.
- If Codex references an existing local file path in its final answer, the bot sends that file to Telegram as a photo or document.

Telegram cloud Bot API file-size limits still apply.

## Streaming

- `STREAM_UPDATES_MS=5000` controls how often intermediate agent text can be sent.
- `STREAM_MIN_CHARS=120` avoids sending tiny partial fragments unless the turn completes.
- `EXTERNAL_SESSION_WATCH_MS=5000` controls how often selected VS Code threads are checked for turns started outside Telegram.
- The final completion message includes the full final agent text, status, and summary.

## Codex Runtime

- `CODEX_BIN=codex` controls which Codex binary the bot starts.
- `CODEX_SANDBOX_MODE` can be `read-only`, `workspace-write`, or `danger-full-access`.
- `CODEX_APPROVAL_POLICY` can be `untrusted`, `on-failure`, `on-request`, or `never`.
- VS Code extension access settings are separate from this bot process, so set these env vars when the Telegram app-server should run with different permissions.

## Logs and Recovery

- Structured logs are written to stdout and `LOG_PATH` (`data/bot.log` by default).
- Active bot-started turns are persisted in `STATE_PATH`, so `/status` can explain whether a restarted bridge missed a result or the turn is still active.

## systemd User Service

Install and start the bot as a user service:

```bash
npm run build
chmod +x scripts/start-systemd.sh
mkdir -p ~/.config/systemd/user
cp systemd/codex-notification-bot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now codex-notification-bot.service
loginctl enable-linger "$USER"
```

Check status and logs:

```bash
systemctl --user status codex-notification-bot.service
journalctl --user -u codex-notification-bot.service -f
```

Restart after code changes:

```bash
npm run build
systemctl --user restart codex-notification-bot.service
```

## Safety

- Only `TELEGRAM_ALLOWED_USER_IDS` can use the bot.
- `codex app-server` is launched over stdio only; no public socket is opened.
- Approval requests from Codex are shown as Telegram inline buttons.
- Bot token and auth-like fields are redacted from structured logs.

## Checks

```bash
npm test
npm run build
npm run smoke:codex
```
