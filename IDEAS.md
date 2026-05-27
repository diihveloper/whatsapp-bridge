# Ideias futuras

Backlog de ideias ainda não implementadas. Cada item descreve o "o quê", o "por quê" e um esboço do "como", o suficiente pra alguém pegar e implementar depois.

## ✅ Mídia: transcrição de áudio, OCR de imagem e download de documento — IMPLEMENTADO

> Implementado em maio/2026. Pipeline de mídia **pluggável e off por padrão**, escolhido via `.env` (`TRANSCRIBE_PROVIDER`, `OCR_PROVIDER`, `STORE_MEDIA` + chaves). Núcleo em `src/media/` (dispatcher + provedores; nuvem usa só `fetch`, locais via `import()` dinâmico opcional). `src/media/process.js` orquestra persistir → transcrever/OCR → `setMediaText` (dobra o texto no `body`, então entra no FTS). Captura: extensão baixa bytes (`WPP.chat.downloadMedia`) e POSTa em `/media`; baileys baixa via `downloadMediaMessage`. Colunas novas em `messages`: `media_path`/`media_mime`/`media_status`. Download via `GET /chats/:id/messages/:msgId/media`. **Atualização (maio/2026):** download sob demanda implementado — `POST /messages/:msgId/fetch-media` + `wa media <msgId>` re-baixam a mídia de uma mensagem antiga do WhatsApp (via `WPP.chat.downloadMedia` por SSE) e guardam com `forceStore`, mesmo com `STORE_MEDIA=off`. **Pendências/ideias futuras:** (a) transcrição de áudio também no envio; (b) processar mídia em lote no backfill.

## ✅ Digest de não-lidas, pendentes de resposta e watchlist de alertas — IMPLEMENTADO

> Implementado em maio/2026. **Digest** (`GET /digest`, `wa digest`): agrupa não-lidas + mensagens recentes; estruturado por padrão (quem chama resume — sessão do Claude ou agente `/schedule`), com `--summarize` opcional via `src/ai.js` (`SUMMARY_PROVIDER` plugável). **Pendentes** (`GET /pending`, `wa pending`): chats cuja última mensagem é deles e está sem resposta há > N horas. **Watchlist** (`watchlist.txt` + `src/watchlist.js` + `src/alerts.js`, `GET /alerts`, `wa alerts`): match de palavra-chave no `/ingest`/baileys → grava em `alerts` e dispara canais (`ALERT_WHATSAPP_TO`, `ALERT_WEBHOOK_URL`), só pra mensagens recentes (não dispara em backfill). **Ideias futuras:** (a) digest por chat individual; (b) marcar pendente como "resolvido"/snooze; (c) per-message read state real (hoje "não lida" é aproximada pelo contador `unread` do chat).

## ✅ Reply citando, envio de mídia, export e @menções — IMPLEMENTADO

> Implementado em maio/2026. **Envio de mídia + reply** (`POST /chats/:id/messages` aceita `media:{path|url}`, `caption`, `quotedMsgId`): `outbound` ganhou `kind`/`media_path`/`mime`/`filename`/`caption`/`quoted_msg_id`; servidor faz staging (URL → `data/outbound_media/`), `hydrateSends` injeta base64 só na hora do envio. Extensão usa `WPP.chat.sendFileMessage`/`sendTextMessage` com `quotedMsg`; baileys envia mídia via `sendMedia` (sem quote). **@menções** (`mentions_me` em `messages`, `GET /mentions`, `wa mentions`): extensão compara `mentionedJidList` com `getMaybeMeUser()`, baileys com `contextInfo.mentionedJid`. **Export** (`wa export`): Markdown da conversa pra alimentar a skill `edicao-documentos-loja-interativa`. **Ideias futuras:** (a) envio agendado (coluna `send_after` + tick) — ponto 7 ainda pendente; (b) quote no modo baileys; (c) menções como alerta/digest.

## ✅ Anti-delete com flag — IMPLEMENTADO

> Implementado em maio/2026. `messages` ganhou `deleted_at` (anti-delete, via `markDeleted`) e `edited_at`/`original_body` (rastreio de edição, via `applyEdit`). Modo `extension` captura `chat.msg_revoke` (→ `revokes`) e `chat.msg_edited` (→ `edits`) e os envia no `/ingest`. **Pendente:** o modo `baileys` ainda não trata `protocolMessage`/`REVOKE` nem `messages.update` — só o backend de extensão faz anti-delete/edição por enquanto.

**O quê:** quando alguém apaga uma mensagem "para todos", manter o texto original no banco (como já acontece hoje) **mas marcá-la com uma flag** indicando que houve tentativa de deleção — em vez de simplesmente ignorar o evento.

**Por quê:** hoje a ponte não processa deleções (revokes), então a mensagem original permanece no `data/messages.db` sem nenhuma indicação de que foi apagada. Para consulta/resumo isso é ótimo (funciona como log anti-delete), mas você não consegue saber *que* uma mensagem foi apagada. Uma flag dá o melhor dos dois mundos: preserva o conteúdo **e** sinaliza a deleção.

**Como (esboço):**

- **Store** (`src/store.js`): adicionar coluna `deleted_at INTEGER` (e/ou `deleted_by_sender INTEGER DEFAULT 0`) na tabela `messages`. Migração defensiva (a tabela já existe em bancos antigos): verificar via `PRAGMA table_info(messages)` e rodar `ALTER TABLE messages ADD COLUMN ...` se faltar. Nova função `markDeleted(id, { at })` que faz `UPDATE` mantendo o `body` intacto.
- **Captura do revoke:**
  - Modo `extension` (`extension/inject.js`): assinar o evento de revoke do wa-js (ex.: `WPP.on('chat.msg_revoke', ...)` — confirmar o nome exato na versão instalada) e postar pro `bridge.js` algo como `{ kind: 'revoke', id }`. O `bridge.js` manda pra um novo campo do `/ingest` (ex.: `revokes: [id]`) ou um endpoint dedicado.
  - Modo `baileys` (`src/whatsapp.js`): tratar o `protocolMessage` com `type = REVOKE` (ele carrega a `key` da mensagem revogada) e/ou o evento `messages.update`.
- **Servidor** (`src/server.js`): aceitar os ids revogados no `/ingest` e chamar `markDeleted`.
- **API + skill:** incluir a flag (ex.: `deleted: true`) na resposta de `/chats/:id/messages` e documentar no `skill/whatsapp-assistant/SKILL.md` pra o Claude poder dizer "(esta mensagem foi apagada pelo remetente)".

**Origem:** ideia que surgiu testando deleção — o "Oi" apagado pelo Breno permaneceu no histórico sem marcação.
