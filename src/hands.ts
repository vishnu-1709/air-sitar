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
/** While holding a string, letting go needs a clearer finger opening (fast moves blur the fingers) */
export const PINCH_EXIT_HOLD = Number(q.get('ph')) || 0.6;

/** Keep a lost hand this long, so short tracking dropouts don't reset it */
export const LOST_MS = 400;

/** Pinch must hold its new state this many frames in a row before it counts (debounce) */
const PINCH_ON_FRAMES = 2;
const PINCH_OFF_FRAMES = 3;
const PINCH_OFF_FRAMES_HOLD = 5;

export interface Hand {
  id: number;            // stable id while the hand stays tracked
  pts: Pt[];             // 21 smoothed points, stage-normalized
  visible: boolean;      // seen this frame
  pinching: boolean;      // debounced state (use this)
  rawPinch: boolean;      // after hysteresis, before debounce
  pinchCount: number;     // frames rawPinch has disagreed with pinching
  pinchRatio: number;    // raw ratio, for debugging/tuning
  pinchPoint: Pt;        // live midpoint of thumb & index tips
  anchor: Pt;            // thumb + index knuckles: stays put when the fingers open
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
  /** holding: ids of hands currently holding/creating a string (get a stickier pinch) */
  update(dets: Detection[], nowMs: number, aspect: number, holding: Set<number>): Hand[] {
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
      if (assigned.has(p.d) || !unmatched.has(p.h) || p.cost > 0.5) continue;
      assigned.set(p.d, p.h);
      unmatched.delete(p.h);
    }

    dets.forEach((det, d) => {
      const h = assigned.get(d) ?? this.newHand();
      this.applyDetection(h, det, t, nowMs, aspect, holding.has(h.id));
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
      rawPinch: false,
      pinchCount: 0,
      pinchRatio: 1,
      pinchPoint: { x: 0, y: 0 },
      anchor: { x: 0, y: 0 },
      lastSeen: 0,
      filters: Array.from({ length: 42 }, () => new OneEuro()),
    };
    this.hands.push(h);
    return h;
  }

  private applyDetection(h: Hand, det: Detection, t: number, nowMs: number, aspect: number, holding: boolean) {
    // 1. Smooth every point
    h.pts = det.pts.map((p, i) => ({
      x: h.filters[i * 2].filter(p.x, t),
      y: h.filters[i * 2 + 1].filter(p.y, t),
    }));
    h.visible = true;
    h.lastSeen = nowMs;

    // 2. Pinch ratio, measured two ways and averaged.
    //    3D (world landmarks) handles hand rotation but its depth guess is noisy;
    //    2D (screen) has no depth noise but says "closed" when fingers overlap
    //    edge-on. The average is steadier than either.
    const w = det.world;
    const r3 = dist3(w[LM.THUMB_TIP], w[LM.INDEX_TIP]) /
      Math.max(dist3(w[LM.WRIST], w[LM.MIDDLE_MCP]), 1e-6);
    const P = h.pts;
    const r2 = dist(P[LM.THUMB_TIP], P[LM.INDEX_TIP], aspect) /
      Math.max(dist(P[LM.WRIST], P[LM.MIDDLE_MCP], aspect), 1e-6);
    h.pinchRatio = (r2 + r3) / 2;
    const exit = holding ? PINCH_EXIT_HOLD : PINCH_EXIT;

    // 3. Hysteresis: different thresholds for entering and leaving,
    //    so the state doesn't flicker when the ratio hovers near one value
    if (!h.rawPinch && h.pinchRatio < PINCH_ENTER) h.rawPinch = true;
    else if (h.rawPinch && h.pinchRatio > exit) h.rawPinch = false;

    // 4. Debounce: one noisy frame must not drop a string you're dragging
    if (h.rawPinch !== h.pinching) {
      h.pinchCount++;
      const offFrames = holding ? PINCH_OFF_FRAMES_HOLD : PINCH_OFF_FRAMES;
      if (h.pinchCount >= (h.rawPinch ? PINCH_ON_FRAMES : offFrames)) {
        h.pinching = h.rawPinch;
        h.pinchCount = 0;
      }
    } else {
      h.pinchCount = 0;
    }

    const a = h.pts[LM.THUMB_TIP];
    const b = h.pts[LM.INDEX_TIP];
    h.pinchPoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const k1 = h.pts[LM.THUMB_MCP];
    const k2 = h.pts[LM.INDEX_MCP];
    h.anchor = { x: (k1.x + k2.x) / 2, y: (k1.y + k2.y) / 2 };
  }
}

/** Distance in stage-normalized units, measured in "stage heights" (aspect-corrected) */
export function dist(a: Pt, b: Pt, aspect: number): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

function dist3(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
