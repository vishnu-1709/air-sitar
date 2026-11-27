import { dist, LOST_MS, PINCH_ENTER, type Hand, type Pt } from './hands';

// All lengths/radii in "stage heights" (aspect-corrected), see hands.ts dist()
export const MAX_STRINGS = 6;
export const MIN_LEN = 0.12;   // shorter than this → not created / deleted on release
export const GRAB_R = 0.08;    // pinch this close to an endpoint to grab it
export const EDGE = 0.03;      // release an endpoint within this of the stage edge → delete

export interface Str { id: number; a: Pt; b: Pt }
type End = 'a' | 'b';

type Role =
  | { kind: 'none' }                                  // not pinching (can pluck later)
  | { kind: 'free' }                                  // pinching empty air, waiting for a partner
  | { kind: 'create'; partner: number }               // pulling a new string with the other hand
  | { kind: 'grab'; s: Str; end: End; off: Pt };      // dragging an endpoint

interface HandState {
  role: Role;
  wasPinching: boolean;
  pt: Pt;         // this hand's hold point
  anchorOff: Pt | null; // pinch point relative to the knuckles
  minRatio: number;     // tightest pinch since this pinch started
  lastSeen: number;
}

let nextId = 1;

/**
 * String state machine. Each hand has a role; pinch start / pinch end / hand lost
 * are the events that move it between roles.
 */
export class StringField {
  strings: Str[] = [];
  preview: { a: Pt; b: Pt; ok: boolean } | null = null;
  private states = new Map<number, HandState>();
  private aspect = 16 / 9;
  private now = 0;

  update(hands: Hand[], aspect: number, nowMs: number) {
    this.aspect = aspect;
    this.now = nowMs;
    const seen = new Set<number>();

    // 1. Events per visible hand
    for (const h of hands) {
      seen.add(h.id);
      let st = this.states.get(h.id);
      if (!st) {
        st = { role: { kind: 'none' }, wasPinching: false, pt: h.pinchPoint, anchorOff: null, minRatio: 1, lastSeen: nowMs };
        this.states.set(h.id, st);
      }
      st.lastSeen = nowMs;
      // Hold point: follows the fingertips while the pinch is firmly closed
      // (so wrist flicks move the string at full speed). The moment the fingers
      // start to open, it switches to riding on the knuckles, which don't move
      // when you let go, so the release lands exactly where it was held.
      // At the switch both give the same point, so there's no jump either way.
      //
      // "Opening" is judged relative to how tight YOUR pinch was, not a fixed
      // number: a relaxed pinch that never got below 0.4 still counts as firm.
      if (h.pinching && !st.wasPinching) st.minRatio = h.pinchRatio;
      st.minRatio = Math.min(st.minRatio, h.pinchRatio);
      const firm = h.pinchRatio < Math.max(PINCH_ENTER + 0.05, st.minRatio + 0.12);
      if (h.pinching && (!st.wasPinching || firm)) {
        st.anchorOff = { x: h.pinchPoint.x - h.anchor.x, y: h.pinchPoint.y - h.anchor.y };
      }
      st.pt = st.anchorOff
        ? { x: h.anchor.x + st.anchorOff.x, y: h.anchor.y + st.anchorOff.y }
        : h.pinchPoint;

      if (h.pinching && !st.wasPinching) this.onPinchStart(st, st.pt);
      else if (!h.pinching && st.wasPinching) { this.onRelease(st); st.anchorOff = null; }
      st.wasPinching = h.pinching;
    }

    // 2. Hands gone for a while count as a release (e.g. dragged off-screen).
    //    Short dropouts are ignored: the string just stays where it was.
    for (const [id, st] of this.states) {
      if (seen.has(id) || nowMs - st.lastSeen < LOST_MS) continue;
      if (st.wasPinching) this.onRelease(st);
      this.states.delete(id);
    }

    // 3. Two free pinches → start creating
    const free = [...this.states].filter(([, st]) => st.role.kind === 'free');
    if (free.length === 2) {
      const [[idA, a], [idB, b]] = free;
      a.role = { kind: 'create', partner: idB };
      b.role = { kind: 'create', partner: idA };
    }

    // 4. Continuous updates: dragged endpoints and the preview line
    this.preview = null;
    for (const [id, st] of this.states) {
      const p = st.pt;
      if (st.role.kind === 'grab') {
        const { s, end, off } = st.role;
        // the endpoint glides onto your fingers over ~0.1 s instead of keeping its offset
        off.x *= 0.65;
        off.y *= 0.65;
        s[end] = { x: p.x + off.x, y: p.y + off.y };
      } else if (st.role.kind === 'create' && id < st.role.partner) {
        const q = this.states.get(st.role.partner)!.pt;
        this.preview = {
          a: p, b: q,
          ok: this.strings.length < MAX_STRINGS && dist(p, q, aspect) >= MIN_LEN,
        };
      }
    }
  }

  private onPinchStart(st: HandState, p: Pt) {
    const hit = this.nearestFreeEndpoint(p);
    if (hit) {
      // take it over from a hand that lost tracking while holding it
      for (const other of this.states.values()) {
        if (other.role.kind === 'grab' && other.role.s === hit.s && other.role.end === hit.end) {
          other.role = { kind: 'none' };
        }
      }
      const e = hit.s[hit.end];
      st.role = { kind: 'grab', s: hit.s, end: hit.end, off: { x: e.x - p.x, y: e.y - p.y } };
    } else {
      st.role = { kind: 'free' };
    }
  }

  private onRelease(st: HandState) {
    const role = st.role;
    st.role = { kind: 'none' };
    const p = st.pt;

    if (role.kind === 'grab') {
      const { s, end, off } = role;
      s[end] = { x: p.x + off.x, y: p.y + off.y };
      if (this.shouldDelete(s)) this.remove(s);
    } else if (role.kind === 'create') {
      const partner = this.states.get(role.partner);
      if (!partner) return;
      const q = partner.pt;
      if (this.strings.length < MAX_STRINGS && dist(p, q, this.aspect) >= MIN_LEN) {
        // The string is born; the hand still pinching keeps holding its end,
        // so you can keep adjusting it without re-grabbing
        const s: Str = { id: nextId++, a: p, b: q };
        this.strings.push(s);
        partner.role = { kind: 'grab', s, end: 'b', off: { x: 0, y: 0 } };
      } else {
        partner.role = { kind: 'free' };
      }
    }
  }

  /** Delete if released near the stage edge or shrunk too short */
  shouldDelete(s: Str): boolean {
    const nearEdge = (p: Pt) =>
      p.x < EDGE || p.x > 1 - EDGE || p.y < EDGE || p.y > 1 - EDGE;
    return nearEdge(s.a) || nearEdge(s.b) || this.length(s) < MIN_LEN;
  }

  length(s: Str): number {
    return dist(s.a, s.b, this.aspect);
  }

  private remove(s: Str) {
    this.strings = this.strings.filter((x) => x !== s);
  }

  /** Held by a hand seen this frame (a hand that just lost tracking doesn't count) */
  private isGrabbed(s: Str, end: End): boolean {
    for (const st of this.states.values()) {
      if (st.lastSeen === this.now && st.role.kind === 'grab' && st.role.s === s && st.role.end === end) return true;
    }
    return false;
  }

  private nearestFreeEndpoint(p: Pt): { s: Str; end: End } | null {
    let best: { s: Str; end: End } | null = null;
    let bestD = GRAB_R;
    for (const s of this.strings) {
      for (const end of ['a', 'b'] as End[]) {
        if (this.isGrabbed(s, end)) continue;
        const d = dist(p, s[end], this.aspect);
        if (d < bestD) { bestD = d; best = { s, end }; }
      }
    }
    return best;
  }

  /** For drawing: is this endpoint grabbed, or could an open hand grab it right now? */
  endpointState(s: Str, end: End, hands: Hand[]): 'idle' | 'hover' | 'grabbed' {
    if (this.isGrabbed(s, end)) return 'grabbed';
    for (const h of hands) {
      const st = this.states.get(h.id);
      if (st && st.role.kind === 'none' && dist(h.pinchPoint, s[end], this.aspect) < GRAB_R) {
        return 'hover';
      }
    }
    return 'idle';
  }

  /** Strings that are being held (used to show the "will delete" warning) */
  isHeld(s: Str): boolean {
    return this.isGrabbed(s, 'a') || this.isGrabbed(s, 'b');
  }

  /** Hands that are busy (holding/creating) — they won't be allowed to pluck */
  isBusy(handId: number): boolean {
    const k = this.states.get(handId)?.role.kind;
    return k === 'grab' || k === 'create';
  }

  clear() {
    this.strings = [];
    for (const st of this.states.values()) st.role = { kind: 'none' };
  }
}
