// Local OCR via tesseract.js. Optional dependency: only required if the user
// sets OCR_PROVIDER=tesseract. Extracts text only (no description) and is weak
// on photos/angled scans, but runs fully offline with no API key.
//
//   npm install tesseract.js
//
// Language data ('por'+'eng') is downloaded on first use and cached by the lib.

async function loadTesseract() {
  try {
    return await import('tesseract.js');
  } catch (_) {
    throw new Error(
      "OCR_PROVIDER=tesseract requires the 'tesseract.js' package. Run: npm install tesseract.js"
    );
  }
}

export async function describe({ buffer }) {
  const Tesseract = await loadTesseract();
  const recognize = Tesseract.recognize ?? Tesseract.default?.recognize;
  const { data } = await recognize(buffer, 'por+eng');
  return (data?.text ?? '').trim();
}
