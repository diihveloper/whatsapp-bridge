// Image OCR + description via the Anthropic Messages API (native vision). Built
// for cheap models like Haiku; reads text and gives a short description in one
// call. Built-in fetch only — no SDK dependency.

const PROMPT =
  'Extraia TODO o texto visível nesta imagem (OCR), preservando números, datas e ' +
  'valores exatamente como aparecem. Em seguida, descreva brevemente o conteúdo. ' +
  'Responda em português, sem comentários extras.';

export async function describe({ key, model, buffer, mime }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mime || 'image/jpeg', data: buffer.toString('base64') },
          },
          { type: 'text', text: PROMPT },
        ],
      }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`anthropic vision ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
