// Orchestrates a single piece of incoming media: optionally persist the raw
// bytes to data/media/, then run transcription (audio) / OCR (image) and fold
// the resulting text into the message body. Shared by the extension path
// (server.js, bytes arrive base64 over /media) and the baileys path
// (whatsapp.js, bytes come from downloadMediaMessage).

import fs from 'node:fs';
import path from 'node:path';
import {
  transcribeAudio, describeImage, transcribeEnabled, ocrEnabled, shouldStore,
} from './index.js';
import { attachMedia, setMediaText, setMediaStatus } from '../store.js';

const MEDIA_DIR = path.resolve('data', 'media');

const EXT = {
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/webm': 'webm',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf',
};

function safeName(id, mime, filename) {
  const fromName = filename ? path.extname(filename).replace('.', '') : '';
  const ext = EXT[mime] || fromName || (mime?.split('/')[1] ?? 'bin');
  const stem = String(id).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return `${stem}.${ext}`;
}

function persist(id, buffer, mime, filename) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const rel = path.join('media', safeName(id, mime, filename));
  fs.writeFileSync(path.resolve('data', rel), buffer);
  return rel; // stored relative to data/ so the DB stays portable
}

// Returns { status, text? }. Best-effort: failures are recorded as 'error' and
// never throw to the caller (one bad voice note shouldn't break ingest).
export async function processMedia({ id, type, buffer, mime, filename, forceStore = false }) {
  if (!id || !buffer?.length) return { status: 'skipped' };
  try {
    // On-demand fetches force persistence so the file is available to download
    // even when STORE_MEDIA is off.
    const store = forceStore || shouldStore(type);
    const rel = store ? persist(id, buffer, mime, filename) : null;
    attachMedia(id, { path: rel, mime: mime ?? null, status: 'pending' });

    let text = null;
    if (type === 'audio' && transcribeEnabled()) text = await transcribeAudio({ buffer, mime, filename });
    else if (type === 'image' && ocrEnabled()) text = await describeImage({ buffer, mime });

    if (text == null) {
      // No processor for this type (e.g. a stored document) — just mark done.
      setMediaStatus(id, store ? 'done' : 'skipped');
      return { status: store ? 'done' : 'skipped' };
    }
    if (!text.trim()) {
      // Processor ran but produced nothing (silent audio / blank image): keep
      // the original placeholder body, just flag it processed.
      setMediaStatus(id, 'done');
      return { status: 'done', text: '' };
    }
    setMediaText(id, text.trim(), { status: 'done' });
    return { status: 'done', text: text.trim() };
  } catch (e) {
    setMediaStatus(id, 'error');
    console.warn(`[media] processing failed for ${id}:`, e.message);
    return { status: 'error', error: String(e.message ?? e) };
  }
}

export function mediaFileAbsPath(rel) {
  if (!rel) return null;
  const abs = path.resolve('data', rel);
  // Containment guard: never serve outside data/media/.
  if (!abs.startsWith(MEDIA_DIR)) return null;
  return fs.existsSync(abs) ? abs : null;
}
