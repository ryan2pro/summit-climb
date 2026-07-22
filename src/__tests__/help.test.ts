/**
 * Helping hand (援手) targeting — findHelpTarget is the pure resolution
 * used by the game page before sending a `pull` event: nearest hanging
 * teammate within range and at least 1m below you.
 */
import { describe, expect, it } from 'vitest';
import { findHelpTarget, type HelpCandidate } from '@/game/remotes';

const SELF = { x: 0, y: 10, z: 0 };

function cand(partial: Partial<HelpCandidate> & { id: string }): HelpCandidate {
  return { x: 0, y: 8, z: 0, hanging: true, ...partial };
}

describe('help: findHelpTarget', () => {
  it('picks a hanging teammate below you within 3.5m', () => {
    const t = findHelpTarget(SELF, [cand({ id: 'a', x: 1, y: 8.5, z: 1 })], 3.5);
    expect(t?.id).toBe('a');
  });

  it('rejects teammates not clearly below (needs ≥1m drop)', () => {
    expect(findHelpTarget(SELF, [cand({ id: 'a', y: 9.5 })], 3.5)).toBeNull();
    expect(findHelpTarget(SELF, [cand({ id: 'a', y: 10.5 })], 3.5)).toBeNull();
    expect(findHelpTarget(SELF, [cand({ id: 'a', y: 9 })], 3.5)).not.toBeNull();
  });

  it('rejects non-hanging teammates (walking away cancels)', () => {
    expect(findHelpTarget(SELF, [cand({ id: 'a', hanging: false })], 3.5)).toBeNull();
  });

  it('rejects out-of-range teammates (start 3.5m, ongoing 4m)', () => {
    const far = cand({ id: 'a', x: 2.5, y: 8.5, z: 2.5 }); // ~3.84m away
    expect(findHelpTarget(SELF, [far], 3.5)).toBeNull();
    expect(findHelpTarget(SELF, [far], 4)).not.toBeNull();
    const gone = cand({ id: 'b', x: 3, y: 8, z: 3 }); // >4m
    expect(findHelpTarget(SELF, [gone], 4)).toBeNull();
  });

  it('picks the nearest valid candidate', () => {
    const near = cand({ id: 'near', x: 0.5, y: 8.5, z: 0 });
    const mid = cand({ id: 'mid', x: 2, y: 8.5, z: 0 });
    expect(findHelpTarget(SELF, [mid, near], 3.5)?.id).toBe('near');
  });

  it('returns null with no candidates (solo mode is dormant)', () => {
    expect(findHelpTarget(SELF, [], 3.5)).toBeNull();
  });
});

describe('help: pull message serialization', () => {
  it('{t:pull,id,target} survives a JSON round-trip', () => {
    const msg = { t: 'pull', id: 'helper1', target: 'climber2' };
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });
});
