// Local, offline transcription via whisper.cpp (the nodejs-whisper wrapper).
// Optional dependency: only required if TRANSCRIBE_PROVIDER=whisper-local.
// 100% private and free, but heavier to set up:
//
//   npm install nodejs-whisper
//   npx nodejs-whisper download        # fetch the model (e.g. "base")
//   # ffmpeg must be on PATH — WhatsApp audio is ogg/opus and is converted to wav.
//
// whisper.cpp transcribes a file on disk, so we write the buffer to a temp file
// (converting to 16 kHz mono wav with ffmpeg first) and clean up afterwards.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

function ffmpegToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', outputPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('error', () => reject(new Error('ffmpeg not found on PATH (needed for whisper-local)')));
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.slice(-300)}`))));
  });
}

async function loadWhisper() {
  try {
    return await import('nodejs-whisper');
  } catch (_) {
    throw new Error(
      "TRANSCRIBE_PROVIDER=whisper-local requires 'nodejs-whisper'. Run: npm install nodejs-whisper && npx nodejs-whisper download"
    );
  }
}

export async function transcribe({ buffer, mime, model, language }) {
  const { nodewhisper } = await loadWhisper();
  const base = join(tmpdir(), `wab-${randomUUID()}`);
  const srcExt = (mime?.split('/')[1] ?? 'ogg').replace('x-', '');
  const srcPath = `${base}.${srcExt}`;
  const wavPath = `${base}.wav`;
  try {
    await writeFile(srcPath, buffer);
    await ffmpegToWav(srcPath, wavPath);
    await nodewhisper(wavPath, {
      modelName: model || 'base',
      autoDownloadModelName: model || 'base',
      whisperOptions: {
        language: language || 'auto',
        outputInText: true,
        wordTimestamps: false,
      },
    });
    // nodejs-whisper writes "<wav>.txt" alongside the input.
    const txt = await readFile(`${wavPath}.txt`, 'utf8').catch(() => '');
    await unlink(`${wavPath}.txt`).catch(() => {});
    return txt.trim();
  } finally {
    await unlink(srcPath).catch(() => {});
    await unlink(wavPath).catch(() => {});
  }
}
