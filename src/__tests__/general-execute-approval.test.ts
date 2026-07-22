/**
 * Regression: the Op Admiral "Execute" button (generalExecutePlan) must take part in the
 * ScopeGuard approval handshake, exactly like generalFullAuto. If it doesn't, a 403
 * "approval required" is mislabeled FAILED, approving the receipt resumes nothing, and
 * re-clicking mints a fresh receipt forever (the reported infinite approve loop).
 *
 * The server (findApproval in src/server.ts) only matches an approval whose id is echoed
 * back in approvalIds, so the client MUST send approvalIds and register a retry that
 * threads the granted receipt id.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const uiSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/index.html'),
  'utf8',
);

function functionBody(name: string): string {
  const start = uiSource.indexOf(`async function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThan(-1);
  // slice to the start of the next top-level async function declaration
  const after = uiSource.indexOf('\n        async function ', start + 1);
  const end = after > -1 ? after : start + 6000;
  return uiSource.slice(start, end);
}

describe('Op Admiral Execute participates in the approval handshake', () => {
  const execFn = functionBody('generalExecutePlan');

  it('accepts approvalIds and echoes them to /api/general/execute', () => {
    expect(execFn).toMatch(/async function generalExecutePlan\(approvalIds/);
    // the execute POST body must forward approvalIds so the server can match the grant
    const execFetch = execFn.slice(execFn.indexOf('/api/general/execute'));
    expect(execFetch).toMatch(/body:\s*JSON\.stringify\(\{[^}]*approvalIds/);
  });

  it('on 403 registers a resume instead of throwing FAILED', () => {
    expect(execFn).toMatch(/resp\.status === 403 && data\.approval\?\.id/);
    expect(execFn).toContain('window.__t3mpPendingApprovalRetry = () => generalExecutePlan(');
    expect(execFn).toMatch(/window\.__t3mpPendingApprovalReceiptIds =/);
    // the 403 branch must return before the throw/FAILED path
    const guardIdx = execFn.indexOf('resp.status === 403');
    const throwIdx = execFn.indexOf("throw new Error(data.error || 'Execution failed')");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(throwIdx).toBeGreaterThan(guardIdx); // the throw is the fallthrough, after the 403 handler
  });

  it('the receipt-approval handlers fire the pending retry (so approving resumes)', () => {
    // approveReceipt (Receipts page) and approveScopeReceipt (Scope Receipts feed)
    for (const fn of ['approveReceipt', 'approveScopeReceipt']) {
      const idx = uiSource.indexOf(`function ${fn}`);
      expect(idx, `missing ${fn}`).toBeGreaterThan(-1);
      const body = uiSource.slice(idx, idx + 1200);
      expect(body, `${fn} must fire the pending retry`).toContain('window.__t3mpPendingApprovalRetry');
    }
  });
});
