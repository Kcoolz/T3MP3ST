/**
 * Per-run engagement report generator.
 *
 * Builds a self-contained HTML report for a SINGLE run (mission), sourced from the
 * PERSISTED ledgers (findings / evidence / retests / hypotheses / work orders) that the
 * server hydrates from state.json. That is the point of this module: unlike the live
 * TempestCommand.generateReport (active mission only), this reports ANY past run, keyed
 * by missionId, and survives server restarts.
 *
 * Pure + dependency-free ON PURPOSE — it takes plain ledger arrays and returns strings,
 * so it is unit-testable without booting Express and reusable from a CLI later. All
 * caller-supplied text is HTML-escaped: the emitted document is opened in a browser, so
 * the report itself must never become an injection vector.
 */

// ── Structural input types (a decoupled subset of the server's ledger records) ──────

export interface ReportFinding {
  id: string;
  missionId?: string;
  family?: string;
  title: string;
  target: string;
  claim: string;
  impact?: string;
  severity: string;
  confidence?: number;
  status: string;
  evidenceIds?: string[];
  recommendedFix?: string;
  acceptanceCriteria?: string[];
  createdAt: string;
  updatedAt?: string;
  retestIds?: string[];
}

export interface ReportEvidence {
  id: string;
  missionId?: string;
  findingId?: string;
  type?: string;
  title: string;
  summary?: string;
  source?: string;
  provenanceStrength?: string;
  uri?: string;
  command?: string;
  createdAt: string;
}

export interface ReportRetest {
  id: string;
  findingId: string;
  missionId?: string;
  status: string;
  method?: string;
  resultSummary?: string;
  createdAt: string;
}

export interface ReportHypothesis {
  id: string;
  missionId?: string;
  target?: string;
  claim: string;
  status: string;
  confidence?: number;
  createdAt: string;
}

export interface ReportWorkOrder {
  id: string;
  missionId?: string;
  title: string;
  objective?: string;
  target?: string;
  status: string;
  squad?: string;
  kind?: string;
  createdAt: string;
}

export interface RunLedgers {
  findings: ReportFinding[];
  evidence: ReportEvidence[];
  retests: ReportRetest[];
  hypotheses: ReportHypothesis[];
  workOrders: ReportWorkOrder[];
}

// ── Derived report shapes ────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export interface RunSummary {
  missionId: string;
  findingCount: number;
  evidenceCount: number;
  retestCount: number;
  hypothesisCount: number;
  workOrderCount: number;
  severityCounts: Record<Severity, number>;
  riskRating: Severity;
  targets: string[];
  firstSeen: string;
  lastSeen: string;
}

export interface RunReport {
  summary: RunSummary;
  findings: ReportFinding[];
  evidenceByFinding: Record<string, ReportEvidence[]>;
  retestsByFinding: Record<string, ReportRetest[]>;
  unlinkedEvidence: ReportEvidence[];
  hypotheses: ReportHypothesis[];
  workOrders: ReportWorkOrder[];
  generatedAt: string;
}

const UNASSIGNED = '(unassigned)';

function runKey(missionId?: string): string {
  return missionId && missionId.trim() ? missionId : UNASSIGNED;
}

function normSeverity(s: string | undefined): Severity {
  const v = String(s || '').toLowerCase();
  return (SEVERITY_ORDER as string[]).includes(v) ? (v as Severity) : 'info';
}

function emptySeverityCounts(): Record<Severity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

function minIso(a: string | undefined, b: string): string {
  if (!a) return b;
  return a < b ? a : b;
}
function maxIso(a: string | undefined, b: string): string {
  if (!a) return b;
  return a > b ? a : b;
}

/** All records that belong to a given run, across every ledger. */
function filterByRun(ledgers: RunLedgers, id: string): RunLedgers {
  const match = (mid?: string): boolean => runKey(mid) === id;
  return {
    findings: ledgers.findings.filter((f) => match(f.missionId)),
    evidence: ledgers.evidence.filter((e) => match(e.missionId)),
    retests: ledgers.retests.filter((r) => match(r.missionId)),
    hypotheses: ledgers.hypotheses.filter((h) => match(h.missionId)),
    workOrders: ledgers.workOrders.filter((w) => match(w.missionId)),
  };
}

function summarize(id: string, sub: RunLedgers): RunSummary {
  const severityCounts = emptySeverityCounts();
  for (const f of sub.findings) severityCounts[normSeverity(f.severity)]++;
  const riskRating = SEVERITY_ORDER.find((s) => severityCounts[s] > 0) ?? 'info';

  const targets = Array.from(
    new Set(
      [
        ...sub.findings.map((f) => f.target),
        ...sub.hypotheses.map((h) => h.target),
        ...sub.workOrders.map((w) => w.target),
      ].filter((t): t is string => Boolean(t && t.trim())),
    ),
  ).sort();

  let firstSeen: string | undefined;
  let lastSeen: string | undefined;
  const stamp = (iso?: string): void => {
    if (!iso) return;
    firstSeen = minIso(firstSeen, iso);
    lastSeen = maxIso(lastSeen, iso);
  };
  sub.findings.forEach((f) => { stamp(f.createdAt); stamp(f.updatedAt); });
  sub.evidence.forEach((e) => stamp(e.createdAt));
  sub.retests.forEach((r) => stamp(r.createdAt));
  sub.hypotheses.forEach((h) => stamp(h.createdAt));
  sub.workOrders.forEach((w) => stamp(w.createdAt));

  return {
    missionId: id,
    findingCount: sub.findings.length,
    evidenceCount: sub.evidence.length,
    retestCount: sub.retests.length,
    hypothesisCount: sub.hypotheses.length,
    workOrderCount: sub.workOrders.length,
    severityCounts,
    riskRating,
    targets,
    firstSeen: firstSeen ?? '',
    lastSeen: lastSeen ?? '',
  };
}

/** Enumerate the runs present in the persisted ledgers, most recently active first. */
export function listRuns(ledgers: RunLedgers): RunSummary[] {
  const ids = new Set<string>();
  for (const f of ledgers.findings) ids.add(runKey(f.missionId));
  for (const e of ledgers.evidence) ids.add(runKey(e.missionId));
  for (const r of ledgers.retests) ids.add(runKey(r.missionId));
  for (const h of ledgers.hypotheses) ids.add(runKey(h.missionId));
  for (const w of ledgers.workOrders) ids.add(runKey(w.missionId));

  return Array.from(ids)
    .map((id) => summarize(id, filterByRun(ledgers, id)))
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
}

function severityRank(s: string | undefined): number {
  return SEVERITY_ORDER.indexOf(normSeverity(s));
}

/** Build the structured report for one run. Returns null when the run has no records. */
export function buildRunReport(
  missionId: string,
  ledgers: RunLedgers,
  generatedAt: string = new Date().toISOString(),
): RunReport | null {
  const id = runKey(missionId);
  const sub = filterByRun(ledgers, id);
  const total = sub.findings.length + sub.evidence.length + sub.retests.length +
    sub.hypotheses.length + sub.workOrders.length;
  if (total === 0) return null;

  const findings = [...sub.findings].sort((a, b) => {
    const bySev = severityRank(a.severity) - severityRank(b.severity);
    if (bySev !== 0) return bySev;
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  });

  const evidenceById = new Map(sub.evidence.map((e) => [e.id, e]));
  const linkedEvidenceIds = new Set<string>();
  const evidenceByFinding: Record<string, ReportEvidence[]> = {};
  const retestsByFinding: Record<string, ReportRetest[]> = {};

  for (const f of findings) {
    const linked: ReportEvidence[] = [];
    const seen = new Set<string>();
    // Evidence attached either by the finding's evidenceIds or by evidence.findingId.
    for (const eid of f.evidenceIds ?? []) {
      const e = evidenceById.get(eid);
      if (e && !seen.has(e.id)) { linked.push(e); seen.add(e.id); linkedEvidenceIds.add(e.id); }
    }
    for (const e of sub.evidence) {
      if (e.findingId === f.id && !seen.has(e.id)) { linked.push(e); seen.add(e.id); linkedEvidenceIds.add(e.id); }
    }
    if (linked.length) evidenceByFinding[f.id] = linked;

    const retests = sub.retests.filter((r) => r.findingId === f.id);
    if (retests.length) retestsByFinding[f.id] = retests;
  }

  const unlinkedEvidence = sub.evidence.filter((e) => !linkedEvidenceIds.has(e.id));

  return {
    summary: summarize(id, sub),
    findings,
    evidenceByFinding,
    retestsByFinding,
    unlinkedEvidence,
    hypotheses: sub.hypotheses,
    workOrders: sub.workOrders,
    generatedAt,
  };
}

// ── HTML rendering ─────────────────────────────────────────────────────────────────

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? escapeHtml(iso) : escapeHtml(d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC'));
}

function tile(label: string, value: number | string, sev?: Severity): string {
  const cls = sev ? ` sev-${sev}` : '';
  return `<div class="tile${cls}"><div class="tile-v">${escapeHtml(value)}</div><div class="tile-l">${escapeHtml(label)}</div></div>`;
}

function sevChip(sev: string): string {
  const s = normSeverity(sev);
  return `<span class="chip sev-${s}">${escapeHtml(s.toUpperCase())}</span>`;
}

function list(items: string[] | undefined): string {
  const arr = (items ?? []).filter((x) => x && x.trim());
  if (!arr.length) return '';
  return `<ul class="crit">${arr.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`;
}

function renderEvidence(ev: ReportEvidence): string {
  const meta = [ev.type, ev.source, ev.provenanceStrength]
    .filter((x) => x && String(x).trim())
    .map((x) => `<span class="ev-tag">${escapeHtml(x)}</span>`)
    .join('');
  const cmd = ev.command ? `<pre class="cmd">${escapeHtml(ev.command)}</pre>` : '';
  const uri = ev.uri ? `<div class="ev-uri">${escapeHtml(ev.uri)}</div>` : '';
  return `<div class="evidence">
    <div class="ev-head"><b>${escapeHtml(ev.title)}</b> ${meta}</div>
    ${ev.summary ? `<div class="ev-sum">${escapeHtml(ev.summary)}</div>` : ''}
    ${uri}${cmd}
  </div>`;
}

function renderFinding(
  f: ReportFinding,
  evidence: ReportEvidence[] | undefined,
  retests: ReportRetest[] | undefined,
): string {
  const confidence = typeof f.confidence === 'number' ? `${Math.round(f.confidence * 100)}%` : '—';
  const evBlock = (evidence && evidence.length)
    ? `<div class="sub"><div class="sub-h">Evidence (${evidence.length})</div>${evidence.map(renderEvidence).join('')}</div>`
    : `<div class="sub muted">No evidence attached — treat as an unproven hypothesis.</div>`;
  const rtBlock = (retests && retests.length)
    ? `<div class="sub"><div class="sub-h">Retests (${retests.length})</div>${retests.map((r) => `
        <div class="retest"><span class="chip status">${escapeHtml(r.status)}</span> ${escapeHtml(r.method || '')} ${r.resultSummary ? `— ${escapeHtml(r.resultSummary)}` : ''}</div>`).join('')}</div>`
    : '';
  return `<section class="finding sev-border-${normSeverity(f.severity)}">
    <div class="f-head">
      ${sevChip(f.severity)}
      <h3>${escapeHtml(f.title)}</h3>
    </div>
    <div class="f-meta">
      <span><b>Target:</b> ${escapeHtml(f.target || '—')}</span>
      <span><b>Status:</b> ${escapeHtml(f.status)}</span>
      <span><b>Confidence:</b> ${confidence}</span>
      ${f.family ? `<span><b>Family:</b> ${escapeHtml(f.family)}</span>` : ''}
      <span><b>Logged:</b> ${fmtDate(f.createdAt)}</span>
    </div>
    ${f.claim ? `<div class="block"><div class="block-h">Claim</div><p>${escapeHtml(f.claim)}</p></div>` : ''}
    ${f.impact ? `<div class="block"><div class="block-h">Impact</div><p>${escapeHtml(f.impact)}</p></div>` : ''}
    ${f.recommendedFix ? `<div class="block"><div class="block-h">Recommended fix</div><p>${escapeHtml(f.recommendedFix)}</p></div>` : ''}
    ${f.acceptanceCriteria && f.acceptanceCriteria.length ? `<div class="block"><div class="block-h">Acceptance criteria</div>${list(f.acceptanceCriteria)}</div>` : ''}
    ${evBlock}
    ${rtBlock}
  </section>`;
}

/** Render a full run report as a single self-contained, theme-aware HTML document body. */
export function renderRunReportHtml(report: RunReport): string {
  const s = report.summary;
  const sc = s.severityCounts;
  const window = s.firstSeen || s.lastSeen
    ? `${fmtDate(s.firstSeen)} → ${fmtDate(s.lastSeen)}`
    : '—';

  const findingsHtml = report.findings.length
    ? report.findings.map((f) => renderFinding(f, report.evidenceByFinding[f.id], report.retestsByFinding[f.id])).join('')
    : `<p class="muted">No findings recorded for this run.</p>`;

  const hypothesesHtml = report.hypotheses.length
    ? `<h2>Open hypotheses (${report.hypotheses.length})</h2>${report.hypotheses.map((h) => `
        <div class="row"><span class="chip status">${escapeHtml(h.status)}</span>
        <b>${escapeHtml(h.target || '—')}</b> — ${escapeHtml(h.claim)}
        ${typeof h.confidence === 'number' ? `<span class="muted">(${Math.round(h.confidence * 100)}%)</span>` : ''}</div>`).join('')}`
    : '';

  const workOrdersHtml = report.workOrders.length
    ? `<h2>Work orders (${report.workOrders.length})</h2>${report.workOrders.map((w) => `
        <div class="row"><span class="chip status">${escapeHtml(w.status)}</span>
        <b>${escapeHtml(w.title)}</b>${w.squad ? ` <span class="muted">[${escapeHtml(w.squad)}]</span>` : ''}
        ${w.objective ? `<div class="muted">${escapeHtml(w.objective)}</div>` : ''}</div>`).join('')}`
    : '';

  const unlinkedHtml = report.unlinkedEvidence.length
    ? `<h2>Unlinked evidence (${report.unlinkedEvidence.length})</h2>${report.unlinkedEvidence.map(renderEvidence).join('')}`
    : '';

  return `<style>
  .t3-report { --bg:#ffffff; --fg:#1c1f24; --muted:#6b7280; --card:#f6f7f9; --border:#e4e6ea; --brand:#0a7d4f;
    color:var(--fg); background:var(--bg); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    line-height:1.5; max-width:960px; margin:0 auto; padding:32px 20px; }
  @media (prefers-color-scheme: dark){ .t3-report{ --bg:#0e1013; --fg:#e6e8eb; --muted:#9aa0a6; --card:#16191d; --border:#262a30; --brand:#00d488; } }
  .t3-report h1{ font-size:24px; margin:0 0 4px; } .t3-report h2{ font-size:17px; margin:32px 0 12px; border-bottom:1px solid var(--border); padding-bottom:6px; }
  .t3-report h3{ font-size:15px; margin:0; } .t3-report p{ margin:6px 0; } .t3-report .muted{ color:var(--muted); }
  .t3-report .sub-title{ color:var(--muted); font-size:13px; margin-bottom:20px; }
  .t3-report .meta-grid{ display:grid; grid-template-columns:max-content 1fr; gap:4px 16px; font-size:13px; margin:16px 0 8px; }
  .t3-report .meta-grid b{ color:var(--muted); font-weight:600; }
  .t3-report .tiles{ display:flex; flex-wrap:wrap; gap:10px; margin:18px 0; }
  .t3-report .tile{ background:var(--card); border:1px solid var(--border); border-radius:10px; padding:12px 16px; min-width:78px; text-align:center; }
  .t3-report .tile-v{ font-size:22px; font-weight:700; } .t3-report .tile-l{ font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  .t3-report .chip{ display:inline-block; font-size:10.5px; font-weight:700; padding:2px 8px; border-radius:999px; letter-spacing:.04em; color:#fff; }
  .t3-report .chip.status{ background:#4b5563; text-transform:uppercase; }
  .t3-report .sev-critical,.t3-report .tile.sev-critical .tile-v{ background:#e5484d; } .t3-report .tile.sev-critical{ background:transparent; }
  .t3-report .chip.sev-critical{ background:#e5484d; } .t3-report .chip.sev-high{ background:#f76808; } .t3-report .chip.sev-medium{ background:#f5a524; color:#1c1f24; }
  .t3-report .chip.sev-low{ background:#3aa0ff; } .t3-report .chip.sev-info{ background:#8a8f98; }
  .t3-report .finding{ background:var(--card); border:1px solid var(--border); border-left-width:4px; border-radius:10px; padding:16px 18px; margin:14px 0; }
  .t3-report .sev-border-critical{ border-left-color:#e5484d; } .t3-report .sev-border-high{ border-left-color:#f76808; }
  .t3-report .sev-border-medium{ border-left-color:#f5a524; } .t3-report .sev-border-low{ border-left-color:#3aa0ff; } .t3-report .sev-border-info{ border-left-color:#8a8f98; }
  .t3-report .f-head{ display:flex; align-items:center; gap:10px; } .t3-report .f-meta{ display:flex; flex-wrap:wrap; gap:6px 16px; font-size:12px; color:var(--fg); margin:10px 0; }
  .t3-report .f-meta b{ color:var(--muted); font-weight:600; }
  .t3-report .block{ margin:10px 0; } .t3-report .block-h,.t3-report .sub-h{ font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin-bottom:2px; }
  .t3-report .crit{ margin:4px 0 4px 18px; padding:0; } .t3-report .crit li{ font-size:13px; }
  .t3-report .sub{ margin-top:12px; border-top:1px dashed var(--border); padding-top:10px; }
  .t3-report .evidence{ background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin:8px 0; }
  .t3-report .ev-head{ font-size:13px; } .t3-report .ev-tag{ font-size:10px; color:var(--muted); border:1px solid var(--border); border-radius:6px; padding:1px 6px; margin-left:6px; }
  .t3-report .ev-sum{ font-size:12.5px; color:var(--muted); margin-top:4px; } .t3-report .ev-uri{ font-size:12px; margin-top:4px; word-break:break-all; }
  .t3-report .cmd{ background:#0b0d10; color:#c9d1d9; border-radius:6px; padding:8px 10px; font-size:12px; overflow-x:auto; margin:6px 0 0; }
  .t3-report .retest{ font-size:13px; margin:4px 0; } .t3-report .row{ font-size:13px; margin:6px 0; padding:8px 10px; background:var(--card); border:1px solid var(--border); border-radius:8px; }
  .t3-report .foot{ margin-top:36px; border-top:1px solid var(--border); padding-top:12px; font-size:11.5px; color:var(--muted); }
</style>
<article class="t3-report">
  <h1>T3MP3ST Engagement Report</h1>
  <div class="sub-title">Run <code>${escapeHtml(s.missionId)}</code> · generated ${fmtDate(report.generatedAt)}</div>

  <div class="tiles">
    ${tile('Risk', s.riskRating.toUpperCase())}
    ${tile('Critical', sc.critical, 'critical')}
    ${tile('High', sc.high, 'high')}
    ${tile('Medium', sc.medium, 'medium')}
    ${tile('Low', sc.low, 'low')}
    ${tile('Info', sc.info, 'info')}
    ${tile('Evidence', s.evidenceCount)}
    ${tile('Retests', s.retestCount)}
  </div>

  <div class="meta-grid">
    <b>Targets</b><span>${s.targets.length ? s.targets.map(escapeHtml).join(', ') : '—'}</span>
    <b>Findings</b><span>${s.findingCount}</span>
    <b>Hypotheses</b><span>${s.hypothesisCount}</span>
    <b>Work orders</b><span>${s.workOrderCount}</span>
    <b>Activity window</b><span>${window}</span>
  </div>

  <h2>Findings (${report.findings.length})</h2>
  ${findingsHtml}
  ${hypothesesHtml}
  ${workOrdersHtml}
  ${unlinkedHtml}

  <div class="foot">
    Derived from T3MP3ST's persisted engagement ledgers. Findings without attached evidence are unproven
    hypotheses, not confirmed vulnerabilities. Authorized testing only — verify scope before acting.
  </div>
</article>`;
}

/** Full standalone HTML document (doctype + head) wrapping the report body. */
export function renderRunReportDocument(report: RunReport): string {
  const title = `T3MP3ST Report — ${report.summary.missionId}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
${renderRunReportHtml(report)}
</body>
</html>`;
}
