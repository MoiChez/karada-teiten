// MediaPipe Pose Landmarker の読み込みと推定。WASM とモデルは自サイトから配信する
import { FilesetResolver, PoseLandmarker, type MPMask } from '@mediapipe/tasks-vision'
import type { Landmark } from '../domain/types'
import type { MaskData } from '../domain/backContour'

export type ModelKind = 'full' | 'heavy'

/** 測定に使うモデル（シンプル・高精度のどちらのモードでも高精度モデル） */
export const POSE_MODEL: ModelKind = 'heavy'
type Mode = 'IMAGE' | 'VIDEO'

const TASKS_VISION_VERSION = '1.2.0'

export function modelVersion(model: ModelKind) {
  return `pose_landmarker_${model} / tasks-vision ${TASKS_VISION_VERSION}`
}

function assetUrl(path: string) {
  return new URL(`${import.meta.env.BASE_URL}${path}`, window.location.href).href
}

let filesetPromise: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null
const cache = new Map<string, Promise<PoseLandmarker>>()
const delegateUsed = new Map<string, 'GPU' | 'CPU'>()

export function getLandmarker(model: ModelKind, mode: Mode): Promise<PoseLandmarker> {
  const key = `${model}:${mode}`
  const hit = cache.get(key)
  if (hit) return hit
  const p = (async () => {
    filesetPromise ??= FilesetResolver.forVisionTasks(assetUrl('mediapipe/wasm'))
    const fileset = await filesetPromise
    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: assetUrl(`models/pose_landmarker_${model}.task`), delegate },
      runningMode: mode,
      numPoses: 2,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      // 人の領域（背中の輪郭を取るため）。読み出すのは測定のときだけ
      outputSegmentationMasks: mode === 'IMAGE',
    })
    try {
      const lm = await PoseLandmarker.createFromOptions(fileset, options('GPU'))
      delegateUsed.set(key, 'GPU')
      return lm
    } catch {
      const lm = await PoseLandmarker.createFromOptions(fileset, options('CPU'))
      delegateUsed.set(key, 'CPU')
      return lm
    }
  })()
  cache.set(key, p)
  p.catch(() => cache.delete(key))
  return p
}

export function usedDelegate(model: ModelKind, mode: Mode) {
  return delegateUsed.get(`${model}:${mode}`)
}

export interface DetectionResult {
  landmarks: Landmark[] | null
  worldLandmarks: Landmark[] | null
  /** 2 人目の大きさ / 1 人目の大きさ */
  secondPersonScale?: number
  /** 選んだ人の領域（0..1）。withMask のときだけ */
  mask?: MaskData
}

const copy = (list: { x: number; y: number; z: number; visibility?: number; presence?: number }[]): Landmark[] =>
  list.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility, presence: l.presence }))

function poseHeight(lms: { y: number }[]) {
  let min = Infinity
  let max = -Infinity
  for (const l of lms) {
    min = Math.min(min, l.y)
    max = Math.max(max, l.y)
  }
  return max - min
}

function pick(landmarks: { x: number; y: number; z: number; visibility?: number }[][], world: Landmark[][], masks?: MPMask[]): DetectionResult {
  if (!landmarks.length) return { landmarks: null, worldLandmarks: null }
  const order = landmarks.map((l, i) => ({ i, h: poseHeight(l) })).sort((a, b) => b.h - a.h)
  const main = order[0]
  const second = order[1]
  const m = masks?.[main.i]
  let mask: MaskData | undefined
  if (m) {
    try {
      // 結果を閉じると元の配列は使えなくなるので写す
      mask = { data: m.getAsFloat32Array().slice(), width: m.width, height: m.height }
    } catch {
      mask = undefined
    }
  }
  return {
    landmarks: copy(landmarks[main.i]),
    worldLandmarks: world[main.i] ? copy(world[main.i]) : null,
    secondPersonScale: second && main.h > 0 ? second.h / main.h : undefined,
    mask,
  }
}

export async function detectImage(
  source: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | ImageBitmap,
  model: ModelKind,
  opts: { withMask?: boolean } = {},
): Promise<DetectionResult> {
  const lm = await getLandmarker(model, 'IMAGE')
  const r = lm.detect(source)
  try {
    return pick(r.landmarks, r.worldLandmarks, opts.withMask ? r.segmentationMasks : undefined)
  } finally {
    r.close()
  }
}

export async function detectVideoFrame(video: HTMLVideoElement, model: ModelKind, timestamp: number): Promise<DetectionResult> {
  const lm = await getLandmarker(model, 'VIDEO')
  const r = lm.detectForVideo(video, timestamp)
  try {
    return pick(r.landmarks, r.worldLandmarks)
  } finally {
    r.close()
  }
}
