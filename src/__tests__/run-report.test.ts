import { describe, it, expect } from 'vitest';
import {
  listRuns,
  buildRunReport,
  renderRunReportHtml,
  renderRunReportDocument,
  type RunLedgers,
} from '../reporting/run-report.js';

function fixture(): RunLedgers {
  return {
    findings: [
      { id: 'f1', missionId: 'mission-A', family: 'web_api', title: 'SQL injection in /login', target: 'http://a.test',
        claim: 'Auth bypass via UNION', impact: 'Full DB read', severity: 'high', confidence: 0.8, status: 'open',
        evidenceIds: ['e1'], recommendedFix: 'Parameterize queries', acceptanceCriteria: ['No error on quote', 'WAF blocks payload'],
        createdAt: '2026-07-20T10:00:00.000Z', updatedAt: '2026-07-20T11:00:00.000Z', retestIds: ['r1'] },
      { id: 'f2', missionId: 'mission-A', family: 'web_api', title: 'Verbose error page', target: 'http://a.test',
        claim: 'Stack traces leak', impact: 'Info disclosure', severity: 'low', confidence: 0.5, status: 'open',
        createdAt: '2026-07-20T09:00:00.000Z', updatedAt: '2026-07-20T09:00:00.000Z' },
      { id: 'f3', missionId: 'mission-B', title: 'Other run finding', target: 'http://b.test',
        claim: 'x', severity: 'critical', status: 'open', createdAt: '2026-07-21T10:00:00.000Z' },
    ],
    evidence: [
      { id: 'e1', missionId: 'mission-A', findingId: 'f1', type: 'http', title: 'Injection response', summary: '500 on quote',
        source: 'tool', provenanceStrength: 'strong', command: "curl 'http://a.test/login?u=%27'", createdAt: '2026-07-20T10:05:00.000Z' },
      { id: 'e2', missionId: 'mission-A', title: 'Loose recon note', source: 'agent', createdAt: '2026-07-20T08:00:00.000Z' },
    ],
    retests: [
      { id: 'r1', findingId: 'f1', missionId: 'mission-A', status: 'passed', method: 're-ran payload', resultSummary: 'still vulnerable', createdAt: '2026-07-20T12:00:00.000Z' },
    ],
    hypotheses: [
      { id: 'h1', missionId: 'mission-A', target: 'http://a.test', claim: 'IDOR on /orders', status: 'open', confidence: 0.4, createdAt: '2026-07-20T10:30:00.000Z' },
    ],
    workOrders: [
      { id: 'w1', missionId: 'mission-A', title: 'Probe /orders for IDOR', objective: 'enumerate ids', target: 'http://a.test', status: 'pending', squad: 'web', kind: 'probe', createdAt: '2026-07-20T10:31:00.000Z' },
    ],
  };
}

describe('run-report', () => {
  it('lists distinct runs, newest activity first, with per-run rollups', () => {
    const runs = listRuns(fixture());
    expect(runs.map((r) => r.missionId)).toEqual(['mission-B', 'mission-A']); // B active on 07-21 > A on 07-20
    const a = runs.find((r) => r.missionId === 'mission-A')!;
    expect(a.findingCount).toBe(2);
    expect(a.riskRating).toBe('high');
    expect(a.severityCounts).toMatchObject({ high: 1, low: 1, critical: 0 });
    expect(a.targets).toEqual(['http://a.test']);
    expect(a.firstSeen).toBe('2026-07-20T08:00:00.000Z'); // earliest = the recon-note evidence
  });

  it('scopes a report to one run and links evidence + retests to findings', () => {
    const report = buildRunReport('mission-A', fixture(), '2026-07-22T00:00:00.000Z')!;
    expect(report).not.toBeNull();
    expect(report.findings.map((f) => f.id)).toEqual(['f1', 'f2']); // high before low
    expect(report.evidenceByFinding['f1'].map((e) => e.id)).toEqual(['e1']);
    expect(report.retestsByFinding['f1'].map((r) => r.id)).toEqual(['r1']);
    expect(report.unlinkedEvidence.map((e) => e.id)).toEqual(['e2']); // e2 has no findingId
    expect(report.findings.some((f) => f.id === 'f3')).toBe(false); // other run excluded
  });

  it('returns null for a run with no records', () => {
    expect(buildRunReport('does-not-exist', fixture())).toBeNull();
  });

  it('renders self-contained, escaped HTML', () => {
    const report = buildRunReport('mission-A', fixture(), '2026-07-22T00:00:00.000Z')!;
    const html = renderRunReportHtml(report);
    expect(html).toContain('SQL injection in /login');
    expect(html).toContain('HIGH');
    expect(html).toContain('curl'); // command evidence rendered
    expect(html).not.toMatch(/https?:\/\/(?!a\.test)/); // no external asset fetches (only target urls as text)
    const doc = renderRunReportDocument(report);
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('<title>T3MP3ST Report — mission-A</title>');
  });

  it('escapes injected markup in finding text', () => {
    const led = fixture();
    led.findings[0].title = '<img src=x onerror=alert(1)>';
    const html = renderRunReportHtml(buildRunReport('mission-A', led, '2026-07-22T00:00:00.000Z')!);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
