import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'messages.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    name TEXT,
    is_group INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER,
    unread INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    sender TEXT,
    body TEXT,
    timestamp INTEGER NOT NULL,
    from_me INTEGER NOT NULL DEFAULT 0,
    type TEXT,
    FOREIGN KEY (chat_id) REFERENCES chats(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat_ts
    ON messages(chat_id, timestamp DESC);

  CREATE INDEX IF NOT EXISTS idx_messages_ts
    ON messages(timestamp DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(body, content='messages', content_rowid='rowid');

  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
  END;

  -- Edits rewrite messages.body in place (see applyEdit), so the FTS index must
  -- be re-synced on UPDATE too — the AI/AD triggers only cover INSERT/DELETE.
  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF body ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
    INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
  END;

  CREATE TABLE IF NOT EXISTS contacts (
    jid TEXT PRIMARY KEY,
    push_name TEXT,
    notify_name TEXT,
    verified_name TEXT,
    last_seen_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_last_seen
    ON contacts(last_seen_at DESC);

  -- Outbound send queue. With the extension bridge the WhatsApp connection lives
  -- in the browser, not here, so the server can't push directly: it enqueues and
  -- the extension drains this table via GET /outbound.
  CREATE TABLE IF NOT EXISTS outbound (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT NOT NULL,
    text        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending', -- pending | sending | sent | error
    error       TEXT,
    wa_msg_id   TEXT,
    created_at  INTEGER NOT NULL,
    claimed_at  INTEGER,
    updated_at  INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_outbound_status
    ON outbound(status, id);

  -- Keyword watchlist hits. One row per (message, keyword); UNIQUE so a
  -- re-delivered message never fires a second notification. recordAlert returns
  -- whether the row was new, which gates the push.
  CREATE TABLE IF NOT EXISTS alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id      TEXT NOT NULL,
    chat_id     TEXT,
    keyword     TEXT NOT NULL,
    body        TEXT,
    matched_at  INTEGER NOT NULL,
    UNIQUE(msg_id, keyword)
  );

  CREATE INDEX IF NOT EXISTS idx_alerts_matched
    ON alerts(matched_at DESC);
`);

// Defensive migration: messages already exists in older DBs, so add the
// anti-delete / edit-tracking columns only if they're missing.
//  - deleted_at:    ms when a "delete for everyone" was observed (body kept).
//  - edited_at:     ms of the last edit (NULL = never edited).
//  - original_body: the pre-edit text, preserved on the first edit only.
function ensureColumn(table, column, decl) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
ensureColumn('messages', 'deleted_at', 'INTEGER');
ensureColumn('messages', 'edited_at', 'INTEGER');
ensureColumn('messages', 'original_body', 'TEXT');
// Media handling (audio transcription / image OCR / document download):
//  - media_path:   relative path under data/media/ of the stored raw file (NULL
//                  if not persisted — STORE_MEDIA policy decides).
//  - media_mime:   the file's MIME type (so the download endpoint can serve it).
//  - media_status: NULL (not media / nothing to do) | 'pending' | 'done' |
//                  'error' | 'skipped'. Tracks the transcription/OCR lifecycle.
ensureColumn('messages', 'media_path', 'TEXT');
ensureColumn('messages', 'media_mime', 'TEXT');
ensureColumn('messages', 'media_status', 'TEXT');
// @mention tracking: 1 when the message @-mentions the account owner (groups).
ensureColumn('messages', 'mentions_me', 'INTEGER');
// Outbound media/quote support (older DBs created `outbound` text-only).
ensureColumn('outbound', 'kind', "TEXT");          // 'text' | 'media' (NULL = text)
ensureColumn('outbound', 'media_path', 'TEXT');    // server-side file to send
ensureColumn('outbound', 'mime', 'TEXT');
ensureColumn('outbound', 'filename', 'TEXT');
ensureColumn('outbound', 'caption', 'TEXT');
ensureColumn('outbound', 'quoted_msg_id', 'TEXT'); // reply target (WA _serialized id)

db.prepare(`
  INSERT OR IGNORE INTO contacts (jid, push_name, last_seen_at)
  SELECT id, name, last_message_at FROM chats
  WHERE is_group = 0 AND name IS NOT NULL
`).run();

const upsertChatStmt = db.prepare(`
  INSERT INTO chats (id, name, is_group, last_message_at, unread)
  VALUES (@id, @name, @isGroup, @lastMessageAt, @unread)
  ON CONFLICT(id) DO UPDATE SET
    name = COALESCE(excluded.name, chats.name),
    is_group = excluded.is_group,
    last_message_at = MAX(COALESCE(chats.last_message_at, 0), excluded.last_message_at),
    unread = excluded.unread
`);

const insertMessageStmt = db.prepare(`
  INSERT OR IGNORE INTO messages (id, chat_id, sender, body, timestamp, from_me, type, mentions_me)
  VALUES (@id, @chatId, @sender, @body, @timestamp, @fromMe, @type, @mentionsMe)
`);

const saveMessageTx = db.transaction((msg) => {
  upsertChatStmt.run({
    id: msg.chatId,
    name: msg.chatName ?? null,
    isGroup: msg.chatId.endsWith('@g.us') ? 1 : 0,
    lastMessageAt: msg.timestamp,
    unread: msg.fromMe ? 0 : 1,
  });
  insertMessageStmt.run({
    id: msg.id,
    chatId: msg.chatId,
    sender: msg.sender ?? null,
    body: msg.body ?? '',
    timestamp: msg.timestamp,
    fromMe: msg.fromMe ? 1 : 0,
    type: msg.type ?? null,
    mentionsMe: msg.mentionsMe ? 1 : 0,
  });
});

export function saveMessage(msg) {
  saveMessageTx(msg);
}

// Anti-delete: a "delete for everyone" keeps the original body and just flags
// the row. No-op if we never stored the message (e.g. it predates this DB).
const markDeletedStmt = db.prepare(
  `UPDATE messages SET deleted_at = @at WHERE id = @id AND deleted_at IS NULL`
);
export function markDeleted(id, { at = Date.now() } = {}) {
  if (!id) return;
  markDeletedStmt.run({ id: String(id), at });
}

// Edit tracking: preserve the pre-edit text in original_body on the *first*
// edit (COALESCE keeps it across later edits), overwrite body with the new
// text, and stamp edited_at. The messages_au trigger keeps FTS in sync.
const applyEditStmt = db.prepare(`
  UPDATE messages
  SET original_body = COALESCE(original_body, body),
      body = @body,
      edited_at = @at
  WHERE id = @id AND body IS NOT @body
`);
export function applyEdit({ id, body, at = Date.now() } = {}) {
  if (!id) return;
  applyEditStmt.run({ id: String(id), body: body ?? '', at });
}

// ── Media: persistence + transcription/OCR results ──────────────────────────
// Record where the raw file was stored (or just flag it as pending processing
// when nothing is persisted). No-op if the message isn't in the DB yet.
const attachMediaStmt = db.prepare(`
  UPDATE messages SET media_path = @path, media_mime = @mime, media_status = @status
  WHERE id = @id
`);
export function attachMedia(id, { path = null, mime = null, status = 'pending' } = {}) {
  if (!id) return;
  attachMediaStmt.run({ id: String(id), path, mime, status });
}

// Fold the transcription/OCR text into body so it shows up in reads AND gets
// FTS-indexed (the messages_au UPDATE-of-body trigger reindexes). We keep a
// short type tag prefix so a reader still knows it originated as audio/image.
const setMediaTextStmt = db.prepare(`
  UPDATE messages SET body = @body, media_status = @status WHERE id = @id
`);
export function setMediaText(id, body, { status = 'done' } = {}) {
  if (!id) return;
  setMediaTextStmt.run({ id: String(id), body: body ?? '', status });
}

const setMediaStatusStmt = db.prepare(`UPDATE messages SET media_status = @status WHERE id = @id`);
export function setMediaStatus(id, status) {
  if (!id) return;
  setMediaStatusStmt.run({ id: String(id), status });
}

// Used by the download endpoint and the processing pipeline to look up a row.
export function getMessageById(id) {
  return db.prepare(`
    SELECT id, chat_id AS chatId, sender, body, timestamp, from_me AS fromMe, type,
           media_path AS mediaPath, media_mime AS mediaMime, media_status AS mediaStatus
    FROM messages WHERE id = ?
  `).get(String(id));
}

// Rename only: must NOT touch unread or last_message_at (a title refresh isn't
// a read receipt and isn't new activity). COALESCE keeps the old name if a null
// slips in. Overwrites with a real new name, so renames are picked up.
const renameChatStmt = db.prepare(`
  INSERT INTO chats (id, name, is_group, unread)
  VALUES (@id, @name, @isGroup, 0)
  ON CONFLICT(id) DO UPDATE SET
    name = COALESCE(excluded.name, chats.name),
    is_group = excluded.is_group
`);

export function updateChatName(chatId, name) {
  if (!name) return;
  renameChatStmt.run({
    id: chatId,
    name,
    isGroup: chatId.endsWith('@g.us') ? 1 : 0,
  });
}

export function markChatRead(chatId) {
  db.prepare('UPDATE chats SET unread = 0 WHERE id = ?').run(chatId);
}

export function listChats({ limit = 20, onlyUnread = false } = {}) {
  const where = onlyUnread ? 'WHERE unread > 0' : '';
  return db.prepare(`
    SELECT id, name, is_group AS isGroup, last_message_at AS lastMessageAt, unread
    FROM chats
    ${where}
    ORDER BY last_message_at DESC NULLS LAST
    LIMIT ?
  `).all(limit);
}

export function getMessages(chatId, { limit = 50, since } = {}) {
  const params = [chatId];
  let sinceClause = '';
  if (since) {
    sinceClause = 'AND timestamp >= ?';
    params.push(since);
  }
  params.push(limit);
  return db.prepare(`
    SELECT m.id, m.chat_id AS chatId, m.sender,
           COALESCE(ct.verified_name, ct.notify_name, ct.push_name) AS senderName,
           m.body, m.timestamp, m.from_me AS fromMe, m.type,
           m.deleted_at AS deletedAt, m.edited_at AS editedAt, m.original_body AS originalBody,
           m.media_path AS mediaPath, m.media_mime AS mediaMime, m.media_status AS mediaStatus
    FROM messages m
    LEFT JOIN contacts ct ON ct.jid = m.sender
    WHERE m.chat_id = ? ${sinceClause.replace('timestamp', 'm.timestamp')}
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(...params).reverse();
}

export function searchMessages(query, { limit = 20 } = {}) {
  return db.prepare(`
    SELECT m.id, m.chat_id AS chatId, c.name AS chatName, m.sender, m.body,
           m.timestamp, m.from_me AS fromMe,
           m.deleted_at AS deletedAt, m.edited_at AS editedAt
    FROM messages_fts f
    JOIN messages m ON m.rowid = f.rowid
    LEFT JOIN chats c ON c.id = m.chat_id
    WHERE messages_fts MATCH ?
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(query, limit);
}

export function stats() {
  const msg = db.prepare('SELECT COUNT(*) AS n FROM messages').get();
  const chat = db.prepare('SELECT COUNT(*) AS n FROM chats').get();
  const contact = db.prepare('SELECT COUNT(*) AS n FROM contacts').get();
  return { messages: msg.n, chats: chat.n, contacts: contact.n };
}

// High-water mark for auto-backfill: the newest message we've stored. The
// extension refills everything after this on reconnect, closing the downtime
// gap. NULL (fresh DB) → caller picks a default window.
export function lastMessageTimestamp() {
  const row = db.prepare('SELECT MAX(timestamp) AS ts FROM messages').get();
  return row?.ts ?? null;
}

const upsertContactStmt = db.prepare(`
  INSERT INTO contacts (jid, push_name, notify_name, verified_name, last_seen_at)
  VALUES (@jid, @pushName, @notifyName, @verifiedName, @lastSeenAt)
  ON CONFLICT(jid) DO UPDATE SET
    push_name     = COALESCE(excluded.push_name, contacts.push_name),
    notify_name   = COALESCE(excluded.notify_name, contacts.notify_name),
    verified_name = COALESCE(excluded.verified_name, contacts.verified_name),
    last_seen_at  = MAX(COALESCE(contacts.last_seen_at, 0), COALESCE(excluded.last_seen_at, 0))
`);

export function upsertContact({ jid, pushName, notifyName, verifiedName, lastSeenAt }) {
  if (!jid) return;
  upsertContactStmt.run({
    jid,
    pushName: pushName ?? null,
    notifyName: notifyName ?? null,
    verifiedName: verifiedName ?? null,
    lastSeenAt: lastSeenAt ?? null,
  });
}

export function searchContacts(query, { limit = 20 } = {}) {
  const like = `%${String(query).toLowerCase()}%`;
  return db.prepare(`
    SELECT c.jid,
           COALESCE(c.verified_name, c.notify_name, c.push_name) AS name,
           c.push_name     AS pushName,
           c.notify_name   AS notifyName,
           c.verified_name AS verifiedName,
           c.last_seen_at  AS lastSeenAt,
           CASE WHEN EXISTS (
             SELECT 1 FROM chats
             WHERE chats.id = c.jid AND chats.is_group = 0
           ) THEN 1 ELSE 0 END AS hasDm
    FROM contacts c
    WHERE lower(COALESCE(c.push_name, ''))     LIKE ?
       OR lower(COALESCE(c.notify_name, ''))   LIKE ?
       OR lower(COALESCE(c.verified_name, '')) LIKE ?
    ORDER BY c.last_seen_at DESC NULLS LAST
    LIMIT ?
  `).all(like, like, like, limit);
}

const enqueueSendStmt = db.prepare(`
  INSERT INTO outbound (chat_id, text, kind, media_path, mime, filename, caption, quoted_msg_id, created_at)
  VALUES (@chatId, @text, @kind, @mediaPath, @mime, @filename, @caption, @quotedMsgId, @now)
`);

export function enqueueSend({
  chatId, text = '', kind = 'text',
  mediaPath = null, mime = null, filename = null, caption = null, quotedMsgId = null,
}) {
  const info = enqueueSendStmt.run({
    chatId, text, kind, mediaPath, mime, filename, caption, quotedMsgId, now: Date.now(),
  });
  return Number(info.lastInsertRowid);
}

// Atomically hand pending rows to the extension and mark them 'sending', so two
// concurrent polls never claim the same send. Stale 'sending' rows (extension
// crashed mid-send) are re-eligible after staleMs.
const claimPendingTx = db.transaction((limit, staleMs) => {
  const cutoff = Date.now() - staleMs;
  const rows = db.prepare(`
    SELECT id, chat_id AS chatId, text,
           COALESCE(kind, 'text') AS kind, media_path AS mediaPath, mime, filename,
           caption, quoted_msg_id AS quotedMsgId
    FROM outbound
    WHERE status = 'pending'
       OR (status = 'sending' AND COALESCE(claimed_at, 0) < ?)
    ORDER BY id ASC
    LIMIT ?
  `).all(cutoff, limit);
  const mark = db.prepare(`UPDATE outbound SET status = 'sending', claimed_at = ? WHERE id = ?`);
  const now = Date.now();
  for (const r of rows) mark.run(now, r.id);
  return rows;
});

export function claimPending({ limit = 20, staleMs = 60_000 } = {}) {
  return claimPendingTx(limit, staleMs);
}

const markSendResultStmt = db.prepare(`
  UPDATE outbound
  SET status = @status, error = @error, wa_msg_id = @waMsgId, updated_at = @now
  WHERE id = @id
`);

export function markSendResult(id, { ok, error = null, waMsgId = null } = {}) {
  markSendResultStmt.run({
    id,
    status: ok ? 'sent' : 'error',
    error: error ? String(error) : null,
    waMsgId,
    now: Date.now(),
  });
}

export function getSend(id) {
  return db.prepare(`
    SELECT id, chat_id AS chatId, text, status, error, wa_msg_id AS waMsgId,
           COALESCE(kind, 'text') AS kind, media_path AS mediaPath, mime, filename,
           caption, quoted_msg_id AS quotedMsgId,
           created_at AS createdAt, updated_at AS updatedAt
    FROM outbound WHERE id = ?
  `).get(id);
}

// Resolve a name → chat candidates (groups + named DMs). Complements
// searchContacts (people) so the /conversation resolver can find groups too.
export function searchChatsByName(query, { limit = 20 } = {}) {
  const like = `%${String(query).toLowerCase()}%`;
  return db.prepare(`
    SELECT id AS jid, name, is_group AS isGroup, last_message_at AS lastMessageAt, unread
    FROM chats
    WHERE lower(COALESCE(name, '')) LIKE ?
    ORDER BY last_message_at DESC NULLS LAST
    LIMIT ?
  `).all(like, limit);
}

export function getChat(jid) {
  return db.prepare(`
    SELECT id AS jid, name, is_group AS isGroup, last_message_at AS lastMessageAt, unread
    FROM chats WHERE id = ?
  `).get(jid);
}

export function getContact(jid) {
  return db.prepare(`
    SELECT jid,
           COALESCE(verified_name, notify_name, push_name) AS name,
           push_name AS pushName, notify_name AS notifyName, verified_name AS verifiedName,
           last_seen_at AS lastSeenAt
    FROM contacts WHERE jid = ?
  `).get(jid);
}

// ── Digest: unread chats + their recent messages, for a summary ──────────────
// We only track per-chat unread counts (not per-message read state), so the
// "unread" messages are approximated by the last `unread` messages in the chat
// (capped). Good enough to summarize what arrived while you were away.
export function getUnreadDigest({ chatLimit = 30, maxPerChat = 15 } = {}) {
  const chats = db.prepare(`
    SELECT id AS jid, name, is_group AS isGroup, unread, last_message_at AS lastMessageAt
    FROM chats
    WHERE unread > 0 AND id NOT LIKE '%@newsletter' AND id <> 'status@broadcast'
    ORDER BY last_message_at DESC
    LIMIT ?
  `).all(chatLimit);
  return chats.map((c) => ({
    ...c,
    messages: getMessages(c.jid, { limit: Math.min(c.unread || maxPerChat, maxPerChat) }),
  }));
}

// ── Pending replies: chats whose last message is theirs (not ours) and has been
//    sitting unanswered for more than `hours`. Oldest-waiting first. ──────────
export function getPendingReplies({ hours = 3, limit = 50, includeGroups = true } = {}) {
  const cutoff = Date.now() - hours * 3600000;
  const groupClause = includeGroups ? '' : 'AND c.is_group = 0';
  return db.prepare(`
    SELECT c.id AS jid, c.name, c.is_group AS isGroup, c.unread,
           m.body AS lastBody, m.timestamp AS lastAt, m.sender AS lastSender,
           COALESCE(ct.verified_name, ct.notify_name, ct.push_name) AS senderName
    FROM chats c
    JOIN messages m ON m.id = (
      SELECT id FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1
    )
    LEFT JOIN contacts ct ON ct.jid = m.sender
    WHERE m.from_me = 0 AND m.timestamp < ?
      AND c.id NOT LIKE '%@newsletter' AND c.id <> 'status@broadcast'
      ${groupClause}
    ORDER BY m.timestamp ASC
    LIMIT ?
  `).all(cutoff, limit);
}

// ── Alerts (keyword watchlist) ───────────────────────────────────────────────
const recordAlertStmt = db.prepare(`
  INSERT OR IGNORE INTO alerts (msg_id, chat_id, keyword, body, matched_at)
  VALUES (@msgId, @chatId, @keyword, @body, @at)
`);
// Returns true only when the row is new, so the caller fires the push exactly
// once even if the same message is re-ingested.
export function recordAlert({ msgId, chatId = null, keyword, body = '', at = Date.now() }) {
  if (!msgId || !keyword) return false;
  return recordAlertStmt.run({ msgId: String(msgId), chatId, keyword, body, at }).changes > 0;
}

// ── @mentions: messages that tagged the account owner (mostly groups) ────────
export function getMentions({ limit = 30, since } = {}) {
  const params = [];
  let sinceClause = '';
  if (since) { sinceClause = 'AND m.timestamp >= ?'; params.push(since); }
  params.push(limit);
  return db.prepare(`
    SELECT m.id, m.chat_id AS chatId, c.name AS chatName, c.is_group AS isGroup,
           m.sender, COALESCE(ct.verified_name, ct.notify_name, ct.push_name) AS senderName,
           m.body, m.timestamp, m.deleted_at AS deletedAt
    FROM messages m
    LEFT JOIN chats c ON c.id = m.chat_id
    LEFT JOIN contacts ct ON ct.jid = m.sender
    WHERE m.mentions_me = 1 ${sinceClause}
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(...params);
}

export function listAlerts({ limit = 30 } = {}) {
  return db.prepare(`
    SELECT a.id, a.msg_id AS msgId, a.chat_id AS chatId, c.name AS chatName,
           a.keyword, a.body, a.matched_at AS matchedAt
    FROM alerts a
    LEFT JOIN chats c ON c.id = a.chat_id
    ORDER BY a.matched_at DESC
    LIMIT ?
  `).all(limit);
}
