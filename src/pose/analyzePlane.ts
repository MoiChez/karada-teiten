// 画像 1 枚を分析して PlaneRecord を作る（推定 → 向き → 背中の輪郭 → 品質）
import type { BodyOutline, DeviceTilt, EdgeLine, Landmark, Plane, PlaneRecord, Point } from '../domain/types'
import { detectSideOrientation, estimateYawDeg } from '../domain/quality'
import { requalify } from '../domain/session'
import { mergeBurst } from '../domain/burst'
import { extractEdge, mergeContours, type MaskData } from '../domain/backContour'
import { bodyHeightPx, visibilityOf } from '../domain/metrics'
import { sidePoints } from '../domain/landmarks'
import { MIN_VISIBILITY } from '../domain/constants'
import type { PreparedImage } from './image'
import { detectImage, type DetectionResult, type ModelKind } from './landmarker'

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
    const o = detectSideOrientation(landmarks, image.width, image.height)
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
      yawDeg: plane === 'front' ? estimateYawDeg(det.worldLandmarks) : undefined,
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
  // 側面: 各写真の体の輪郭（その写真の座標）。マスクは大きいのですぐ捨てる
  const outs: (BodyOutline | null)[] = []
  for (let i = 0; i < images.length; i++) {
    params.onProgress?.(i, images.length)
    const det = await detectImage(images[i].canvas, params.model, { withMask: plane === 'side' })
    if (plane === 'side') {
      const lms = det.landmarks ?? []
      const o = lms.length ? detectSideOrientation(lms, images[i].width, images[i].height) : null
      outs.push(outlineOf(det.mask, lms, images[i].width, images[i].height, o?.nearSide))
    }
    dets.push({ ...det, mask: undefined })
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

  // 体の輪郭: 各写真の左端・右端を、骨格と同じそろえ方で代表の写真の座標へ移し、高さごとに平均する
  let outline: BodyOutline | undefined
  let outlines: ({ left: Point[]; right: Point[] } | null)[] | undefined
  if (plane === 'side') {
    const toRep = (k: number, pts: Point[]) =>
      pts.map((p) => {
        const q = merged.toRep(k, p)
        return { x: Math.round(q.x * 1e5) / 1e5, y: Math.round(q.y * 1e5) / 1e5 }
      })
    outlines = used.map((idx, k) => {
      const o = outs[idx]
      if (!o || (!o.left.points.length && !o.right.points.length)) return null
      return { left: toRep(k, o.left.points), right: toRep(k, o.right.points) }
    })
    const hf = heightFrac(merged.landmarks, rep.width, rep.height, nearSide) ?? 0.7
    const sideOf = (s: 'left' | 'right'): EdgeLine => {
      const points = mergeContours(outlines!.map((o) => (o ? o[s] : null)), 0.03 * hf)
      const note = outs.find((o) => o?.[s].note)?.[s].note
      return points.length ? { points } : { points: [], note: note ?? '背中の輪郭を取れませんでした' }
    }
    outline = { left: sideOf('left'), right: sideOf('right') }
  }

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
    burst: { frames: merged.frames, repIndex: used.indexOf(r), attempted: images.length, spreadFrac: merged.spreadFrac, outlines },
    outline,
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
