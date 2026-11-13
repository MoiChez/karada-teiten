// スクワットのバーの軌道（軽い版）。バーそのものは検出せず、カメラ側の手首の点をバーの位置とみなす（バーを握っている前提）。
// 持つ重さを入れたときだけ求める。長さは重心の推定と同じ換算（立っているときの耳〜かかと = 身長 × 0.91）で、
// 身長が仮定のときは目安。前後の位置は、足の真ん中（かかととつま先の中点）からの距離で、前が +
import { segmentsOf } from './motionCore'
import { sidePoints } from './landmarks'
import { rateOf } from './motionSequence'
import type { PreparedMotion } from './motionSports'

export interface BarSeries {
  /** 足の真ん中からの前後の位置（メートル、前が +） */
  x: number[]
  /** 床（かかとの高さ）からの高さ（メートル） */
  y: number[]
  /** 上下の速さ（メートル/秒、上が +） */
  v: number[]
}

export function barSeries(prep: PreparedMotion): BarSeries | null {
  if (!prep.load || !(prep.body.loadKg > 0)) return null
  const s = sidePoints(prep.nearSide)
  const k = prep.load.mPerPx
  const x = prep.frames.map((fr) => prep.f * (fr.px[s.wrist].x - (fr.px[s.heel].x + fr.px[s.foot].x) / 2) * k)
  const y = prep.frames.map((fr) => (fr.px[s.heel].y - fr.px[s.wrist].y) * k)
  const ts = prep.frames.map((fr) => fr.t)
  const v = rateOf(y, ts, segmentsOf(ts.length, prep.breaks))
  return { x, y, v }
}
