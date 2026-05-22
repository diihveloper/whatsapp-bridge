---
name: whatsapp-read
description: Read WhatsApp messages, list chats, and search history via the local whatsapp-bridge service. Use when the user asks about WhatsApp messages, "what did X say on WhatsApp", "any unread WhatsApp", "search WhatsApp for Y", "send a WhatsApp to X", or anything involving WhatsApp conversations.
---

# whatsapp-read

Talks to a local service (`whatsapp-bridge`) that holds a logged-in WhatsApp session and persists incoming messages.

## Use the `wa` CLI (primary interface)

A bundled CLI does the heavy lifting — it reads the config, authenticates, resolves names → JIDs, optionally backfills, and prints clean output (local times, resolved sender names, deleted/edited flags). **Prefer it over raw HTTP calls.** It lives next to this file; when the skill is installed it's at `~/.claude/skills/whatsapp-read/wa.mjs`:

```bash
node ~/.claude/skills/whatsapp-read/wa.mjs <command>
```

Commands:

| Command | What it does |
|---------|--------------|
| `wa health` | Service status: mode, connection, sending on/off, counts. **Run this first.** |
| `wa read <name\|jid> [--limit N] [--since <ISO\|ms>] [--days N] [--backfill]` | Resolve a name → read the conversation. `--backfill` re-fetches history first (needs the tab open). |
| `wa search <text...> [--limit N]` | Full-text search across all messages. |
| `wa chats [--unread] [--limit N]` | List chats, newest first. |
| `wa digest [--summarize] [--limit N]` | Group unread chats with their recent messages. Without `--summarize` it prints the structured data **for you to summarize**; `--summarize` returns server-side prose (only if `SUMMARY_PROVIDER` is set). |
| `wa pending [--hours N] [--dm]` | Chats waiting on a reply from the user for more than N hours (default 3), oldest-waiting first. `--dm` = DMs only. |
| `wa alerts [--limit N]` | Recent keyword-watchlist hits (terms in `watchlist.txt`). |
| `wa mentions [--limit N] [--days N]` | Messages that @-mentioned the user (mostly groups). |
| `wa export <name\|jid> [--days N] [--limit N] [--out file.md]` | Markdown transcript of a conversation (to stdout or a file). Feed it to the document skill for an LI-styled doc. |
| `wa media <msgId> [--out file]` | Re-download a message's media (image/doc/audio) from WhatsApp and save it locally, so you can open/analyze the actual file. Get the `msgId` from `wa read --json`. Needs the WhatsApp Web tab open. |
| `wa who <name\|jid>` | Resolve a name → JID without reading messages. |
| `wa send <name\|jid> <text...> [--file <path\|url>] [--caption "..."] [--reply <msgId>]` | Send text, a quoted reply (`--reply`), or a media file (`--file`, from disk or URL). Gated — see "Sending". |
| `wa aliases` / `wa aliases add <name> <jid>` / `wa aliases rm <name>` | Manage name→JID aliases. |

Add `--json` to any command to get the raw JSON (use it when you need exact fields/JIDs to act on programmatically).

Examples:

```bash
node ~/.claude/skills/whatsapp-read/wa.mjs health
node ~/.claude/skills/whatsapp-read/wa.mjs read "fulano" --days 7
node ~/.claude/skills/whatsapp-read/wa.mjs read "fulano" --backfill        # before summarizing, to fill gaps
node ~/.claude/skills/whatsapp-read/wa.mjs search "boleto" --limit 10
node ~/.claude/skills/whatsapp-read/wa.mjs chats --unread
```

### Reading the output

- **`wa health` shows the service state.** In `mode: extension` the WhatsApp connection lives in a Chrome tab; `connected` reflects whether that tab is live. If it's `disconnected` or reads look stale/empty, tell the user to open/refresh the WhatsApp Web tab (and scan the QR / log back in if the tab state is `needs_auth`/`logged_out`). In `mode: baileys`, a disconnected state usually means the QR needs scanning in the service terminal.
- **Name resolution is built in.** `wa read`/`wa who`/`wa send` resolve the name themselves. If the name is **ambiguous**, the CLI prints the candidates and does nothing — show those to the user and ask which one (then re-run with the exact JID). If there's **no match**, offer to add an alias (`wa aliases add ...`) or try another name — but confirm the JID with the user first; don't guess.
- **Messages may be flagged.** A line ending in `(editada)` was edited; `[apagada]` means it was deleted for everyone but the original text is preserved (you can mention it was deleted). `eu:` is the user; group lines show the sender's name.
- **Media may be transcribed.** If audio transcription / image OCR is enabled (see `wa health` → `media:`), voice notes show as `🎙️ <transcrição>` and images as `🖼️ <texto/descrição>` — the text is the transcript/OCR folded into the message (and it's full-text searchable). `🎙️` / `🖼️` / `📎` with no text means the media wasn't processed (provider off, still downloading — `(processando…)`, or `(falha ao processar)`). Stored files can be fetched at `GET /chats/:id/messages/:msgId/media` when `STORE_MEDIA` keeps them.
- Timestamps are already local. Trim very long message bodies when summarizing.

### Digest, pendentes e alertas

- **"Me resume o WhatsApp" / "o que tenho de não lido":** rode `wa digest`. Sem `--summarize` ele imprime as conversas não lidas agrupadas — **você (o modelo) escreve o resumo** a partir disso, destacando o que pede ação. Use `--summarize` só se o usuário quiser o resumo gerado pelo próprio serviço (requer `SUMMARY_PROVIDER`). Ótimo para um agente agendado (`/schedule`) de "bom dia" às 8h.
- **"Quem está esperando resposta" / "esqueci de responder alguém":** `wa pending` (padrão > 3h sem resposta nossa). `--hours N` ajusta a janela, `--dm` ignora grupos.
- **Alertas de palavra-chave:** `wa alerts` mostra os termos batidos (definidos pelo usuário em `watchlist.txt`). Os canais de aviso (WhatsApp/webhook) são configurados no `.env` pelo usuário — não tente configurá-los você.
- **"Onde me marcaram":** `wa mentions` lista as mensagens em que você foi @-mencionado (principalmente em grupos).
- **Exportar conversa pra documento:** `wa export <nome> --out conversa.md` gera um Markdown da conversa. Para um documento no padrão Loja Interativa, rode o export e depois use a skill **edicao-documentos-loja-interativa** com esse conteúdo (.docx/PDF).
- **Analisar uma imagem/arquivo recebido:** mensagens de mídia aparecem como `🖼️`/`📎` sem o conteúdo. Para ver/analisar o arquivo de verdade, pegue o `id` da mensagem (`wa read <nome> --json`) e rode `wa media <id> --out arquivo.ext` — ele re-baixa a mídia do WhatsApp e salva localmente (precisa da aba aberta; a mídia precisa ainda existir no WhatsApp). Depois você pode ler/analisar o arquivo salvo.

### Sending

1. `wa health` — if `sending: off`, tell the user it's disabled and they must set `ENABLE_SEND=true` in `.env` and restart the service. Do NOT try to enable it.
2. Confirm the target chat and exact text with the user **before** sending. Never send without confirmation.
3. `wa send <name|jid> "<text>"`. The CLI resolves the name and posts. A failure mentioning the whitelist means the target isn't allowed — tell the user to add it via `npm run wl` or `send_whitelist.txt` (the assistant must NOT edit the whitelist; it's a security boundary the user owns). A `Queued…` result means the WhatsApp Web tab didn't confirm in time — tell the user to make sure it's open.
4. **Reply / media:** add `--reply <msgId>` to quote a specific message (get the id from `wa read --json`), or `--file <path|url>` (with optional `--caption`) to send an image/PDF/anchor file from disk or a URL. Same whitelist gate. (Quoting works in extension mode; baileys mode sends without the quote.)

## Setup notes

- Config lives at `~/.whatsapp-bridge/config.json` (`baseUrl` + `apiToken`); the CLI reads it automatically. You can override with env `WA_BRIDGE_URL` / `WA_BRIDGE_TOKEN`.
- If the CLI says it can't reach the service, it isn't running — tell the user to run `npm start` in the `whatsapp-bridge` repo.

## Low-level HTTP API (fallback / reference)

The CLI wraps these. Use them directly only if the CLI is unavailable. Every request needs `Authorization: Bearer <apiToken>` (from the config file) except `/health`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | `{ ok, mode, connected, hasQR, sendEnabled, media:{transcribe,ocr,store}, messages, chats, contacts }` (+ `extension:{state}` in extension mode) |
| GET | `/conversation?name=<name\|jid>&limit=N&since=<ms>&days=<n>&backfill=true` | Resolve + (optionally backfill) + read in one call. Returns `{ found, target, messages }` or `{ found:false, ambiguous, candidates }` |
| GET | `/chats?limit=20&unread=true` | List chats, newest first |
| GET | `/chats/:id/messages?limit=50&since=<ms>` | Messages in a chat (oldest→newest); each carries `senderName`, `deletedAt`, `editedAt`, `originalBody`, `mediaPath`, `mediaMime`, `mediaStatus` |
| GET | `/chats/:id/messages/:msgId/media` | Download a stored media file (audio/image/document) when `STORE_MEDIA` keeps it |
| POST | `/messages/:msgId/fetch-media` | Re-download a past message's media from WhatsApp and store it (forces persistence even if `STORE_MEDIA=off`). Returns a `url` to fetch it |
| GET | `/messages/:msgId/media` | Download the stored media file by message id alone |
| POST | `/chats/:id/backfill` | Body `{ since?, max? }` — re-fetch history (extension mode, tab open) |
| GET | `/search?q=<text>&limit=20` | Full-text search |
| GET | `/digest?limit=30&summarize=true` | Unread chats + recent messages grouped. `summarize=true` adds server-side prose if `SUMMARY_PROVIDER` is set; else returns `{ summaryError }` (summarize the structured `chats` yourself). |
| GET | `/pending?hours=3&limit=50&groups=false` | Chats waiting on the user's reply for >N hours, oldest first |
| GET | `/alerts?limit=30` | Recent keyword-watchlist hits + active `keywords`/`channels` |
| GET | `/mentions?limit=30&days=N` | Messages that @-mentioned the user |
| POST | `/chats/:id/read` | Mark chat as read |
| GET | `/contacts?q=<text>` | Resolve a name/alias → contact JID(s) |
| GET | `/contacts/aliases` | List aliases |
| POST | `/contacts/aliases` | Body `{ alias, jid }` — add/update an alias |
| DELETE | `/contacts/aliases/:alias` | Remove an alias |
| GET | `/send/whitelist` | Allowed chats for sending (read-only) |
| POST | `/chats/:id/messages` | Send `{ text }`, a reply `{ text, quotedMsgId }`, or media `{ media:{path\|url}, caption?, quotedMsgId? }` (requires `sendEnabled` AND target in whitelist) |

Chat IDs are JIDs: `<digits>@s.whatsapp.net` (DM), `<digits>@lid` (DM, modern LID), `<digits>@g.us` (group).

```bash
TOKEN=$(jq -r .apiToken ~/.whatsapp-bridge/config.json)
BASE=$(jq -r .baseUrl ~/.whatsapp-bridge/config.json)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/conversation?name=fulano&days=7"
```

```powershell
$cfg = Get-Content "$HOME/.whatsapp-bridge/config.json" | ConvertFrom-Json
Invoke-RestMethod -Uri "$($cfg.baseUrl)/chats?limit=10" -Headers @{ Authorization = "Bearer $($cfg.apiToken)" }
```
