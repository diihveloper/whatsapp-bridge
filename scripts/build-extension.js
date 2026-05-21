// Copies the prebuilt @wppconnect/wa-js bundle into extension/vendor/ so the
// extension can load it as a MAIN-world content script. wa-js tracks WhatsApp
// Web's internal module changes for us, so re-running this after `npm update`
// is how you keep up with WA Web updates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'node_modules', '@wppconnect', 'wa-js', 'dist');
const outDir = path.join(root, 'extension', 'vendor');
const outFile = path.join(outDir, 'wppconnect-wa.js');

if (!fs.existsSync(distDir)) {
  console.error('@wppconnect/wa-js is not installed. Run `npm install` first.');
  process.exit(1);
}

// The published bundle is dist/wppconnect-wa.js (UMD). Fall back to the largest
// top-level .js in dist if the name ever changes.
let src = path.join(distDir, 'wppconnect-wa.js');
if (!fs.existsSync(src)) {
  const candidates = fs.readdirSync(distDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ f, size: fs.statSync(path.join(distDir, f)).size }))
    .sort((a, b) => b.size - a.size);
  if (!candidates.length) {
    console.error('No .js bundle found in', distDir);
    process.exit(1);
  }
  src = path.join(distDir, candidates[0].f);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(src, outFile);
const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
console.log(`Copied ${path.basename(src)} -> extension/vendor/wppconnect-wa.js (${kb} KB)`);
