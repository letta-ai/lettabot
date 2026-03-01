/**
 * Mistral Voxtral transcription service
 *
 * Uses Voxtral Transcribe 2 via the Mistral REST API.
 * Simple multipart POST — no SDK dependency needed.
 */

import { loadConfig } from '../config/index.js';
import { createLogger } from '../logger.js';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TranscriptionResult } from './openai.js';

const log = createLogger('Mistral');
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const CHUNK_DURATION_SECONDS = 600;

function getApiKey(): string {
  const config = loadConfig();
  const apiKey = config.transcription?.apiKey || process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error('Mistral API key required for transcription. Set in config (transcription.apiKey) or MISTRAL_API_KEY env var.');
  }
  return apiKey;
}

function getModel(): string {
  const config = loadConfig();
  return config.transcription?.model || process.env.TRANSCRIPTION_MODEL || 'voxtral-mini-latest';
}

function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    'ogg': 'audio/ogg',
    'oga': 'audio/ogg',
    'mp3': 'audio/mpeg',
    'mp4': 'audio/mp4',
    'm4a': 'audio/mp4',
    'wav': 'audio/wav',
    'flac': 'audio/flac',
    'webm': 'audio/webm',
  };
  return mimeTypes[ext || ''] || 'audio/ogg';
}

const NEEDS_CONVERSION = ['aac', 'amr', 'caf', 'x-caf', '3gp', '3gpp'];

const FORMAT_MAP: Record<string, string> = {
  'aac': 'm4a',
  'amr': 'mp3',
  'opus': 'ogg',
  'x-caf': 'm4a',
  'caf': 'm4a',
  '3gp': 'mp4',
  '3gpp': 'mp4',
};

let ffmpegAvailable: boolean | null = null;

function isFfmpegAvailable(): boolean {
  if (ffmpegAvailable === null) {
    try {
      execSync('which ffmpeg', { stdio: 'ignore' });
      ffmpegAvailable = true;
    } catch {
      ffmpegAvailable = false;
    }
  }
  return ffmpegAvailable;
}

function convertAudioToMp3(audioBuffer: Buffer, inputExt: string): Buffer {
  const tempDir = join(tmpdir(), 'lettabot-transcription');
  mkdirSync(tempDir, { recursive: true });

  const inputPath = join(tempDir, `input-${Date.now()}.${inputExt}`);
  const outputPath = join(tempDir, `output-${Date.now()}.mp3`);

  try {
    writeFileSync(inputPath, audioBuffer);
    execSync(`ffmpeg -y -i "${inputPath}" -acodec libmp3lame -q:a 2 "${outputPath}" 2>/dev/null`, {
      timeout: 30000,
    });
    const converted = readFileSync(outputPath);
    log.info(`Converted ${audioBuffer.length} bytes → ${converted.length} bytes`);
    return converted;
  } finally {
    try { unlinkSync(inputPath); } catch {}
    try { unlinkSync(outputPath); } catch {}
  }
}

/**
 * Send a single buffer to the Voxtral API and return the text.
 */
async function attemptTranscription(audioBuffer: Buffer, filename: string): Promise<string> {
  const apiKey = getApiKey();
  const model = getModel();

  const file = new File([new Uint8Array(audioBuffer)], filename, {
    type: getMimeType(filename),
  });

  const formData = new FormData();
  formData.append('model', model);
  formData.append('file', file);

  const response = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Mistral API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { text: string };
  return data.text;
}

/**
 * Split large audio into chunks and transcribe each.
 */
async function transcribeInChunks(audioBuffer: Buffer, ext: string): Promise<string> {
  if (!isFfmpegAvailable()) {
    throw new Error('Cannot split large audio files without ffmpeg');
  }

  const tempDir = join(tmpdir(), 'lettabot-transcription', `chunks-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  const inputPath = join(tempDir, `input.${ext}`);
  const outputPattern = join(tempDir, 'chunk-%03d.mp3');

  try {
    writeFileSync(inputPath, audioBuffer);

    execSync(
      `ffmpeg -y -i "${inputPath}" -f segment -segment_time ${CHUNK_DURATION_SECONDS} -reset_timestamps 1 -acodec libmp3lame -q:a 2 "${outputPattern}" 2>/dev/null`,
      { timeout: 120000 }
    );

    const chunkFiles = readdirSync(tempDir)
      .filter(f => f.startsWith('chunk-') && f.endsWith('.mp3'))
      .sort();

    if (chunkFiles.length === 0) {
      throw new Error('Failed to split audio into chunks');
    }

    log.info(`Split into ${chunkFiles.length} chunks`);

    const transcriptions: string[] = [];
    for (let i = 0; i < chunkFiles.length; i++) {
      const chunkPath = join(tempDir, chunkFiles[i]);
      const chunkBuffer = readFileSync(chunkPath);
      log.info(`Transcribing chunk ${i + 1}/${chunkFiles.length} (${(chunkBuffer.length / 1024).toFixed(0)}KB)`);
      const text = await attemptTranscription(chunkBuffer, chunkFiles[i]);
      if (text.trim()) {
        transcriptions.push(text.trim());
      }
    }

    const combined = transcriptions.join(' ');
    log.info(`Combined ${transcriptions.length} chunks into ${combined.length} chars`);
    return combined;
  } finally {
    try {
      const files = readdirSync(tempDir);
      for (const file of files) {
        unlinkSync(join(tempDir, file));
      }
      execSync(`rmdir "${tempDir}" 2>/dev/null || true`);
    } catch {}
  }
}

/**
 * Transcribe audio using Mistral Voxtral API
 *
 * Voxtral supports: wav, mp3, flac, ogg, webm
 * Telegram voice messages (OGG/Opus) work natively.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string = 'audio.ogg',
  options?: { audioPath?: string }
): Promise<TranscriptionResult> {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  try {
    let finalBuffer = audioBuffer;
    let finalFilename = filename;

    // Convert unsupported formats via ffmpeg
    if (NEEDS_CONVERSION.includes(ext)) {
      const mapped = FORMAT_MAP[ext];
      if (mapped) {
        log.info(`Trying .${ext} as .${mapped} (no conversion)`);
        finalFilename = filename.replace(/\.[^.]+$/, `.${mapped}`);

        try {
          const text = await attemptTranscription(finalBuffer, finalFilename);
          return { success: true, text };
        } catch {
          log.info(`Rename approach failed for .${ext}`);
        }
      }

      if (isFfmpegAvailable()) {
        log.info(`Converting .${ext} → .mp3 with ffmpeg`);
        finalBuffer = convertAudioToMp3(audioBuffer, ext);
        finalFilename = filename.replace(/\.[^.]+$/, '.mp3');
      } else {
        return {
          success: false,
          error: `Cannot transcribe .${ext} format. Install ffmpeg for audio conversion, or send in a supported format (mp3, ogg, wav, flac).`,
          audioPath: options?.audioPath,
        };
      }
    }

    // Check file size and chunk if needed
    if (finalBuffer.length > MAX_FILE_SIZE) {
      const finalExt = finalFilename.split('.').pop()?.toLowerCase() || 'ogg';
      log.info(`File too large (${(finalBuffer.length / 1024 / 1024).toFixed(1)}MB), splitting into chunks`);
      const text = await transcribeInChunks(finalBuffer, finalExt);
      return { success: true, text };
    }

    const text = await attemptTranscription(finalBuffer, finalFilename);
    return { success: true, text };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMsg,
      audioPath: options?.audioPath,
    };
  }
}
