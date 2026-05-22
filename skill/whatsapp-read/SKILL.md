---
name: whatsapp-read
description: Read WhatsApp messages, list chats, and search history via the local whatsapp-bridge service. Use when the user asks about WhatsApp messages, "what did X say on WhatsApp", "any unread WhatsApp", "search WhatsApp for Y", "send a WhatsApp to X", or anything involving WhatsApp conversations.
---

# whatsapp-read

Talks to a local HTTP service (`whatsapp-bridge`) that holds a logged-in WhatsApp session and persists incoming messages.

## Step 1 — Load config

Read `~/.whatsapp-bridge/config.json`. It contains:
- `baseUrl` (e.g. `http://127.0.0.1:4477`)
- `apiToken`

Every request needs the header `Authorization: Bearer <apiToken>`.

If the file does not exist or the request to `/health` fails with `ECONNREFUSED`, tell the user the service is not running and to start it with `npm start` inside the `whatsapp-bridge` repo.

## Step 2 — Check health first

```
GET {baseUrl}/health
```

Response: `{ ok, mode, connected, hasQR, sendEnabled, messages, chats }` (extension mode also includes `extension: { state, at }`).

- **`mode: "baileys"`** (default): if `connected: false` and `hasQR: true`, tell the user to look at the service terminal and scan the QR code. Do not retry queries until connected.
- **`mode: "extension"`**: the WhatsApp connection lives in a Chrome/Chromium tab (the bridge extension), not in the service. The tab reports its state, so `connected` here means the tab is live and `extension.state` is one of `connected` / `needs_auth` (QR/login screen) / `logged_out` / `unknown` (no tab has reported yet). If `connected: false` or reads look stale, tell the user to open/refresh WhatsApp Web with the extension installed — and if `needs_auth`/`logged_out`, that they need to scan the QR / log back in.

## Available endpoints

All under `{baseUrl}`. All require the Bearer token except `/health`.

| Method | Path                        | Purpose                              |
|--------|-----------------------------|--------------------------------------|
| GET    | `/chats?limit=20&unread=true` | List chats, newest first             |
| GET    | `/chats/:id/messages?limit=50&since=<ms>` | Messages in a chat (oldest→newest)   |
| GET    | `/search?q=<text>&limit=20`   | Full-text search across all messages |
| POST   | `/chats/:id/read`             | Mark chat as read                    |
| POST   | `/chats/:id/backfill`         | (extension mode) re-fetch chat history into the DB. Body `{ since?: ms, max?: N }` |
| GET    | `/contacts?q=<text>&limit=20` | Resolve a name/alias → contact JID(s) |
| GET    | `/contacts/aliases`           | List manual aliases from `contacts_aliases.txt` |
| GET    | `/send/whitelist`             | Allowed chats for sending (read-only) |
| POST   | `/chats/:id/messages`         | Send a message (requires `sendEnabled` AND target in whitelist) |

Chat IDs look like `5511999999999@s.whatsapp.net` (DM, traditional), `<digits>@lid` (DM, modern LID), or `120363xxxxxxxxxxxx@g.us` (group).

## Resolving a name → JID

When the user references a person by name ("o Fulano me pediu algo recentemente?", "confirma com Fulano o horário"), do NOT guess the JID. Resolve it:

```
GET {baseUrl}/contacts?q=fulano
```

Response shape: `{ query, results: [{ jid, name, pushName, notifyName, verifiedName, lastSeenAt, hasDm, matchedVia }] }`.

- `matchedVia: "alias"` — came from the user's `contacts_aliases.txt`. Treat as the user's explicit intent; prefer this match.
- `matchedVia: "contact"` — substring match on a name the service has observed. May be ambiguous.

How to use the results:

1. **Zero matches** — tell the user no contact matched and offer to (a) add an alias in `contacts_aliases.txt` (e.g. `fulano = 5511999...@s.whatsapp.net`), or (b) try a different name. Do NOT edit the aliases file yourself.
2. **One match** — proceed, but confirm with the user before taking any action that writes (sending a message, marking read). For pure reads ("o que ele me mandou?"), use the JID directly and mention who you resolved to.
3. **Multiple matches** — show the candidates (`name` + last 4 digits of the JID + `lastSeenAt`) and ask the user which one. Don't pick silently.

For sending, after resolving: also check `hasDm` — if 0 and the JID is a `@g.us`, the user is targeting a group; confirm explicitly.

## Sending messages

If the user asks to send a WhatsApp message:
1. Check `health.sendEnabled`. If false, tell the user it is disabled and they need to set `ENABLE_SEND=true` in `.env` and restart — do NOT try to enable it for them.
2. Check `GET /send/whitelist`. If the target chat ID is not in `allowed`, tell the user the chat must be added to the whitelist. Easiest way for them: `npm run wl` inside the `whatsapp-bridge` repo (interactive picker). They can also edit `send_whitelist.txt` directly. The file reloads automatically. Do NOT modify the whitelist yourself — it is a security boundary the user owns.
3. Confirm the target chat and the exact text with the user before posting. Do not send without confirmation.
4. `POST /chats/:id/messages` with JSON body `{"text": "..."}`. A 403 mentioning `send_whitelist.txt` means the whitelist rejected it — surface that message to the user verbatim.

In `mode: "extension"`, the send is enqueued and executed by the browser tab. The response is `200 {ok:true}` once the tab confirms, or `202 {pending:true}` if the WhatsApp Web tab didn't confirm within a few seconds — in that case tell the user to make sure the WhatsApp Web tab (with the extension) is open; the message is queued and will go out when the tab is back.

## Backfilling history before a summary (extension mode only)

The service only stores messages it observed live. If the WhatsApp Web tab or the service were closed for a while, those messages are a gap in `data/messages.db`. Before summarizing or reading a full conversation, consider backfilling:

```
POST {baseUrl}/chats/<jid>/backfill   body: {"since": <ms>}   # since optional; omit/0 = as far back as possible (capped)
```

- The browser tab re-fetches the chat's history from WhatsApp Web's local store and re-ingests it (duplicates are ignored). Then read `/chats/:id/messages` as usual.
- Response: `200 {ingested: N}` once done, or `202 {pending: true}` if it's still running — in that case wait a couple seconds and read the messages anyway.
- `503 no WhatsApp Web tab connected` means no tab is open — tell the user to open WhatsApp Web with the extension; backfill needs the live tab.
- **Limits:** only history WhatsApp Web has itself synced from the phone is recoverable (a recent window, not the entire chat lifetime); media isn't downloaded; and a message edited/deleted during downtime comes back in its current state. The service also auto-backfills unread chats whenever the tab reconnects, so the gap often fills on its own.

When the user asks for a summary of a conversation and reads look thin or there's a known downtime, backfill first (`since` = roughly when the gap started, in ms), then read and summarize.

## How to call (Bash on Git Bash / WSL / macOS / Linux)

```bash
TOKEN=$(jq -r .apiToken ~/.whatsapp-bridge/config.json)
BASE=$(jq -r .baseUrl ~/.whatsapp-bridge/config.json)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/chats?limit=10"
```

If `jq` is unavailable, read the JSON with `cat` and parse the fields with a small inline Node/python one-liner.

## How to call (PowerShell)

```powershell
$cfg = Get-Content "$HOME/.whatsapp-bridge/config.json" | ConvertFrom-Json
Invoke-RestMethod -Uri "$($cfg.baseUrl)/chats?limit=10" -Headers @{ Authorization = "Bearer $($cfg.apiToken)" }
```

## Output style

- Timestamps come as Unix ms. Convert to the user's local time when displaying.
- For chat listings, show name (or ID if name is missing), unread count, and time of last message.
- For message listings, show `sender (or "me") — time — body`. Trim long bodies to ~200 chars unless asked for full content.
- Messages can carry `deletedAt` and `editedAt`/`originalBody`. When `deletedAt` is set the message was deleted for everyone but the original `body` is preserved — flag it, e.g. "(apagada pelo remetente)". When `editedAt` is set, `body` is the latest text and `originalBody` (if present) is what was sent first — mention it was edited and show the original if relevant. A message with `type: "reaction"` is someone reacting with the emoji in `body` (empty body = the reaction was removed).
- Group chat senders include the participant JID; render the part before `@` unless a name is available.
