/**
 * Regression: the General's periodic SITREP monitor must self-terminate when the mission ends
 * on its own. It used to only stop on an explicit Stop/relaunch, so a naturally-ended run left
 * the 60s interval emitting the same SITREP forever (the "Op Admiral keeps spamming" report).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpGeneral } from '../general/index.js';

function mockCommand(getRunning: () => boolean) {
  return {
    on: vi.fn(),
    getStatus: () => ({ running: getRunning(), paused: false, opsec: {}, targets: {} }),
    vault: { getAllFindings: () => [] },
    mission: { getActiveMission: () => null },
    cell: { getAllOperators: () => [] },
  } as any;
}

const SITREP_JSON =
  '```json\n{"assessment":"a","findingsSummary":"b","needsAdaptation":false,"adaptation":null,"confidence":50,"nextActions":[]}\n```';

describe('OpGeneral SITREP monitor lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits while running, then stops itself the first tick after the mission ends', async () => {
    const prompt = vi.fn().mockResolvedValue(SITREP_JSON);
    const general = new OpGeneral({ prompt } as any);
    let running = true;

    general.startMonitoring(mockCommand(() => running));

    // Tick 1 (t=60s): mission running → a SITREP is produced.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect((general as any).monitoringActive).toBe(true);

    // Mission ends on its own; next tick must stop the monitor WITHOUT emitting again.
    running = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect((general as any).monitoringActive).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);

    // Interval is cleared: no further SITREP spam no matter how long we wait.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('keeps monitoring across a pause (running stays true while paused)', async () => {
    const prompt = vi.fn().mockResolvedValue(SITREP_JSON);
    const general = new OpGeneral({ prompt } as any);
    // pause keeps running=true; the monitor should NOT quit on a pause.
    general.startMonitoring(mockCommand(() => true));
    await vi.advanceTimersByTimeAsync(120_000);
    expect((general as any).monitoringActive).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(2);
  });
});
