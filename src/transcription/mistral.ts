/**
 * Mistral Voxtral transcription service
 *
 * Uses Voxtral Transcribe 2 via the Mistral REST API.
 * Simple multipart POST — no SDK dependency needed.
 */

import { loadConfig } from '../config/index.js';
import type { TranscriptionResult } from './openai.js';

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
  return config.transcription?.model || 'voxtral-mini-latest';
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
  try {
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
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Mistral API error (${response.status}): ${errorText}`,
        audioPath: options?.audioPath,
      };
    }

    const data = await response.json() as { text: string };
    return { success: true, text: data.text };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMsg,
      audioPath: options?.audioPath,
    };
  }
}
