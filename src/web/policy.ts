import { checkWriteAllowed } from '../lib/write-guard.js';
import { WebError } from './domain.js';

// Reuse the existing MCP guard, with a hardcoded policy independent of PRIORITY_READ_ONLY.
// No Priority client, MCP transport, external executor or Telegram bot is started by the web app.
export function blockPriorityExecution(): never {
  const guard = checkWriteAllowed({ priorityReadOnly: true } as Parameters<
    typeof checkWriteAllowed
  >[0]);
  if (!guard.blocked) throw new Error('Demo write guard invariant failed');
  throw new WebError(403, 'ביצוע ב־Priority חסום בגרסת הדמה.');
}
export function blockAgentApproval(): never {
  throw new WebError(403, 'חשבון הסוכן אינו מורשה לאשר בקשות. האישור החיצוני טרם חובר.');
}

// Contract for a FUTURE server-side worker. This is not a Telegram integration or an approval API.
// The browser cannot supply this evidence; owner authentication must be implemented separately.
export interface OwnerApproval {
  ownerId: string;
  requesterId: string;
  requestId: string;
  version: number;
  contentHash: string;
  target: string;
  verifiedChannel: 'telegram';
  authenticatedOwner: boolean;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
}
export function approvalMatches(
  request: { id: string; actorId: string; version: number; contentHash: string; target: string },
  approval: OwnerApproval,
  expectedOwnerId: string,
  now: number,
) {
  return (
    Boolean(expectedOwnerId) &&
    approval.ownerId === expectedOwnerId &&
    approval.ownerId !== request.actorId &&
    approval.requesterId === request.actorId &&
    approval.authenticatedOwner &&
    approval.verifiedChannel === 'telegram' &&
    approval.requestId === request.id &&
    approval.version === request.version &&
    approval.contentHash === request.contentHash &&
    approval.target === request.target &&
    approval.issuedAt <= now &&
    approval.expiresAt > now &&
    approval.expiresAt > approval.issuedAt &&
    approval.expiresAt - approval.issuedAt <= 10 * 60_000 &&
    approval.consumedAt === null
  );
}
export function requiresReconciliation(status: string) {
  // A crash after dispatch has the same ambiguity as a timeout. Never retry either blindly.
  return status === 'in_progress' || status === 'uncertain';
}
