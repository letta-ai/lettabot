import type { Session } from '@letta-ai/letta-code-sdk';

type ApprovalRecoveryResult = {
  recovered: boolean;
  detail?: string;
};

type SessionWithApprovalRecovery = Session & {
  recoverPendingApprovals?: (options?: { timeoutMs?: number }) => Promise<ApprovalRecoveryResult>;
};

/**
 * SDK compatibility shim for approval recovery.
 *
 * Some SDK versions expose `recoverPendingApprovals` at runtime before the
 * TypeScript Session type includes it. This helper keeps compile-time safety
 * while preserving the existing runtime fallback behavior.
 */
export async function recoverPendingApprovalsWithSdk(
  session: Session,
  timeoutMs = 10_000,
): Promise<ApprovalRecoveryResult> {
  const recover = (session as SessionWithApprovalRecovery).recoverPendingApprovals;
  if (typeof recover !== 'function') {
    return {
      recovered: false,
      detail: 'Session.recoverPendingApprovals is unavailable in this SDK version',
    };
  }

  try {
    return await recover.call(session, { timeoutMs });
  } catch (error) {
    return {
      recovered: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}