/**
 * Outbound message redaction — catches common secret patterns before
 * text reaches channel adapters.
 */

export interface RedactionConfig {
  /** Redact common secret patterns (API keys, tokens, bearer tokens). Default: true */
  secrets?: boolean;
  /** Redact PII patterns (emails, phone numbers). Default: false */
  pii?: boolean;
}

const REDACTED = '[REDACTED]';

// ── Secret patterns ──────────────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  // OpenAI / Letta API keys
  /sk-[A-Za-z0-9_-]{20,}/g,
  // GitHub tokens
  /gh[ps]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  // Slack tokens
  /xox[bpras]-[A-Za-z0-9-]{10,}/g,
  // AWS access keys
  /AKIA[0-9A-Z]{16}/g,
  // Generic bearer tokens in text
  /Bearer\s+[A-Za-z0-9_\-.~+/]+=*/gi,
  // URLs with embedded credentials (user:pass@host)
  /https?:\/\/[^:@\s]+:[^@\s]+@[^\s]+/g,
  // Generic long hex/base64 strings near sensitive keywords
  /(?:key|token|secret|password|apikey|api_key|auth)\s*[:=]\s*["']?[A-Za-z0-9_\-+/]{20,}["']?/gi,
];

// ── PII patterns ─────────────────────────────────────────────────────────────

const PII_PATTERNS: RegExp[] = [
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  // Phone numbers (various formats)
  /(?<!\d)(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}(?!\d)/g,
];

/**
 * Redact sensitive patterns from outbound text.
 * Returns the text with matches replaced by [REDACTED].
 */
export function redactOutbound(text: string, config?: RedactionConfig): string {
  if (!text) return text;

  const redactSecrets = config?.secrets !== false; // default: true
  const redactPii = config?.pii === true;          // default: false

  let result = text;

  if (redactSecrets) {
    for (const pattern of SECRET_PATTERNS) {
      // Reset lastIndex for global regexes
      pattern.lastIndex = 0;
      result = result.replace(pattern, REDACTED);
    }
  }

  if (redactPii) {
    for (const pattern of PII_PATTERNS) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, REDACTED);
    }
  }

  return result;
}
