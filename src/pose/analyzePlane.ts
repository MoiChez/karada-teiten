// 画像 1 枚を分析して PlaneRecord を作る（推定 → 向き → 背中の輪郭 → 品質）
import type { BodyOutline, DeviceTilt, Landmark, Plane, PlaneRecord } from '../domain/types'
import { detectSideOrientation } from '../domain/quality'
import { requalify } from '../domain/session'
import { extractEdge, type MaskData } from '../domain/backContour'
import { bodyHeightPx, visibilityOf } from '../domain/metrics'
import { sidePoints } from '../domain/landmarks'
import { MIN_VISIBILITY } from '../domain/constants'
import type { PreparedImage } from './image'
import { detectImage, type ModelKind } from './landmarker'

const usable = (l: Landmark | undefined) => !!l && l.x >= 0 && l.x <= 1 && l.y >= 0 && l.y <= 1 && visibilityOf(l) >= MIN_VISIBILITY

/** 体の高さ（画像の高さに対する比）。求められなければ null */
function heightFrac(landmarks: Landmark[], width: number, height: number, nearSide: 'left' | 'right' | undefined): number | null {
  if (landmarks.length < 33) return null
  const H = bodyHeightPx('side', (i) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height }), (i) => usable(landmarks[i]), nearSide)
  return H ? H / height : null
}

/**
 * 横向きの写真の、体の左端と右端を取り出す（どちらが背中側かは、計算のときに顔の向きで決める）。
 * 取れなければ理由つきの空の線
 */
function outlineOf(
  mask: MaskData | undefined,
  landmarks: Landmark[],
  width: number,
  height: number,
  nearSide: 'left' | 'right' | undefined,
): BodyOutline {
  const fail = (note: string): BodyOutline => ({ left: { points: [], note }, right: { points: [], note } })
  if (landmarks.length < 33) return fail('骨格を検出できなかったため、背中の輪郭を取れませんでした')
  if (!mask) return fail('人の領域を取り出せなかったため、背中の輪郭を取れませんでした')
  const s = sidePoints(nearSide ?? 'left')
  if (!usable(landmarks[s.shoulder]) || !usable(landmarks[s.hip])) return fail('肩と股関節の位置を確認できないため、背中の輪郭を取れませんでした')
  const hf = heightFrac(landmarks, width, height, nearSide)
  if (!hf) return fail('頭と足元の位置が分からないため、背中の輪郭を取る範囲を決められませんでした')
  const o = { shoulder: landmarks[s.shoulder], hip: landmarks[s.hip], heightFrac: hf }
  return { left: extractEdge(mask, { ...o, side: 'left' }), right: extractEdge(mask, { ...o, side: 'right' }) }
}

export async function analyzePlane(params: {
  plane: Plane
  image: PreparedImage
  source: 'camera' | 'upload'
  model: ModelKind
  deviceTilt?: DeviceTilt
  /** 側面の向きをユーザーが指定した場合 */
  facingOverride?: 'left' | 'right'
  /** 鏡の前で自撮りした写真（左右はすでに戻してある） */
  mirrorSelfie?: boolean
}): Promise<PlaneRecord> {
  const { plane, image } = params
  const det = await detectImage(image.canvas, params.model, { withMask: plane === 'side' })
  const landmarks = det.landmarks ?? []
  let facing: 'left' | 'right' | undefined
  let nearSide: 'left' | 'right' | undefined
  if (plane === 'side' && landmarks.length) {
    const o = detectSideOrientation(landmarks)
    facing = params.facingOverride ?? o.facing
    nearSide = o.nearSide
  }
  const outline = plane === 'side' ? outlineOf(det.mask, landmarks, image.width, image.height, nearSide) : undefined
  return requalify({
    plane,
    imageMetadata: {
      width: image.width,
      height: image.height,
      source: params.source,
      capturedAt: new Date().toISOString(),
      facing,
      nearSide,
      deviceTilt: params.deviceTilt,
      imageStats: image.stats,
      secondPersonScale: det.secondPersonScale,
      mirrorSelfie: params.mirrorSelfie || undefined,
    },
    landmarksRaw: landmarks,
    worldLandmarksRaw: det.worldLandmarks ?? [],
    landmarksCorrected: landmarks.map((l) => ({ ...l })),
    correctionLog: [],
    qualityFlags: [],
    outline,
  })
}
