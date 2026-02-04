/**
 * OpenAI Whisper transcription service
 */

import OpenAI from 'openai';
import { loadConfig } from '../config/index.js';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Whisper API limit is 25MB, we use 20MB to be safe
const MAX_FILE_SIZE = 20 * 1024 * 1024;
// Chunk duration in seconds (10 minutes)
const CHUNK_DURATION_SECONDS = 600;

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    const config = loadConfig();
    // Config takes priority, then env var
    const apiKey = config.transcription?.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key required for transcription. Set in config (transcription.apiKey) or OPENAI_API_KEY env var.');
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

function getModel(): string {
  const config = loadConfig();
  return config.transcription?.model || process.env.TRANSCRIPTION_MODEL || 'whisper-1';
}

/**
 * Transcribe audio using OpenAI Whisper API
 * 
 * @param audioBuffer - The audio data as a Buffer
 * @param filename - Filename with extension (e.g., 'voice.ogg')
 * @returns The transcribed text
 */
export async function transcribeAudio(audioBuffer: Buffer, filename: string = 'audio.ogg'): Promise<string> {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  
  // Check if format needs conversion (not just renaming)
  let finalBuffer = audioBuffer;
  let finalExt = ext;
  
  if (NEEDS_CONVERSION.includes(ext)) {
    console.log(`[Transcription] Converting .${ext} to .mp3 with ffmpeg`);
    finalBuffer = convertAudioToMp3(audioBuffer, ext);
    finalExt = 'mp3';
  }
  
  // Check if file is too large and needs chunking
  if (finalBuffer.length > MAX_FILE_SIZE) {
    console.log(`[Transcription] File too large (${(finalBuffer.length / 1024 / 1024).toFixed(1)}MB), splitting into chunks`);
    return transcribeInChunks(finalBuffer, finalExt);
  }
  
  // Single file transcription
  return transcribeSingleFile(finalBuffer, filename, finalExt);
}

/**
 * Transcribe a single audio file (under size limit)
 */
async function transcribeSingleFile(audioBuffer: Buffer, originalFilename: string, ext: string): Promise<string> {
  const client = getClient();
  const finalFilename = normalizeFilename(originalFilename.replace(/\.[^.]+$/, `.${ext}`));
  
  const file = new File([new Uint8Array(audioBuffer)], finalFilename, { 
    type: getMimeType(finalFilename) 
  });
  
  const response = await client.audio.transcriptions.create({
    file,
    model: getModel(),
  });
  
  return response.text;
}

/**
 * Split large audio into chunks and transcribe each
 */
async function transcribeInChunks(audioBuffer: Buffer, ext: string): Promise<string> {
  const tempDir = join(tmpdir(), 'lettabot-transcription', `chunks-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  
  const inputPath = join(tempDir, `input.${ext}`);
  const outputPattern = join(tempDir, 'chunk-%03d.mp3');
  
  try {
    // Write input file
    writeFileSync(inputPath, audioBuffer);
    
    // Split into chunks using ffmpeg
    execSync(
      `ffmpeg -y -i "${inputPath}" -f segment -segment_time ${CHUNK_DURATION_SECONDS} -reset_timestamps 1 -acodec libmp3lame -q:a 2 "${outputPattern}" 2>/dev/null`,
      { timeout: 120000 }
    );
    
    // Find all chunk files
    const chunkFiles = readdirSync(tempDir)
      .filter(f => f.startsWith('chunk-') && f.endsWith('.mp3'))
      .sort();
    
    console.log(`[Transcription] Split into ${chunkFiles.length} chunks`);
    
    if (chunkFiles.length === 0) {
      throw new Error('Failed to split audio into chunks');
    }
    
    // Transcribe each chunk
    const transcriptions: string[] = [];
    for (let i = 0; i < chunkFiles.length; i++) {
      const chunkPath = join(tempDir, chunkFiles[i]);
      const chunkBuffer = readFileSync(chunkPath);
      
      console.log(`[Transcription] Transcribing chunk ${i + 1}/${chunkFiles.length} (${(chunkBuffer.length / 1024).toFixed(0)}KB)`);
      
      const text = await transcribeSingleFile(chunkBuffer, chunkFiles[i], 'mp3');
      if (text.trim()) {
        transcriptions.push(text.trim());
      }
    }
    
    // Combine transcriptions
    const combined = transcriptions.join(' ');
    console.log(`[Transcription] Combined ${transcriptions.length} chunks into ${combined.length} chars`);
    
    return combined;
  } finally {
    // Cleanup temp directory
    try {
      const files = readdirSync(tempDir);
      for (const file of files) {
        unlinkSync(join(tempDir, file));
      }
      // rmdir for the directory itself
      execSync(`rmdir "${tempDir}" 2>/dev/null || true`);
    } catch {}
  }
}

/**
 * Formats that need actual conversion (not just renaming)
 */
const NEEDS_CONVERSION = ['aac', 'amr', 'caf', 'x-caf', '3gp', '3gpp'];

/**
 * Convert audio to MP3 using ffmpeg
 */
function convertAudioToMp3(audioBuffer: Buffer, inputExt: string): Buffer {
  const tempDir = join(tmpdir(), 'lettabot-transcription');
  mkdirSync(tempDir, { recursive: true });
  
  const inputPath = join(tempDir, `input-${Date.now()}.${inputExt}`);
  const outputPath = join(tempDir, `output-${Date.now()}.mp3`);
  
  try {
    // Write input file
    writeFileSync(inputPath, audioBuffer);
    
    // Convert with ffmpeg
    execSync(`ffmpeg -y -i "${inputPath}" -acodec libmp3lame -q:a 2 "${outputPath}" 2>/dev/null`, {
      timeout: 30000,
    });
    
    // Read output
    const converted = readFileSync(outputPath);
    console.log(`[Transcription] Converted ${audioBuffer.length} bytes → ${converted.length} bytes`);
    return converted;
  } finally {
    // Cleanup temp files
    try { unlinkSync(inputPath); } catch {}
    try { unlinkSync(outputPath); } catch {}
  }
}

/**
 * Supported formats for OpenAI Whisper API
 */
const SUPPORTED_FORMATS = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm'];

/**
 * Get MIME type from filename extension
 */
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    'ogg': 'audio/ogg',
    'oga': 'audio/ogg',
    'mp3': 'audio/mpeg',
    'mp4': 'audio/mp4',
    'm4a': 'audio/mp4',
    'aac': 'audio/mp4', // AAC is the codec in m4a
    'wav': 'audio/wav',
    'flac': 'audio/flac',
    'webm': 'audio/webm',
    'mpeg': 'audio/mpeg',
    'mpga': 'audio/mpeg',
  };
  return mimeTypes[ext || ''] || 'audio/ogg';
}

/**
 * Map unsupported extensions to Whisper-compatible equivalents
 * These mappings work for whisper-1 and gpt-4o-transcribe models
 */
const FORMAT_MAP: Record<string, string> = {
  'aac': 'm4a',     // AAC codec - M4A is AAC in MP4 container
  'amr': 'mp3',     // AMR (mobile voice) - try as mp3
  'opus': 'ogg',    // Opus codec typically in OGG container
  'x-caf': 'm4a',   // Apple CAF format
  'caf': 'm4a',     // Apple CAF format (alternate)
  '3gp': 'mp4',     // 3GP mobile format
  '3gpp': 'mp4',    // 3GPP mobile format
};

/**
 * Normalize filename for Whisper/GPT-4o transcription API
 * Converts unsupported extensions to supported equivalents
 */
function normalizeFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  
  if (!ext) {
    return filename + '.ogg';
  }
  
  // Check if already supported
  if (SUPPORTED_FORMATS.includes(ext)) {
    return filename;
  }
  
  // Map to supported format if we have a mapping
  const mapped = FORMAT_MAP[ext];
  if (mapped) {
    console.log(`[Transcription] Mapping .${ext} → .${mapped}`);
    return filename.replace(new RegExp(`\\.${ext}$`, 'i'), `.${mapped}`);
  }
  
  // Default fallback - try as ogg
  console.warn(`[Transcription] Unknown format .${ext}, trying as .ogg`);
  return filename.replace(/\.[^.]+$/, '.ogg');
}
