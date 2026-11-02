// 画像 1 枚を分析して PlaneRecord を作る（推定 → 向き → 品質）
import type { DeviceTilt, Plane, PlaneRecord } from '../domain/types'
import { detectSideOrientation, estimateYawDeg } from '../domain/quality'
import { requalify } from '../domain/session'
import type { PreparedImage } from './image'
import { detectImage, type ModelKind } from './landmarker'

export async function analyzePlane(params: {
  plane: Plane
  image: PreparedImage
  source: 'camera' | 'upload'
  model: ModelKind
  deviceTilt?: DeviceTilt
  /** 側面の向きをユーザーが指定した場合 */
  facingOverride?: 'left' | 'right'
}): Promise<PlaneRecord> {
  const { plane, image } = params
  const det = await detectImage(image.canvas, params.model)
  const landmarks = det.landmarks ?? []
  let facing: 'left' | 'right' | undefined
  let nearSide: 'left' | 'right' | undefined
  if (plane === 'side' && landmarks.length) {
    const o = detectSideOrientation(landmarks, image.width, image.height)
    facing = params.facingOverride ?? o.facing
    nearSide = o.nearSide
  }
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
      yawDeg: plane === 'front' ? estimateYawDeg(det.worldLandmarks) : undefined,
    },
    landmarksRaw: landmarks,
    worldLandmarksRaw: det.worldLandmarks ?? [],
    landmarksCorrected: landmarks.map((l) => ({ ...l })),
    correctionLog: [],
    qualityFlags: [],
  })
}
