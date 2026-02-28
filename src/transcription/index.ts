/**
 * Transcription service router
 *
 * Delegates to the correct provider based on config.transcription.provider.
 * Defaults to OpenAI Whisper for backwards compatibility.
 */

import { loadConfig } from '../config/index.js';
import type { TranscriptionResult } from './openai.js';
import { transcribeAudio as openaiTranscribe } from './openai.js';
import { transcribeAudio as mistralTranscribe } from './mistral.js';

export type { TranscriptionResult } from './openai.js';

/**
 * Check whether a transcription API key is available for the configured provider.
 * Used by channel handlers to gate voice message processing.
 */
export function isTranscriptionConfigured(): boolean {
  const config = loadConfig();
  const provider = config.transcription?.provider || 'openai';
  return !!(config.transcription?.apiKey
    || (provider === 'mistral' ? process.env.MISTRAL_API_KEY : process.env.OPENAI_API_KEY));
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  filename?: string,
  options?: { audioPath?: string }
): Promise<TranscriptionResult> {
  const config = loadConfig();
  const provider = config.transcription?.provider || 'openai';

  if (provider === 'mistral') {
    return mistralTranscribe(audioBuffer, filename, options);
  }

  return openaiTranscribe(audioBuffer, filename, options);
}
