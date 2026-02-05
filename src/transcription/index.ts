/**
 * Transcription service
 * 
 * Currently supports OpenAI Whisper. Future providers can be added here.
 */

export { transcribeAudio, type TranscriptionResult } from './openai.js';
