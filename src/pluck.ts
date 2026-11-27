import { dist, type Hand, type Pt } from './hands';
import type { Str } from './strings';
import { LM } from './tracking';

const COOLDOWN_MS = 80;     // per string: ignore re-triggers this soon (finger jitter on the string)
const AFTER_HOLD_MS = 200;  // a hand that just let go of a string can't pluck right away
const MAX_GAP_MS = 100;     // after a tracking gap, don't connect old and new fingertip positions
const MIN_SPEED = 0.15;     // stage heights / s — slower crossings are ignored (drifting hand)
const END_MARGIN = 0.03;    // ignore crossings right at an endpoint

export interface PluckEvent {
  str: Str;
  pos: number;     // 0..1 along the string (a → b)
  speed: number;   // fingertip speed, stage heights / s
  at: Pt;          // where it crossed (for visuals)
}

interface Track { pt: Pt; t: number; blockedUntil: number }

/**
 * Pluck = the plucking fingertip's motion this frame (a line segment from its
 * last position to now) crosses a string. Checking the whole segment, not just
 * the current point, means a fast flick can't jump over a string between frames.
 */
export class Plucker {
  private tracks = new Map<number, Track>();
  private lastPluck = new Map<number, number>(); // string id → time

  update(
    hands: Hand[], strings: Str[], isBusy: (id: number) => boolean,
    nowMs: number, aspect: number,
  ): PluckEvent[] {
    const events: PluckEvent[] = [];

    for (const h of hands) {
      const tip = h.pts[LM.INDEX_TIP];
      const tr = this.tracks.get(h.id);
      const busy = isBusy(h.id) || h.pinching;

      if (!tr) {
        this.tracks.set(h.id, { pt: tip, t: nowMs, blockedUntil: 0 });
        continue;
      }
      if (busy) tr.blockedUntil = nowMs + AFTER_HOLD_MS;

      const dt = nowMs - tr.t;
      const canPluck = !busy && nowMs >= tr.blockedUntil && dt > 0 && dt < MAX_GAP_MS;

      if (canPluck) {
        const speed = dist(tr.pt, tip, aspect) / (dt / 1000);
        if (speed >= MIN_SPEED) {
          for (const s of strings) {
            const hit = intersect(tr.pt, tip, s.a, s.b);
            if (!hit || hit.t < END_MARGIN || hit.t > 1 - END_MARGIN) continue;
            if (nowMs - (this.lastPluck.get(s.id) ?? -1e9) < COOLDOWN_MS) continue;
            this.lastPluck.set(s.id, nowMs);
            events.push({
              str: s, pos: hit.t, speed,
              at: { x: s.a.x + (s.b.x - s.a.x) * hit.t, y: s.a.y + (s.b.y - s.a.y) * hit.t },
            });
          }
        }
      }
      tr.pt = tip;
      tr.t = nowMs;
    }

    // forget hands that are gone
    const ids = new Set(hands.map((h) => h.id));
    for (const id of this.tracks.keys()) if (!ids.has(id)) this.tracks.delete(id);
    return events;
  }
}

/**
 * Segment p1→p2 (finger) vs q1→q2 (string).
 * Returns t = position along the string (0..1), or null if they don't cross.
 * Uses 2D cross products: solve p1 + u·r = q1 + t·s.
 */
export function intersect(p1: Pt, p2: Pt, q1: Pt, q2: Pt): { t: number; u: number } | null {
  const rx = p2.x - p1.x, ry = p2.y - p1.y;
  const sx = q2.x - q1.x, sy = q2.y - q1.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null; // parallel
  const qpx = q1.x - p1.x, qpy = q1.y - p1.y;
  const u = (qpx * sy - qpy * sx) / denom;
  const t = (qpx * ry - qpy * rx) / denom;
  if (u < 0 || u > 1 || t < 0 || t > 1) return null;
  return { t, u };
}
