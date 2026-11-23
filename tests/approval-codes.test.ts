import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TTL_MS,
  checkApproval,
  consumeApproval,
  fingerprintOf,
  issueApproval,
} from '../src/lib/approval-codes.js';

const dir = () => mkdtempSync(join(tmpdir(), 'approvals-'));
const T0 = Date.parse('2026-01-10T10:00:00Z');
const BIND = {
  tool: 'bonded_release_finalize',
  subject: 'IM1/BD1',
  state: { a: 1, lines: [1, 2] },
};

describe('approval codes', () => {
  it('a code is used once', () => {
    const d = dir();
    const { approvalCode, approvalExpiresAt } = issueApproval(d, BIND, T0);
    expect(approvalCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(Date.parse(approvalExpiresAt)).toBe(T0 + APPROVAL_TTL_MS);
    expect(checkApproval(d, { ...BIND, code: approvalCode }, T0 + 1000)).toEqual({ ok: true });
    expect(consumeApproval(d, { ...BIND, code: approvalCode }, T0 + 1000)).toEqual({ ok: true });
    const again = consumeApproval(d, { ...BIND, code: approvalCode }, T0 + 2000);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.reason).toContain('כבר נוצל');
  });

  it('an expired code is refused', () => {
    const d = dir();
    const { approvalCode } = issueApproval(d, BIND, T0);
    const r = consumeApproval(d, { ...BIND, code: approvalCode }, T0 + APPROVAL_TTL_MS + 1);
    expect(!r.ok && r.reason).toContain('פג');
  });

  it('a code of another tool or another document is refused', () => {
    const d = dir();
    const { approvalCode } = issueApproval(d, BIND, T0);
    const otherTool = consumeApproval(
      d,
      { ...BIND, tool: 'bonded_receipt_finalize', code: approvalCode },
      T0,
    );
    expect(!otherTool.ok && otherTool.reason).toContain('אינו שייך');
    const otherDoc = consumeApproval(d, { ...BIND, subject: 'IM1/BD2', code: approvalCode }, T0);
    expect(!otherDoc.ok && otherDoc.reason).toContain('אינו שייך');
    // neither refusal spent it
    expect(consumeApproval(d, { ...BIND, code: approvalCode }, T0)).toEqual({ ok: true });
  });

  it('a changed document is refused and the code is not spent', () => {
    const d = dir();
    const { approvalCode } = issueApproval(d, BIND, T0);
    const changed = consumeApproval(
      d,
      { ...BIND, state: { a: 2, lines: [1, 2] }, code: approvalCode },
      T0,
    );
    expect(!changed.ok && changed.reason).toContain('המסמך השתנה מאז התצוגה המקדימה');
    expect(consumeApproval(d, { ...BIND, code: approvalCode }, T0)).toEqual({ ok: true });
  });

  it('an unknown or malformed code is refused without touching the disk', () => {
    const d = dir();
    const unknown = consumeApproval(d, { ...BIND, code: 'ABCD-EFGH' }, T0);
    expect(!unknown.ok && unknown.reason).toContain('אינו מוכר');
    const evil = consumeApproval(d, { ...BIND, code: '../../etc/passwd' }, T0);
    expect(!evil.ok && evil.reason).toContain('אינו מוכר');
    expect(existsSync(d) ? readdirSync(d) : []).toEqual([]);
  });

  it('the fingerprint ignores key order', () => {
    expect(fingerprintOf({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(
      fingerprintOf({ a: [{ x: 1, y: 2 }], b: 1 }),
    );
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }));
    expect(fingerprintOf({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
});
