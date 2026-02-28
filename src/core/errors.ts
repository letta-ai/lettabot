/**
 * Error classification and user-facing error formatting.
 *
 * Extracted from bot.ts to keep error logic isolated and testable.
 */

/**
 * Detect if an error is a 409 CONFLICT from an orphaned approval.
 */
export function isApprovalConflictError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('waiting for approval')) return true;
    if (msg.includes('conflict') && msg.includes('approval')) return true;
  }
  const statusError = error as { status?: number };
  if (statusError?.status === 409) return true;
  return false;
}

/**
 * Detect if an error indicates a missing conversation or agent.
 * Only these errors should trigger the "create new conversation" fallback.
 * Auth, network, and protocol errors should NOT be retried.
 */
export function isConversationMissingError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('not found')) return true;
    if (msg.includes('conversation') && (msg.includes('missing') || msg.includes('does not exist'))) return true;
    if (msg.includes('agent') && msg.includes('not found')) return true;
  }
  const statusError = error as { status?: number };
  if (statusError?.status === 404) return true;
  return false;
}

/**
 * Detect if a session initialization error indicates the agent doesn't exist.
 * The SDK includes CLI stderr in the error message when the subprocess exits
 * before sending an init message. We check for agent-not-found indicators in
 * both the SDK-level message and the CLI stderr output it includes.
 *
 * This intentionally does NOT treat generic init failures (like "no init
 * message received") as recoverable. Those can be transient SDK/process
 * issues, and clearing persisted agent state in those cases can destroy
 * valid mappings.
 */
export function isAgentMissingFromInitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  const agentMissingPatterns = [
    /\bagent\b[^.\n]{0,80}\bnot found\b/,
    /\bnot found\b[^.\n]{0,80}\bagent\b/,
    /\bagent\b[^.\n]{0,80}\bdoes not exist\b/,
    /\bunknown agent\b/,
    /\bagent_not_found\b/,
  ];
  return agentMissingPatterns.some((pattern) => pattern.test(msg));
}

/**
 * Map a structured API error into a clear, user-facing message.
 * The `error` object comes from the SDK's new SDKErrorMessage type.
 */
export function formatApiErrorForUser(error: { message: string; stopReason: string; apiError?: Record<string, unknown> }): string {
  const msg = error.message.toLowerCase();
  const apiError = error.apiError || {};
  const apiMsg = (typeof apiError.message === 'string' ? apiError.message : '').toLowerCase();
  const reasons: string[] = Array.isArray(apiError.reasons) ? apiError.reasons : [];

  // Billing / credits exhausted
  if (msg.includes('out of credits') || apiMsg.includes('out of credits')) {
    return '(Out of credits for hosted inference. Add credits or enable auto-recharge at app.letta.com/settings/organization/usage.)';
  }

  // Rate limiting / usage exceeded (429)
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('usage limit')
    || apiMsg.includes('rate limit') || apiMsg.includes('usage limit')) {
    if (reasons.includes('premium-usage-exceeded') || msg.includes('hosted model usage limit')) {
      return '(Rate limited -- your Letta Cloud usage limit has been exceeded. Check your plan at app.letta.com.)';
    }
    const reasonStr = reasons.length > 0 ? `: ${reasons.join(', ')}` : '';
    return `(Rate limited${reasonStr}. Try again in a moment.)`;
  }

  // 409 CONFLICT (concurrent request on same conversation)
  if (msg.includes('conflict') || msg.includes('409') || msg.includes('another request is currently being processed')) {
    return '(Another request is still processing on this conversation. Wait a moment and try again.)';
  }

  // Authentication
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) {
    return '(Authentication failed -- check your API key in lettabot.yaml.)';
  }

  // Agent/conversation not found
  if (msg.includes('not found') || msg.includes('404')) {
    return '(Agent or conversation not found -- the configured agent may have been deleted. Try re-onboarding.)';
  }

  // Server errors
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('internal server error')) {
    return '(Letta API server error -- try again in a moment.)';
  }

  // Fallback: use the actual error message (truncated for safety)
  const detail = error.message.length > 200 ? error.message.slice(0, 200) + '...' : error.message;
  const trimmed = detail.replace(/[.\s]+$/, '');
  return `(Agent error: ${trimmed}. Try sending your message again.)`;
}
