// Whisper transcription over the OpenAI-compatible /audio/transcriptions API.
// Both Groq and OpenAI expose the exact same multipart shape, so one client
// serves both — only baseUrl/key/model differ. Uses Node's built-in fetch,
// FormData and Blob (Node >= 20), so there are no extra dependencies.

export async function transcribe({ baseUrl, key, model, buffer, mime, filename, language }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'audio/ogg' }), filename || 'audio.ogg');
  form.append('model', model);
  form.append('response_format', 'json');
  if (language) form.append('language', language); // ISO-639-1 hint, e.g. "pt"

  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` }, // let fetch set the multipart boundary
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`transcription ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.text ?? '').trim();
}
