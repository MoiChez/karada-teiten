// 画像 1 枚を分析して PlaneRecord を作る（推定 → 向き → 品質）
import type { DeviceTilt, Landmark, Plane, PlaneRecord } from '../domain/types'
import { detectSideOrientation, estimateYawDeg } from '../domain/quality'
import { requalify } from '../domain/session'
import { mergeBurst } from '../domain/burst'
import type { PreparedImage } from './image'
import { detectImage, type DetectionResult, type ModelKind } from './landmarker'

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

export interface BurstAnalysis {
  record: PlaneRecord
  /** 代表の写真（保存・表示に使う） */
  repImage: PreparedImage
  /** 平均に使えなかった枚数など、利用者に伝えること */
  notice?: string
}

/**
 * 続けて撮った複数枚を分析し、点を平均した PlaneRecord を作る。
 * 2 枚以上で骨格を検出できなければ、検出できた 1 枚（なければ 1 枚目）で分析する
 */
export async function analyzeBurst(params: {
  plane: Plane
  images: PreparedImage[]
  source: 'camera' | 'upload'
  model: ModelKind
  deviceTilts?: (DeviceTilt | undefined)[]
  facingOverride?: 'left' | 'right'
  onProgress?: (done: number, total: number) => void
}): Promise<BurstAnalysis> {
  const { plane, images } = params
  const dets: DetectionResult[] = []
  for (let i = 0; i < images.length; i++) {
    params.onProgress?.(i, images.length)
    dets.push(await detectImage(images[i].canvas, params.model))
  }
  params.onProgress?.(images.length, images.length)

  // 側面の向きは多数決
  let facing: 'left' | 'right' | undefined
  let nearSide: 'left' | 'right' | undefined
  if (plane === 'side') {
    const os = dets.map((d, i) => (d.landmarks ? detectSideOrientation(d.landmarks, images[i].width, images[i].height) : null)).filter((o) => o !== null)
    const major = <T extends string>(list: T[]) => {
      const n = new Map<T, number>()
      for (const v of list) n.set(v, (n.get(v) ?? 0) + 1)
      return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    }
    facing = params.facingOverride ?? major(os.map((o) => o.facing))
    nearSide = major(os.map((o) => o.nearSide))
  }

  const merged = mergeBurst(
    plane,
    dets.map((d, i) => ({ landmarks: d.landmarks ?? [], width: images[i].width, height: images[i].height })),
    nearSide,
  )

  if (!merged) {
    const i = Math.max(0, dets.findIndex((d) => d.landmarks))
    const record = await analyzePlane({ plane, image: images[i], source: params.source, model: params.model, deviceTilt: params.deviceTilts?.[i], facingOverride: params.facingOverride })
    const found = dets.filter((d) => d.landmarks).length
    return {
      record,
      repImage: images[i],
      notice:
        images.length > 1 && found > 0
          ? `${images.length} 枚のうち、全身の骨格を検出できたのが ${found} 枚だったため、1 枚で分析しました。判定には想定のばらつきを使います。`
          : undefined,
    }
  }

  const r = merged.repIndex
  const rep = images[r]
  const used = merged.usedIndices
  const worlds = used.map((i) => dets[i].worldLandmarks).filter((w): w is Landmark[] => !!w && w.length >= 33)
  const worldLandmarks = worlds.length
    ? worlds[0].map((_, j) => ({
        x: avg(worlds.map((w) => w[j].x)),
        y: avg(worlds.map((w) => w[j].y)),
        z: avg(worlds.map((w) => w[j].z)),
        visibility: avg(worlds.map((w) => w[j].visibility ?? 1)),
      }))
    : []
  const second = dets.map((d) => d.secondPersonScale).filter((v): v is number => v !== undefined)
  const record = requalify({
    plane,
    imageMetadata: {
      width: rep.width,
      height: rep.height,
      source: params.source,
      capturedAt: new Date().toISOString(),
      facing,
      nearSide,
      deviceTilt: params.deviceTilts?.[r],
      imageStats: rep.stats,
      secondPersonScale: second.length ? Math.max(...second) : undefined,
      yawDeg: plane === 'front' ? estimateYawDeg(worldLandmarks) : undefined,
    },
    landmarksRaw: merged.landmarks,
    worldLandmarksRaw: worldLandmarks,
    landmarksCorrected: merged.landmarks.map((l) => ({ ...l })),
    correctionLog: [],
    qualityFlags: [],
    burst: { frames: merged.frames, repIndex: used.indexOf(r), attempted: images.length, spreadFrac: merged.spreadFrac },
  })
  const dropped = images.length - used.length
  return {
    record,
    repImage: rep,
    notice: dropped > 0 ? `${images.length} 枚のうち ${dropped} 枚は全身の骨格を検出できなかったため、${used.length} 枚で平均しました。` : undefined,
  }
}

function avg(v: number[]) {
  return v.reduce((a, b) => a + b, 0) / v.length
}
