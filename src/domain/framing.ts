// 撮影位置を前回に合わせるためのガイド。画面に写る体の大きさと位置を、前回の写真と比べる。
// 測定値には使わない（立ち位置と端末の置き方をそろえるための目安）
import type { Landmark, Plane } from './types'
import { FRAMING_TOLERANCE, MIN_VISIBILITY } from './constants'
import { bodyHeightPx, visibilityOf } from './metrics'
import { LM, sidePoints } from './landmarks'

export interface Framing {
  /** 体の中心（px） */
  cx: number
  cy: number
  /** 体の高さ（耳〜かかと、px） */
  size: number
}

/** 正規化座標の点から、幅 w・高さ h の画面での体の位置と大きさを求める */
export function framingOf(plane: Plane, lms: Landmark[] | null | undefined, w: number, h: number, nearSide?: 'left' | 'right'): Framing | null {
  if (!lms || lms.length < 33) return null
  const ok = (i: number) => visibilityOf(lms[i]) >= MIN_VISIBILITY
  const p = (i: number) => ({ x: lms[i].x * w, y: lms[i].y * h })
  const side = nearSide ?? (visibilityOf(lms[LM.leftShoulder]) >= visibilityOf(lms[LM.rightShoulder]) ? 'left' : 'right')
  const size = bodyHeightPx(plane, p, ok, side)
  if (!size) return null
  const s = sidePoints(side)
  const core = plane === 'front' ? [11, 12, 23, 24, 27, 28] : [s.shoulder, s.hip, s.ankle]
  const pts = core.filter(ok).map(p)
  if (pts.length < 2) return null
  const ys = [s.ear, LM.leftEar, LM.rightEar, LM.leftHeel, LM.rightHeel].filter(ok).map((i) => p(i).y)
  return {
    cx: pts.reduce((a, q) => a + q.x, 0) / pts.length,
    cy: ys.length >= 2 ? (Math.min(...ys) + Math.max(...ys)) / 2 : pts.reduce((a, q) => a + q.y, 0) / pts.length,
    size,
  }
}

export interface FramingAdvice {
  ok: boolean
  /** 画面で見た向きでの案内（最も大きいずれから） */
  messages: string[]
}

/**
 * 前回と今の写り方を比べる。mirrored = 画面が鏡像表示（内カメラ）なら左右の案内を入れ替える
 */
export function framingAdvice(prev: Framing, cur: Framing, mirrored = false): FramingAdvice {
  const tol = FRAMING_TOLERANCE
  const ratio = cur.size / prev.size
  const dx = ((cur.cx - prev.cx) / prev.size) * (mirrored ? -1 : 1)
  const dy = (cur.cy - prev.cy) / prev.size
  const items: { v: number; text: string }[] = []
  if (ratio > 1 + tol) items.push({ v: ratio - 1, text: '前回より大きく写っています（カメラに近い）' })
  if (ratio < 1 - tol) items.push({ v: 1 - ratio, text: '前回より小さく写っています（カメラから遠い）' })
  if (dx > tol) items.push({ v: dx, text: '前回より画面の右に寄っています' })
  if (dx < -tol) items.push({ v: -dx, text: '前回より画面の左に寄っています' })
  if (dy > tol) items.push({ v: dy, text: '前回より画面の下に寄っています（端末の高さか向きが違う）' })
  if (dy < -tol) items.push({ v: -dy, text: '前回より画面の上に寄っています（端末の高さか向きが違う）' })
  items.sort((a, b) => b.v - a.v)
  return { ok: items.length === 0, messages: items.map((i) => i.text) }
}
