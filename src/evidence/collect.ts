/**
 * Derive evidence receipts from a mission finding.
 *
 * A finding arrives from the agent carrying the tool output that produced it (toolName /
 * toolOutput / provenance / verifyGate) plus any mission-side evidence artifacts. The server
 * used to drop all of that and write evidenceIds:[] into the ledger, so nothing could ever clear
 * the promotion gate — real scans ran but their proof vanished ("claims outrun evidence"). This
 * turns that output into evidence descriptors the server persists and links to the finding.
 *
 * Pure + dependency-free so it is unit-testable and the honesty rule is verifiable in isolation.
 *
 * HONESTY RULE: only findings the mission's own verify gate marked tool-proven yield 'tool'-
 * strength receipts (which the promotion gate accepts). Model-asserted claims yield at most
 * 'context' strength and therefore still cannot self-promote — we never fabricate proof.
 */

export type EvidenceStrength = 'weak' | 'context' | 'tool' | 'replayable';
export type EvidenceKind =
  | 'artifact' | 'command' | 'log' | 'receipt' | 'report' | 'screenshot' | 'source' | 'note';
export type EvidenceSource = 'human' | 'agent' | 'tool' | 'system';

export interface FindingEvidenceInput {
  provenance?: unknown;
  toolName?: unknown;
  toolOutput?: unknown;
  verifyGate?: { provenance?: unknown } | null;
  evidence?: Array<{ type?: unknown; content?: unknown }> | null;
}

export interface EvidenceDescriptor {
  type: EvidenceKind;
  source: EvidenceSource;
  strength: EvidenceStrength;
  command?: string;
  title: string;
  summary: string;
}

const TOOLISH_EVIDENCE_TYPES = new Set(['command', 'output', 'response', 'request', 'log']);

/**
 * @param finding  the mission finding (only the evidence-bearing fields are read)
 * @param redact   optional redaction/truncation applied to every emitted string (defaults to identity)
 */
export function deriveFindingEvidence(
  finding: FindingEvidenceInput,
  redact: (value: string, limit?: number) => string = (v) => v,
): EvidenceDescriptor[] {
  const toolProven = finding.provenance === 'tool' || finding.verifyGate?.provenance === 'tool';
  const toolName = typeof finding.toolName === 'string' && finding.toolName.trim()
    ? finding.toolName.trim()
    : undefined;

  const out: EvidenceDescriptor[] = [];

  const toolOutput = typeof finding.toolOutput === 'string' ? finding.toolOutput.trim() : '';
  if (toolOutput) {
    out.push({
      type: toolProven ? 'command' : 'log',
      source: toolProven ? 'tool' : 'agent',
      strength: toolProven ? 'tool' : 'context',
      command: toolName ? redact(toolName, 200) : undefined,
      title: redact(toolName ? `${toolName} output` : 'Tool output', 200),
      summary: redact(toolOutput, 2000),
    });
  }

  for (const ev of Array.isArray(finding.evidence) ? finding.evidence : []) {
    const content = typeof ev?.content === 'string' ? ev.content.trim() : '';
    if (!content) continue;
    const evType = String(ev?.type || '');
    const toolish = TOOLISH_EVIDENCE_TYPES.has(evType);
    out.push({
      type: toolish ? 'command' : 'artifact',
      source: toolish ? 'tool' : 'agent',
      strength: (toolProven && toolish) ? 'tool' : 'context',
      title: redact(`Evidence: ${evType || 'artifact'}`, 200),
      summary: redact(content, 2000),
    });
  }

  // Drop descriptors that collapse to the same (type, summary) — a finding re-emitted across
  // ticks must not produce duplicate receipts.
  const seen = new Set<string>();
  return out.filter((d) => {
    const key = `${d.type}::${d.summary.slice(0, 160)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
