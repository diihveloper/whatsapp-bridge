// Image OCR + description via an OpenAI-compatible /chat/completions endpoint
// with an image_url data URL (Groq's vision models use this shape). Built-in
// fetch only — no extra deps.

const PROMPT =
  'Extraia TODO o texto visível nesta imagem (OCR), preservando números, datas e ' +
  'valores exatamente como aparecem. Em seguida, descreva brevemente o conteúdo. ' +
  'Responda em português, sem comentários extras.';

export async function describe({ baseUrl, key, model, buffer, mime }) {
  const dataUrl = `data:${mime || 'image/jpeg'};base64,${buffer.toString('base64')}`;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      temperature: 0,
      max_tokens: 1024,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`vision ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? '').trim();
}
