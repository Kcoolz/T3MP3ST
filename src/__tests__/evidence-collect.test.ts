import { describe, it, expect } from 'vitest';
import { deriveFindingEvidence } from '../evidence/collect.js';

describe('deriveFindingEvidence', () => {
  it('captures tool output as a promotable tool-strength receipt when the finding is tool-proven', () => {
    const out = deriveFindingEvidence({
      provenance: 'tool',
      toolName: 'sqli_scan',
      toolOutput: "error-based SQLi confirmed on id param: ' OR 1=1-- returned 500",
      verifyGate: { provenance: 'tool' },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'command', source: 'tool', strength: 'tool', command: 'sqli_scan' });
    expect(out[0].summary).toContain('SQLi confirmed');
  });

  it('does NOT promote a model-asserted claim — tool output from a model finding is only context', () => {
    const out = deriveFindingEvidence({
      provenance: 'model',
      toolName: 'reasoning',
      toolOutput: 'I believe there is likely an IDOR here',
      verifyGate: { provenance: 'none' },
    });
    expect(out).toHaveLength(1);
    expect(out[0].strength).toBe('context'); // honesty rule: cannot self-promote
    expect(out[0].source).toBe('agent');
    expect(out[0].type).toBe('log');
  });

  it('fabricates NOTHING when there is no tool output or evidence', () => {
    expect(deriveFindingEvidence({ provenance: 'model' })).toEqual([]);
    expect(deriveFindingEvidence({})).toEqual([]);
  });

  it('maps mission evidence artifacts by type; tool-ish types are tool-strength only when proven', () => {
    const proven = deriveFindingEvidence({
      provenance: 'tool',
      verifyGate: { provenance: 'tool' },
      evidence: [
        { type: 'response', content: 'HTTP/1.1 500 Internal Server Error' },
        { type: 'note', content: 'analyst hunch' },
      ],
    });
    const resp = proven.find((d) => d.summary.includes('500'))!;
    const note = proven.find((d) => d.summary.includes('hunch'))!;
    expect(resp).toMatchObject({ type: 'command', source: 'tool', strength: 'tool' });
    expect(note).toMatchObject({ type: 'artifact', source: 'agent', strength: 'context' });
  });

  it('dedupes identical (type, summary) receipts so re-emitted findings do not pile up', () => {
    const out = deriveFindingEvidence({
      provenance: 'tool',
      toolName: 'curl_request',
      toolOutput: 'DUPLICATE OUTPUT',
      verifyGate: { provenance: 'tool' },
      evidence: [{ type: 'command', content: 'DUPLICATE OUTPUT' }],
    });
    expect(out).toHaveLength(1);
  });

  it('applies the provided redactor to every emitted string', () => {
    const redact = (v: string) => v.slice(0, 10).replace(/secret/gi, '[REDACTED]');
    const out = deriveFindingEvidence({
      provenance: 'tool',
      toolName: 'curl_request',
      toolOutput: 'secret-token-abc123 leaked in body',
      verifyGate: { provenance: 'tool' },
    }, redact);
    expect(out[0].summary).toBe('[REDACTED]-tok'); // 'secret-tok' (slice 0..10) → redacted
    expect(out[0].summary).not.toContain('token-abc123');
  });
});
