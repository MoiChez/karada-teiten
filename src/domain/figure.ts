// 定点グリッドに描くための座標変換。足首の中点を原点、体の高さ H を 1 とする
// 正面: x は被写体の左が +（画面では右）、側面: x は前方が +（画面では右）、y は上が +
import type { Landmark, PlaneRecord, Point } from './types'
import { MIN_VISIBILITY } from './constants'
import { LM, sidePoints } from './landmarks'
import { visibilityOf } from './metrics'
import { correctedSet } from './session'

export interface FigurePose {
  plane: 'front' | 'side'
  points: (Point | null)[]
  /** 側面で描く点（カメラ側の半身）。正面はすべて */
  visible: number[]
}

export function figurePose(rec: PlaneRecord | undefined, useCorrected = true): FigurePose | null {
  if (!rec || rec.landmarksRaw.length < 33) return null
  const lms: Landmark[] = useCorrected ? rec.landmarksCorrected : rec.landmarksRaw
  const { width, height } = rec.imageMetadata
  const corrected = useCorrected ? correctedSet(rec) : new Set<number>()
  const ok = (i: number) => {
    const l = lms[i]
    return !!l && l.x >= 0 && l.x <= 1 && l.y >= 0 && l.y <= 1 && (corrected.has(i) || visibilityOf(l) >= MIN_VISIBILITY)
  }
  const px = (i: number) => ({ x: lms[i].x * width, y: lms[i].y * height })

  if (rec.plane === 'front') {
    if (!ok(LM.leftAnkle) || !ok(LM.rightAnkle)) return null
    const a = { x: (px(27).x + px(28).x) / 2, y: (px(27).y + px(28).y) / 2 }
    const top = ok(7) && ok(8) ? (px(7).y + px(8).y) / 2 : ok(0) ? px(0).y : null
    if (top === null) return null
    const H = a.y - top
    if (H <= 0) return null
    const sLat = px(11).x - px(12).x + (px(23).x - px(24).x) >= 0 ? 1 : -1
    const points = lms.map((_, i) => (ok(i) ? { x: ((px(i).x - a.x) * sLat) / H, y: (a.y - px(i).y) / H } : null))
    return { plane: 'front', points, visible: points.map((_, i) => i) }
  }

  const s = sidePoints(rec.imageMetadata.nearSide ?? 'left')
  const f = rec.imageMetadata.facing === 'left' ? -1 : 1
  if (!ok(s.ankle) || !ok(s.ear)) return null
  const a = px(s.ankle)
  const H = a.y - px(s.ear).y
  if (H <= 0) return null
  const visible = [0, s.ear, s.shoulder, s.wrist, s.hip, s.knee, s.ankle, s.heel, s.foot, rec.imageMetadata.nearSide === 'right' ? 14 : 13]
  const points = lms.map((_, i) => (ok(i) && visible.includes(i) ? { x: ((px(i).x - a.x) * f) / H, y: (a.y - px(i).y) / H } : null))
  return { plane: 'side', points, visible }
}

/** 側面の骨格線（カメラ側の半身のみ） */
export function sideEdges(nearSide: 'left' | 'right'): [number, number][] {
  const s = sidePoints(nearSide)
  const elbow = nearSide === 'left' ? 13 : 14
  return [
    [s.ear, 0],
    [s.ear, s.shoulder],
    [s.shoulder, elbow],
    [elbow, s.wrist],
    [s.shoulder, s.hip],
    [s.hip, s.knee],
    [s.knee, s.ankle],
    [s.ankle, s.heel],
    [s.heel, s.foot],
    [s.ankle, s.foot],
  ]
}
