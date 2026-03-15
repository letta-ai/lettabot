/**
 * Speech-to-Text (STT) for Matrix Adapter
 */

import { createLogger } from "../../logger.js";
const log = createLogger('MatrixSTT');

export interface STTConfig {
  url?: string;
  language?: string;
  model?: string;
}

export interface STTResult {
  text: string;
  language?: string;
}

export async function transcribeAudio(
  audioData: Buffer,
  config: STTConfig,
): Promise<string> {
  const url = config.url || "http://localhost:7862";
  const model = config.model || "small";

  log.info(`[MatrixSTT] Transcribing ${audioData.length} bytes`);

  try {
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(audioData)], { type: "audio/mpeg" });
    formData.append("audio", blob, "audio.mp3");

    if (config.language) {
      formData.append("language", config.language);
    }
    formData.append("model", model);

    const response = await fetch(`${url}/transcribe`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`STT API error: ${response.status}`);
    }

    const result = (await response.json()) as STTResult;
    return result.text?.trim() || "";
  } catch (err) {
    log.error("[MatrixSTT] Failed:", err);
    return `[STT Error] ${err instanceof Error ? err.message : "Unknown"}`;
  }
}

export function isTranscriptionFailed(text: string): boolean {
  return text.startsWith("[") && text.includes("Error");
}
