/**
 * Text-to-Speech (TTS) for Matrix Adapter
 *
 * Synthesizes text to speech using VibeVoice API.
 */

import { createLogger } from "../../logger.js";
const log = createLogger('MatrixTTS');

export interface TTSConfig {
  url?: string;
  voice?: string;
  format?: "mp3" | "wav";
  speed?: number;
  sampleRate?: number;
}

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
  gender?: string;
}

// Pronunciation fixes applied before TTS — word-boundary replacements
const PRONUNCIATION_MAP: Record<string, string> = {
  // Names
  "Xzaviar": "X-zay-V-ar",
  "xzaviar": "X-zay-V-ar",
  "Jean Luc": "Zhan-Look",
  "jean luc": "Zhan-Look",
  "Sebastian": "Se-BASS-chen",
  "sebastian": "Se-BASS-chen",
  // Technical terms that TTS often mangles
  "API": "A P I",
  "SDK": "S D K",
  "E2EE": "end-to-end encrypted",
  "TTS": "text to speech",
  "STT": "speech to text",
};

/**
 * Apply pronunciation fixes using word-boundary regex
 */
function applyPronunciationFixes(text: string): string {
  let result = text;
  for (const [wrong, right] of Object.entries(PRONUNCIATION_MAP)) {
    result = result.replace(new RegExp(`\\b${escapeRegExp(wrong)}\\b`, "gi"), right);
  }
  return result;
}

/**
 * Clean text for TTS synthesis — matches Python bridge synthesize_speech() cleaning.
 * Call order: control tags → HTML → markdown → code blocks → emojis → pronunciation → whitespace.
 */
export function cleanTextForTTS(text: string): string {
  let cleaned = text;

  // Strip agent control tags
  cleaned = cleaned.replace(/\[silent\]/gi, "");
  cleaned = cleaned.replace(/\[chromatophore\]/gi, "");
  cleaned = cleaned.replace(/\[!c\]/gi, "");
  cleaned = cleaned.replace(/\[!s\]/gi, "");
  cleaned = cleaned.replace(/\[react:[^\]]*\]/gi, "");

  // Strip color syntax {color|text} → keep text
  cleaned = cleaned.replace(/\{[^}|]+\|([^}]+)\}/g, "$1");

  // Strip spoilers ||text|| → keep text
  cleaned = cleaned.replace(/\|\|(.+?)\|\|/gs, "$1");

  // Strip HTML tags (keep content)
  cleaned = cleaned.replace(/<[^>]+>/g, "");

  // Remove code blocks entirely (don't read code aloud)
  cleaned = cleaned.replace(/```[\s\S]*?```/g, "");

  // Strip bold and italic markers (keep text)
  cleaned = cleaned.replace(/\*\*(.+?)\*\*/g, "$1");
  cleaned = cleaned.replace(/\*(.+?)\*/g, "$1");

  // Remove inline code markers (keep content)
  cleaned = cleaned.replace(/`([^`]+)`/g, "$1");

  // Convert markdown links to spoken form: [text](url) → text
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Emoji handling: preserve ✨ and 🎤, strip everything else
  // Use marker swap trick from Python bridge
  const SPARKLE_MARKER = "__SPARKLE__";
  const MIC_MARKER = "__MIC__";
  cleaned = cleaned.replace(/✨/g, SPARKLE_MARKER);
  cleaned = cleaned.replace(/🎤/g, MIC_MARKER);
  // Strip remaining emoji (broad Unicode ranges)
  cleaned = cleaned.replace(
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2702}-\u{27B0}\u{24C2}-\u{1F251}\u{1F900}-\u{1FAFF}]/gu,
    ""
  );
  cleaned = cleaned.replace(new RegExp(SPARKLE_MARKER, "g"), "✨");
  cleaned = cleaned.replace(new RegExp(MIC_MARKER, "g"), "🎤");

  // Apply pronunciation fixes
  cleaned = applyPronunciationFixes(cleaned);

  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Synthesize speech from text using VibeVoice API
 */
export async function synthesizeSpeech(
  text: string,
  config: TTSConfig,
): Promise<Buffer> {
  const url = config.url || "http://10.10.20.19:7861";
  const voice = config.voice || "en-Soother_woman";
  const format = config.format || "mp3";
  const speed = config.speed || 1.0;
  const sampleRate = config.sampleRate || 22050;

  const cleanedText = cleanTextForTTS(text);

  log.info(`[MatrixTTS] Synthesizing: ${cleanedText.slice(0, 50)}...`);
  log.info(`[MatrixTTS] Voice: ${voice}, Format: ${format}`);

  try {
    const response = await fetch(`${url}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: cleanedText,
        voice: voice,
        model: "vibevoice-v1",
      }),
    });

    if (!response.ok) {
      throw new Error(`TTS API error: ${response.status} ${response.statusText}`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    log.info(`[MatrixTTS] Synthesized ${audioBuffer.length} bytes`);

    return audioBuffer;
  } catch (err) {
    log.error("[MatrixTTS] Failed to synthesize:", err);
    throw err;
  }
}

/**
 * Get available voices from VibeVoice API
 */
export async function getAvailableVoices(url?: string): Promise<VoiceInfo[]> {
  const apiUrl = url || "http://10.10.20.19:7861";

  try {
    const response = await fetch(`${apiUrl}/voices`);
    if (!response.ok) {
      throw new Error(`TTS API error: ${response.status} ${response.statusText}`);
    }

    const voices = (await response.json()) as VoiceInfo[];
    log.info(`[MatrixTTS] Found ${voices.length} voices`);
    return voices;
  } catch (err) {
    log.error("[MatrixTTS] Failed to get voices:", err);
    // Return default voice info as fallback
    return [{ id: "en_soothing", name: "Soothing English", language: "en" }];
  }
}
