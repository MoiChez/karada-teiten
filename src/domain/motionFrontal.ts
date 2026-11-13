// 正面・真後ろから撮ったスクワットの、左右の差（正面から見た値）。
// - 撮った向き: 推定モデルの 3D の点で、左右の股関節を結ぶ線が画面の横向きに近ければ正面か後ろ、奥行きの向きに近ければ横。
//   鼻が耳より手前にあれば正面、奥にあれば後ろ
// - 左右: 推定モデルは後ろから撮ると体の左右を取り違えやすいので、画面の上で左にある点・右にある点として組にし、
//   後ろから撮ったときは画面の左を体の左、正面から撮ったときは画面の右を体の左とする
// どの値も、画面の上の見かけの位置から求めた値で、正常範囲とは比べず、良し悪しも判定しない
import type { Landmark, Point } from './types'
import { RAD2DEG } from './geometry'
import { quantile, vis } from './motionCore'

export type CameraView = 'side' | 'front' | 'rear' | 'oblique'

export interface ViewInfo {
  view: CameraView
  /** 左右の股関節の間隔 ÷ 胴の長さ（画面の上、中央値） */
  hipRatio: number
  /** 推定モデルの 3D で、左右の股関節を結ぶ線の、画面の横向きからの角度（度。0 で正面か後ろ、90 で横）。3D がなければ null */
  hipAxisDeg: number | null
  /** 鼻が耳より手前（カメラ側）にある度合い（メートル。+ なら正面向き）。3D がなければ null */
  noseForward: number | null
}

/** 横とみなす、腰の幅の比の上限（docs/05 の「真横の確認」と同じ） */
export const SIDE_HIP_RATIO = 0.2
/** 正面・後ろとみなす、股関節の線の角度の上限（度） */
const FRONTAL_AXIS_DEG = 30
/** 正面・後ろとみなす、腰の幅の比の下限 */
const FRONTAL_HIP_RATIO = 0.3

/** 撮った向きを、すべてのコマから決める */
export function viewOf(frames: { lm: Landmark[]; world?: Landmark[] }[], width: number, height: number): ViewInfo {
  const ratios: number[] = []
  const axes: number[] = []
  const noses: number[] = []
  for (const f of frames) {
    const p = f.lm
    if (p.length < 33) continue
    const P = (i: number) => ({ x: p[i].x * width, y: p[i].y * height })
    const hw = Math.hypot(P(23).x - P(24).x, P(23).y - P(24).y)
    const sm = { x: (P(11).x + P(12).x) / 2, y: (P(11).y + P(12).y) / 2 }
    const hm = { x: (P(23).x + P(24).x) / 2, y: (P(23).y + P(24).y) / 2 }
    const torso = Math.hypot(sm.x - hm.x, sm.y - hm.y)
    if (torso > 0 && vis(p[23]) > 0.3 && vis(p[24]) > 0.3) ratios.push(hw / torso)
    const w = f.world
    if (w && w.length >= 33) {
      axes.push(Math.atan2(Math.abs(w[23].z - w[24].z), Math.abs(w[23].x - w[24].x)) * RAD2DEG)
      noses.push((w[7].z + w[8].z) / 2 - w[0].z)
    }
  }
  const hipRatio = ratios.length ? quantile(ratios, 0.5) : 0
  const hipAxisDeg = axes.length ? quantile(axes, 0.5) : null
  const noseForward = noses.length ? quantile(noses, 0.5) : null
  let view: CameraView
  if (hipRatio <= SIDE_HIP_RATIO) view = 'side'
  else if (hipAxisDeg !== null && hipAxisDeg <= FRONTAL_AXIS_DEG && hipRatio >= FRONTAL_HIP_RATIO) view = noseForward !== null && noseForward > 0 ? 'front' : 'rear'
  else view = 'oblique'
  return { view, hipRatio, hipAxisDeg, noseForward }
}

/** 体の左へ向かう、画面の横の向き（後ろから撮ると画面の左 = -1、正面から撮ると画面の右 = +1） */
export const leftDirOf = (view: CameraView): 1 | -1 => (view === 'front' ? 1 : -1)

/** 左右の組（推定モデルの番号: 左, 右） */
export const PAIRS = {
  ear: [7, 8],
  shoulder: [11, 12],
  elbow: [13, 14],
  wrist: [15, 16],
  hip: [23, 24],
  knee: [25, 26],
  ankle: [27, 28],
  heel: [29, 30],
  foot: [31, 32],
} as const

/** 組の 2 点を、体の左・体の右に分ける（画面の上の位置で決める） */
export function bodySides(p: Point[], pair: readonly [number, number], leftDir: 1 | -1): { L: Point; R: Point } {
  const a = p[pair[0]]
  const b = p[pair[1]]
  // 体の左へ向かう向きに、より進んでいる方が体の左
  return leftDir * (a.x - b.x) >= 0 ? { L: a, R: b } : { L: b, R: a }
}

/** 組の 2 点の番号を、体の左・体の右の順に（3D で、点の番号を付け替えるため） */
export function bodySideIndex(p: Point[], pair: readonly [number, number], leftDir: 1 | -1): [number, number] {
  return leftDir * (p[pair[0]].x - p[pair[1]].x) >= 0 ? [pair[0], pair[1]] : [pair[1], pair[0]]
}

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/** 体の左が上がっていれば + の、左右の点を結ぶ線の傾き（度） */
function tiltDeg(L: Point, R: Point) {
  return Math.atan2(R.y - L.y, Math.abs(L.x - R.x)) * RAD2DEG
}

/** コマごとの、正面から見た値（傾きを戻したピクセル座標から） */
export function frontalValues(p: Point[], leftDir: 1 | -1) {
  const hip = bodySides(p, PAIRS.hip, leftDir)
  const knee = bodySides(p, PAIRS.knee, leftDir)
  const ankle = bodySides(p, PAIRS.ankle, leftDir)
  const sh = bodySides(p, PAIRS.shoulder, leftDir)
  const stance = Math.abs(ankle.L.x - ankle.R.x)
  if (!(stance > 1)) return null
  const hm = mid(hip.L, hip.R)
  const am = mid(ankle.L, ankle.R)
  return {
    /** 腰の横ずれ（足首の中点から、体の左が +。足首の間隔に対する %） */
    hipShift: ((leftDir * (hm.x - am.x)) / stance) * 100,
    /** 膝の間隔 ÷ 足首の間隔 */
    kneeRatio: Math.abs(knee.L.x - knee.R.x) / stance,
    /** 左の膝が、左の足首より外（体の左）にある量（足首の間隔に対する %。内側なら −） */
    kneeLOut: ((leftDir * (knee.L.x - ankle.L.x)) / stance) * 100,
    /** 右の膝が、右の足首より外（体の右）にある量 */
    kneeROut: ((-leftDir * (knee.R.x - ankle.R.x)) / stance) * 100,
    /** 骨盤（左右の股関節の線）の傾き（体の左が上がると +） */
    pelvisTilt: tiltDeg(hip.L, hip.R),
    /** 肩の線の傾き（体の左が上がると +） */
    shoulderTilt: tiltDeg(sh.L, sh.R),
    /** 股関節の中点〜足首の中点の高さ（ピクセル。深さに使う） */
    hipHeight: am.y - hm.y,
  }
}
