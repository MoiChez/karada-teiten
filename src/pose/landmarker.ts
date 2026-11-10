// MediaPipe Pose Landmarker の読み込みと推定。WASM とモデルは自サイトから配信する
import { FilesetResolver, PoseLandmarker, type MPMask } from '@mediapipe/tasks-vision'
import type { Landmark } from '../domain/types'
import type { MaskData } from '../domain/backContour'

export type ModelKind = 'heavy'

/** 測定に使うモデル */
export const POSE_MODEL: ModelKind = 'heavy'

const TASKS_VISION_VERSION = '1.2.0'

export function modelVersion(model: ModelKind) {
  return `pose_landmarker_${model} / tasks-vision ${TASKS_VISION_VERSION}`
}

function assetUrl(path: string) {
  return new URL(`${import.meta.env.BASE_URL}${path}`, window.location.href).href
}

let filesetPromise: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null
const cache = new Map<ModelKind, Promise<PoseLandmarker>>()

/** 写真 1 枚ずつの推定器（動画は createVideoLandmarker） */
export function getLandmarker(model: ModelKind): Promise<PoseLandmarker> {
  const hit = cache.get(model)
  if (hit) return hit
  const p = (async () => {
    filesetPromise ??= FilesetResolver.forVisionTasks(assetUrl('mediapipe/wasm'))
    const fileset = await filesetPromise
    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: assetUrl(`models/pose_landmarker_${model}.task`), delegate },
      runningMode: 'IMAGE' as const,
      numPoses: 2,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      // 人の領域（背中の輪郭を取るため）。読み出すのは測定のときだけ
      outputSegmentationMasks: true,
    })
    try {
      return await PoseLandmarker.createFromOptions(fileset, options('GPU'))
    } catch {
      return await PoseLandmarker.createFromOptions(fileset, options('CPU'))
    }
  })()
  cache.set(model, p)
  p.catch(() => cache.delete(model))
  return p
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
  const lm = await getLandmarker(model)
  const r = lm.detect(source)
  try {
    return pick(r.landmarks, r.worldLandmarks, opts.withMask ? r.segmentationMasks : undefined)
  } finally {
    r.close()
  }
}

/**
 * 動画のコマを順に推定するための、使い捨ての推定器（前のコマの位置を手がかりに追う）。
 * 使い終わったら close() する。時刻は呼ぶたびに増やす必要がある
 */
export async function createVideoLandmarker(model: ModelKind) {
  filesetPromise ??= FilesetResolver.forVisionTasks(assetUrl('mediapipe/wasm'))
  const fileset = await filesetPromise
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: assetUrl(`models/pose_landmarker_${model}.task`), delegate },
    runningMode: 'VIDEO' as const,
    numPoses: 2,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  })
  let lm: PoseLandmarker
  try {
    lm = await PoseLandmarker.createFromOptions(fileset, options('GPU'))
  } catch {
    lm = await PoseLandmarker.createFromOptions(fileset, options('CPU'))
  }
  let last = 0
  return {
    detect(source: TexImageSource, t: number): DetectionResult {
      const ts = Math.max(last + 1, Math.round(t))
      last = ts
      const r = lm.detectForVideo(source, ts)
      try {
        return pick(r.landmarks, r.worldLandmarks)
      } finally {
        r.close()
      }
    },
    close: () => lm.close(),
  }
}
