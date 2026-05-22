// Pluggable text summarization, selected via .env (OFF by default). Used by the
// `--summarize` path of /digest so the bridge can return ready-made prose for
// consumers without an LLM of their own. When OFF, /digest returns structured
// data and the *caller* (e.g. Claude in a session or a scheduled agent)
// summarizes it — that's the recommended, zero-cost path.
//
//   SUMMARY_PROVIDER = off | groq | openai | claude
//
// Cloud only, built-in fetch — no extra deps. Reuses the media providers' keys.

const cfg = {
  provider: String(process.env.SUMMARY_PROVIDER ?? 'off').trim().toLowerCase(),
  keys: {
    groq: process.env.GROQ_API_KEY ?? '',
    openai: process.env.OPENAI_API_KEY ?? '',
    anthropic: process.env.ANTHROPIC_API_KEY ?? '',
  },
  models: {
    groq: process.env.GROQ_TEXT_MODEL || 'llama-3.3-70b-versatile',
    openai: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
    anthropic: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
  },
};

export const summaryEnabled = () => cfg.provider !== 'off';
export const summaryProvider = () => cfg.provider;

function requireKey(name) {
  const k = cfg.keys[name];
  if (!k) throw new Error(`${name.toUpperCase()}_API_KEY is not set (needed for SUMMARY_PROVIDER=${cfg.provider})`);
  return k;
}

// OpenAI-compatible chat (Groq + OpenAI share the shape).
async function chatOpenAI({ baseUrl, key, model, system, content }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
      temperature: 0.2,
      max_tokens: 1200,
    }),
  });
  if (!res.ok) throw new Error(`summary ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

async function chatAnthropic({ key, model, system, content }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1200, system, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new Error(`summary ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const data = await res.json();
  return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

export async function summarize({ system, content }) {
  switch (cfg.provider) {
    case 'groq':
      return chatOpenAI({ baseUrl: 'https://api.groq.com/openai/v1', key: requireKey('groq'), model: cfg.models.groq, system, content });
    case 'openai':
      return chatOpenAI({ baseUrl: 'https://api.openai.com/v1', key: requireKey('openai'), model: cfg.models.openai, system, content });
    case 'claude':
      return chatAnthropic({ key: requireKey('anthropic'), model: cfg.models.anthropic, system, content });
    default:
      throw new Error(`SUMMARY_PROVIDER is off (set it to groq | openai | claude to use --summarize)`);
  }
}
