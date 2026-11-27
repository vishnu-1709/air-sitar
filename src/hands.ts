import type { Landmark } from '@mediapipe/tasks-vision';
import { OneEuro } from './filters';
import { LM } from './tracking';

export interface Pt { x: number; y: number }

/**
 * Pinch thresholds on (thumb–index distance) / (hand size). Hysteresis: enter < ENTER, exit > EXIT.
 * Tune live without redeploying via URL, e.g.  ?pe=0.45&px=0.55
 */
const q = new URLSearchParams(location.search);
export const PINCH_ENTER = Number(q.get('pe')) || 0.4;
export const PINCH_EXIT = Number(q.get('px')) || 0.5;

/** Keep a lost hand's filters this long, so a 1–2 frame dropout doesn't reset smoothing */
const LOST_MS = 150;

export interface Hand {
  id: number;            // stable id while the hand stays tracked
  pts: Pt[];             // 21 smoothed points, stage-normalized
  visible: boolean;      // seen this frame
  pinching: boolean;
  pinchRatio: number;    // raw ratio, for debugging/tuning
  pinchPoint: Pt;        // midpoint of thumb & index tips (the "grab" point)
  lastSeen: number;
  filters: OneEuro[];    // 21 × (x, y)
}

export interface Detection {
  pts: Pt[];             // raw stage-normalized
  world: Landmark[];     // 3D, metres, for size-independent pinch
}

let nextId = 1;

/**
 * Keeps hands consistent across frames.
 * MediaPipe returns hands in no fixed order, so we match each new detection
 * to the previous hand whose wrist is closest. Without this, the smoothing
 * filters would blend one hand into the other when the order flips.
 */
export class HandSet {
  hands: Hand[] = [];

  /** aspect = stage width / height, so distances are measured in real proportions */
  update(dets: Detection[], nowMs: number, aspect: number): Hand[] {
    const t = nowMs / 1000;
    const unmatched = new Set(this.hands);
    for (const h of this.hands) h.visible = false;

    // Greedy match: pair the closest (hand, detection) first
    const pairs: { h: Hand; d: number; cost: number }[] = [];
    for (const h of this.hands) {
      dets.forEach((det, d) => {
        pairs.push({ h, d, cost: dist(h.pts[LM.WRIST], det.pts[LM.WRIST], aspect) });
      });
    }
    pairs.sort((a, b) => a.cost - b.cost);

    const assigned = new Map<number, Hand>();
    for (const p of pairs) {
      if (assigned.has(p.d) || !unmatched.has(p.h) || p.cost > 0.35) continue;
      assigned.set(p.d, p.h);
      unmatched.delete(p.h);
    }

    dets.forEach((det, d) => {
      const h = assigned.get(d) ?? this.newHand();
      this.applyDetection(h, det, t, nowMs);
    });

    // Forget hands that have been gone too long
    this.hands = this.hands.filter((h) => nowMs - h.lastSeen < LOST_MS);
    return this.hands.filter((h) => h.visible);
  }

  private newHand(): Hand {
    const h: Hand = {
      id: nextId++,
      pts: [],
      visible: false,
      pinching: false,
      pinchRatio: 1,
      pinchPoint: { x: 0, y: 0 },
      lastSeen: 0,
      filters: Array.from({ length: 42 }, () => new OneEuro()),
    };
    this.hands.push(h);
    return h;
  }

  private applyDetection(h: Hand, det: Detection, t: number, nowMs: number) {
    // 1. Smooth every point
    h.pts = det.pts.map((p, i) => ({
      x: h.filters[i * 2].filter(p.x, t),
      y: h.filters[i * 2 + 1].filter(p.y, t),
    }));
    h.visible = true;
    h.lastSeen = nowMs;

    // 2. Pinch ratio from 3D world landmarks: independent of distance to camera
    //    and of hand rotation (a 2D measurement shrinks when the hand tilts)
    const w = det.world;
    const pinchDist = dist3(w[LM.THUMB_TIP], w[LM.INDEX_TIP]);
    const handSize = dist3(w[LM.WRIST], w[LM.MIDDLE_MCP]);
    h.pinchRatio = pinchDist / Math.max(handSize, 1e-6);

    // 3. Hysteresis: different thresholds for entering and leaving,
    //    so the state doesn't flicker when the ratio hovers near one value
    if (!h.pinching && h.pinchRatio < PINCH_ENTER) h.pinching = true;
    else if (h.pinching && h.pinchRatio > PINCH_EXIT) h.pinching = false;

    const a = h.pts[LM.THUMB_TIP];
    const b = h.pts[LM.INDEX_TIP];
    h.pinchPoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
}

/** Distance in stage-normalized units, measured in "stage heights" (aspect-corrected) */
export function dist(a: Pt, b: Pt, aspect: number): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

function dist3(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
