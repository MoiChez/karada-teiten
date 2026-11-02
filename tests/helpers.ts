// テスト用の合成ランドマーク。ピクセル座標で体を組み立て、正規化座標に変換する
import type { Landmark, PlaneRecord, Point } from '../src/domain/types'
import { requalify } from '../src/domain/session'

export const W = 1000
export const H = 2000

type Pts = Record<number, Point>

function toLandmarks(pts: Pts, vis: Record<number, number> = {}, defaultVis = 0.99): Landmark[] {
  return Array.from({ length: 33 }, (_, i) => {
    const p = pts[i] ?? { x: W / 2, y: H / 2 }
    return { x: p.x / W, y: p.y / H, z: 0, visibility: vis[i] ?? (pts[i] ? defaultVis : 0.1), presence: 0.99 }
  })
}

export interface FrontOpts {
  leftShoulderDrop?: number
  leftHipDrop?: number
  leftEarDrop?: number
  leftKneeOut?: number
  rightKneeOut?: number
  shoulderShiftX?: number
  /** 被写体の左を画像の左に置く（鏡像） */
  mirror?: boolean
  shoulderHalfWidth?: number
  vis?: Record<number, number>
}

/** 正面: 被写体の左が画像の右（通常の撮影）。耳 y=300 → かかと y=1840 */
export function frontPose(o: FrontOpts = {}): Landmark[] {
  const cx = 500
  const s = o.mirror ? -1 : 1 // 被写体の左の x 方向
  const sw = o.shoulderHalfWidth ?? 180
  const shift = (o.shoulderShiftX ?? 0) * s
  const pts: Pts = {
    0: { x: cx, y: 320 },
    3: { x: cx + 40 * s, y: 290 },
    6: { x: cx - 40 * s, y: 290 },
    7: { x: cx + 70 * s, y: 300 + (o.leftEarDrop ?? 0) },
    8: { x: cx - 70 * s, y: 300 },
    11: { x: cx + sw * s + shift, y: 500 + (o.leftShoulderDrop ?? 0) },
    12: { x: cx - sw * s + shift, y: 500 },
    13: { x: cx + 200 * s, y: 760 },
    14: { x: cx - 200 * s, y: 760 },
    15: { x: cx + 210 * s, y: 1000 },
    16: { x: cx - 210 * s, y: 1000 },
    23: { x: cx + 100 * s, y: 1000 + (o.leftHipDrop ?? 0) },
    24: { x: cx - 100 * s, y: 1000 },
    25: { x: cx + (100 + (o.leftKneeOut ?? 0)) * s, y: 1400 },
    26: { x: cx - (100 + (o.rightKneeOut ?? 0)) * s, y: 1400 },
    27: { x: cx + 100 * s, y: 1800 },
    28: { x: cx - 100 * s, y: 1800 },
    29: { x: cx + 95 * s, y: 1840 },
    30: { x: cx - 95 * s, y: 1840 },
    31: { x: cx + 110 * s, y: 1860 },
    32: { x: cx - 110 * s, y: 1860 },
  }
  return toLandmarks(pts, o.vis)
}

export interface SideOpts {
  earForward?: number
  shoulderForward?: number
  hipForward?: number
  kneeBack?: number
  wristForward?: number
  facing?: 'left' | 'right'
  vis?: Record<number, number>
}

/** 側面: 右半身がカメラ側。facing=right なら顔が画像の右（+x が前） */
export function sidePose(o: SideOpts = {}): Landmark[] {
  const f = o.facing === 'left' ? -1 : 1
  const ax = 500
  const pts: Pts = {
    0: { x: ax + (o.earForward ?? 0) * f + 60 * f, y: 320 },
    8: { x: ax + (o.earForward ?? 0) * f, y: 300 },
    12: { x: ax + (o.shoulderForward ?? 0) * f, y: 500 },
    14: { x: ax + (o.shoulderForward ?? 0) * f, y: 760 },
    16: { x: ax + (o.wristForward ?? 0) * f, y: 1000 },
    24: { x: ax + (o.hipForward ?? 0) * f, y: 1000 },
    26: { x: ax - (o.kneeBack ?? 0) * f, y: 1400 },
    28: { x: ax, y: 1800 },
    30: { x: ax - 30 * f, y: 1840 },
    32: { x: ax + 120 * f, y: 1850 },
  }
  // 奥側（左半身）は同じ位置で visibility を低くする
  for (const [l, r] of [
    [7, 8],
    [11, 12],
    [13, 14],
    [15, 16],
    [23, 24],
    [25, 26],
    [27, 28],
    [29, 30],
    [31, 32],
  ]) {
    pts[l] = { ...pts[r] }
  }
  const vis: Record<number, number> = { 7: 0.3, 11: 0.35, 13: 0.3, 15: 0.3, 23: 0.35, 25: 0.3, 27: 0.3, 29: 0.3, 31: 0.3, ...o.vis }
  return toLandmarks(pts, vis)
}

export function record(plane: 'front' | 'side', landmarks: Landmark[], meta: Partial<PlaneRecord['imageMetadata']> = {}): PlaneRecord {
  return requalify({
    plane,
    imageMetadata: {
      width: W,
      height: H,
      source: 'upload',
      capturedAt: '2026-11-01T09:00:00.000Z',
      ...(plane === 'side' ? { facing: 'right' as const, nearSide: 'right' as const } : {}),
      ...meta,
    },
    landmarksRaw: landmarks,
    worldLandmarksRaw: [],
    landmarksCorrected: landmarks.map((l) => ({ ...l })),
    correctionLog: [],
    qualityFlags: [],
  })
}

export const deg = (rad: number) => (rad * 180) / Math.PI
