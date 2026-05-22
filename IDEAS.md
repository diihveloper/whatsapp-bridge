# Ideias futuras

Backlog de ideias ainda não implementadas. Cada item descreve o "o quê", o "por quê" e um esboço do "como", o suficiente pra alguém pegar e implementar depois.

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
- **API + skill:** incluir a flag (ex.: `deleted: true`) na resposta de `/chats/:id/messages` e documentar no `skill/whatsapp-read/SKILL.md` pra o Claude poder dizer "(esta mensagem foi apagada pelo remetente)".

**Origem:** ideia que surgiu testando deleção — o "Oi" apagado pelo Breno permaneceu no histórico sem marcação.
