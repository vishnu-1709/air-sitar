import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

// Must match the installed @mediapipe/tasks-vision version (package.json)
const MP_VERSION = '1.2.3';
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export type Delegate = 'GPU' | 'CPU';

export async function createHandTracker(): Promise<{ landmarker: HandLandmarker; delegate: Delegate }> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);

  const make = (delegate: Delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

  // GPU is much faster; fall back to CPU if WebGL isn't usable
  try {
    return { landmarker: await make('GPU'), delegate: 'GPU' };
  } catch (e) {
    console.warn('GPU delegate failed, using CPU', e);
    return { landmarker: await make('CPU'), delegate: 'CPU' };
  }
}

/** MediaPipe landmark indices we care about */
export const LM = {
  WRIST: 0,
  THUMB_MCP: 2,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
  PINKY_TIP: 20,
} as const;

export const FINGERTIPS = [LM.THUMB_TIP, LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP];
