// Pluggable media processing: audio transcription (voice notes) and image
// OCR/description. Everything is OFF by default and selected purely via .env, so
// no media leaves the machine unless the user opts in and supplies a key.
//
//   TRANSCRIBE_PROVIDER = off | groq | openai | whisper-local   (audio)
//   OCR_PROVIDER        = off | claude | groq | tesseract        (image)
//   STORE_MEDIA         = off | processed | documents | all      (keep raw files)
//
// Cloud providers (groq/openai/claude) use only the built-in fetch — no extra
// npm deps. Local providers (tesseract / whisper-local) are optional and loaded
// via dynamic import() *only* when selected, with a friendly error if missing.
//
// This module is provider logic only: it never touches the DB or the filesystem.
// The server orchestrates download → (persist) → transcribe/describe → store.

const cfg = readEnv();

function readEnv() {
  const lc = (v, d) => String(process.env[v] ?? d).trim().toLowerCase();
  return {
    transcribe: lc('TRANSCRIBE_PROVIDER', 'off'),
    ocr: lc('OCR_PROVIDER', 'off'),
    store: lc('STORE_MEDIA', 'off'),
    maxBytes: Number(process.env.MEDIA_MAX_BYTES) || 20 * 1024 * 1024,
    language: (process.env.TRANSCRIBE_LANGUAGE ?? '').trim(),
    keys: {
      groq: process.env.GROQ_API_KEY ?? '',
      openai: process.env.OPENAI_API_KEY ?? '',
      anthropic: process.env.ANTHROPIC_API_KEY ?? '',
    },
    models: {
      groqWhisper: process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3',
      groqVision: process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
      openaiWhisper: process.env.OPENAI_WHISPER_MODEL || 'whisper-1',
      anthropic: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      whisperLocal: process.env.WHISPER_MODEL || 'base',
    },
  };
}

export const transcribeEnabled = () => cfg.transcribe !== 'off';
export const ocrEnabled = () => cfg.ocr !== 'off';

// Which raw files to persist (for GET .../media). Audio/image are only persisted
// when also processed, so the disk only holds media the user actually wired up.
function storeWants(type) {
  switch (cfg.store) {
    case 'all': return type === 'audio' || type === 'image' || type === 'document';
    case 'processed': return type === 'audio' || type === 'image';
    case 'documents': return type === 'document';
    default: return false; // off
  }
}
export const shouldStore = (type) => storeWants(type);

// Types the extension/baileys should bother downloading bytes for: anything we
// can process (audio→transcribe, image→ocr) or persist for download. With
// everything off this is empty, so there's zero download overhead by default.
export function downloadTypes() {
  const set = new Set();
  if (transcribeEnabled() || storeWants('audio')) set.add('audio');
  if (ocrEnabled() || storeWants('image')) set.add('image');
  if (storeWants('document')) set.add('document');
  return [...set];
}

export function getMediaConfig() {
  return {
    transcribe: cfg.transcribe,
    ocr: cfg.ocr,
    store: cfg.store,
    maxBytes: cfg.maxBytes,
    download: downloadTypes(),
  };
}

function requireKey(provider) {
  const k = cfg.keys[provider];
  if (!k) throw new Error(`${provider.toUpperCase()}_API_KEY is not set in .env`);
  return k;
}

// ── Audio → text ────────────────────────────────────────────────────────────
export async function transcribeAudio({ buffer, mime, filename }) {
  if (!transcribeEnabled()) return null;
  const f = filename || `audio.${extFor(mime, 'ogg')}`;
  switch (cfg.transcribe) {
    case 'groq': {
      const { transcribe } = await import('./providers/openaiCompatible.js');
      return transcribe({
        baseUrl: 'https://api.groq.com/openai/v1',
        key: requireKey('groq'),
        model: cfg.models.groqWhisper,
        buffer, mime, filename: f, language: cfg.language,
      });
    }
    case 'openai': {
      const { transcribe } = await import('./providers/openaiCompatible.js');
      return transcribe({
        baseUrl: 'https://api.openai.com/v1',
        key: requireKey('openai'),
        model: cfg.models.openaiWhisper,
        buffer, mime, filename: f, language: cfg.language,
      });
    }
    case 'whisper-local': {
      const { transcribe } = await import('./providers/whisperLocal.js');
      return transcribe({ buffer, mime, model: cfg.models.whisperLocal, language: cfg.language });
    }
    default:
      throw new Error(`unknown TRANSCRIBE_PROVIDER: ${cfg.transcribe}`);
  }
}

// ── Image → text (OCR + brief description) ───────────────────────────────────
export async function describeImage({ buffer, mime }) {
  if (!ocrEnabled()) return null;
  switch (cfg.ocr) {
    case 'claude': {
      const { describe } = await import('./providers/claude.js');
      return describe({ key: requireKey('anthropic'), model: cfg.models.anthropic, buffer, mime });
    }
    case 'groq': {
      const { describe } = await import('./providers/openaiCompatibleVision.js');
      return describe({
        baseUrl: 'https://api.groq.com/openai/v1',
        key: requireKey('groq'), model: cfg.models.groqVision, buffer, mime,
      });
    }
    case 'tesseract': {
      const { describe } = await import('./providers/tesseract.js');
      return describe({ buffer });
    }
    default:
      throw new Error(`unknown OCR_PROVIDER: ${cfg.ocr}`);
  }
}

function extFor(mime, fallback) {
  if (!mime) return fallback;
  const map = {
    'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/webm': 'webm',
  };
  return map[mime] || (mime.split('/')[1] ?? fallback);
}
