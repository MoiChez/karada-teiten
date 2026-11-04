// 横向きの写真の「背中側の輪郭」（人の領域の後ろ側の端）を取り出し、
// 背中上部の丸みと、腰のすき間の深さを求める（docs/05-analysis-logic.md 3f）。
// 輪郭は服・髪・体つきを含んだ外形で、背骨そのものの形ではない
import type { EdgeLine, Point } from './types'

/** 輪郭を取り出す範囲と間隔（体の高さ H に対する比）。手動補正で肩・股関節が動いても足りるよう余白をとる */
export const BACK_EXTRACT = { above: 0.08, below: 0.14, step: 0.004 } as const

/**
 * 背中上部の区間: 肩の高さから、肩〜股関節の縦の距離のこの割合まで（おおよそ胸の背骨の範囲）。
 * 区間の決め方であって、基準値ではない
 */
export const BACK_UPPER_FRACTION = 0.6

/** 腕・手の点がこの距離（H 比）より背中の輪郭に近ければ、輪郭に腕が重なっているとみなす */
export const BACK_ARM_MARGIN = 0.03

/** 輪郭の点の間がこれ（H 比）より離れていたら、途切れているとみなす */
const MAX_GAP = 0.03

/** マスクの値（人である確からしさ）がこれ以上なら人の領域 */
const MASK_THRESHOLD = 0.5

export interface MaskData {
  data: ArrayLike<number>
  width: number
  height: number
}

/** どちらが背中側か: 顔が画像の右向き（既定）なら左端、左向きなら右端 */
export function backSideOf<T>(o: { left: T; right: T }, facing: 'left' | 'right' | undefined): T {
  return facing === 'left' ? o.right : o.left
}

/**
 * マスクの各行で、胴の中心（肩と股関節を結ぶ線）から画像の左（または右）へたどり、人の領域が終わるところを端とする。
 * 端の位置は、境目の 2 画素の値を線形補間して画素より細かく求める。
 * 体の中の小さな抜け（服の色などで値が下がった画素）は飛ばすが、離れた腕などはつなげない
 */
export function extractEdge(
  mask: MaskData,
  o: { shoulder: Point; hip: Point; heightFrac: number; side: 'left' | 'right' },
): EdgeLine {
  const { width: mw, height: mh, data } = mask
  const dir = o.side === 'left' ? -1 : 1
  const hf = o.heightFrac
  const span = o.hip.y - o.shoulder.y
  if (!(hf > 0) || !(span > 0)) return { points: [], note: '肩と股関節の位置から、輪郭を取る範囲を決められませんでした' }
  const v = (row: number, col: number) => data[row * mw + col] ?? 0
  const search = Math.max(3, Math.round(0.03 * mw))
  const maxHole = Math.max(2, Math.round(0.006 * mw))
  const points: Point[] = []
  let touched = 0
  const y0 = o.shoulder.y - BACK_EXTRACT.above * hf
  const y1 = o.hip.y + BACK_EXTRACT.below * hf
  const step = BACK_EXTRACT.step * hf
  let lastRow = -1
  for (let y = y0; y <= y1 + 1e-9; y += step) {
    const row = Math.floor(y * mh)
    if (row < 0 || row >= mh || row === lastRow) continue
    lastRow = row
    const t = (y - o.shoulder.y) / span
    const cx = o.shoulder.x + t * (o.hip.x - o.shoulder.x)
    let c = Math.min(mw - 1, Math.max(0, Math.floor(cx * mw)))
    if (v(row, c) < MASK_THRESHOLD) {
      let found = -1
      for (let k = 1; k <= search && found < 0; k++) {
        if (c + k < mw && v(row, c + k) >= MASK_THRESHOLD) found = c + k
        else if (c - k >= 0 && v(row, c - k) >= MASK_THRESHOLD) found = c - k
      }
      if (found < 0) continue
      c = found
    }
    let i = c
    let hitEdge = false
    for (;;) {
      const j = i + dir
      if (j < 0 || j >= mw) {
        hitEdge = true
        break
      }
      if (v(row, j) >= MASK_THRESHOLD) {
        i = j
        continue
      }
      let next = -1
      for (let g = 2; g <= maxHole; g++) {
        const k = i + dir * g
        if (k < 0 || k >= mw) break
        if (v(row, k) >= MASK_THRESHOLD) {
          next = k
          break
        }
      }
      if (next < 0) break
      i = next
    }
    if (hitEdge) {
      touched++
      continue
    }
    const vin = v(row, i)
    const vout = v(row, i + dir)
    const frac = vin > vout ? Math.min(1, Math.max(0, (vin - MASK_THRESHOLD) / (vin - vout))) : 0.5
    const x = (i + 0.5 + dir * frac) / mw
    points.push({ x: round5(x), y: round5((row + 0.5) / mh) })
  }
  if (touched > 0 && points.length < 10) return { points: [], note: '体が写真の端で切れているため、背中の輪郭を取れませんでした' }
  if (points.length < 10) return { points: [], note: '人の領域を十分に取り出せず、背中の輪郭を取れませんでした' }
  return { points }
}

/**
 * 続けて撮った各写真の輪郭（代表の写真の座標にそろえたもの）を平均する。
 * 最も長い輪郭の高さごとに、半分以上の写真で値がある所だけ x を平均する
 */
export function mergeContours(contours: (Point[] | null)[], maxGapY: number): Point[] {
  const list = contours.filter((c): c is Point[] => !!c && c.length >= 2).map((c) => [...c].sort((a, b) => a.y - b.y))
  if (list.length === 0) return []
  if (list.length === 1) return list[0]
  const grid = list.reduce((a, b) => (b.length > a.length ? b : a))
  const need = Math.max(2, Math.ceil(list.length / 2))
  const out: Point[] = []
  for (const g of grid) {
    const xs = list.map((c) => interpX(c, g.y, maxGapY)).filter((x): x is number => x !== null)
    if (xs.length >= need) out.push({ x: round5(xs.reduce((s, x) => s + x, 0) / xs.length), y: g.y })
  }
  return out
}

/** 高さ y での輪郭の x（線形補間）。範囲外や途切れている所では null */
export function interpX(c: Point[], y: number, maxGap: number): number | null {
  if (c.length === 0 || y < c[0].y || y > c[c.length - 1].y) return null
  let lo = 0
  let hi = c.length - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (c[m].y <= y) lo = m
    else hi = m
  }
  const a = c[lo]
  const b = c[hi]
  if (b.y - a.y > maxGap) return null
  if (b.y === a.y) return a.x
  return a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x)
}

// ---------- 形の計算（ピクセル座標） ----------

export interface BackUpper {
  /** 肩の高さの輪郭上の点 */
  top: Point
  /** 区間の下端（胸の下あたり）の輪郭上の点 */
  bottom: Point
  /** top と bottom を結ぶ線から、最も後ろへ出ている点 */
  apex: Point
  /** apex から線へ下ろした足 */
  foot: Point
  /** 膨らみの深さ（ピクセル、後ろへ出ていれば +） */
  depth: number
  /** top〜bottom の長さ（ピクセル） */
  chord: number
  /** 同じ深さ・長さの円弧として見たときの、両端の接線のなす角（度） */
  angleDeg: number
}

export interface BackLower {
  /** 背中とお尻に定規を当てたときの、背中側の接点 */
  upperTouch: Point
  /** 同じく、お尻側の接点 */
  lowerTouch: Point
  /** 定規から最も前へ離れている輪郭上の点（腰のいちばん深いところ） */
  deepest: Point
  /** deepest から定規へ下ろした足 */
  foot: Point
  /** すき間の深さ（ピクセル） */
  depth: number
}

export type BackResult<T> = { ok: T } | { fail: string }

export interface BackShapeInput {
  /** 背中側の輪郭（ピクセル座標） */
  contour: Point[]
  shoulderY: number
  hipY: number
  /** 体の高さ（ピクセル） */
  H: number
  /** 顔が画像の右を向いていれば +1 */
  f: number
  /** 腕・手の点（ピクセル、確認できたものだけ） */
  arms: Point[]
  /** 不確かさの計算用: 輪郭から取った点を後ろ向きにずらす量（ピクセル）。通常は 0 */
  jitter?: (key: string) => number
}

interface Sample {
  y: number
  /** 後ろ向きの座標（大きいほど後ろ） */
  u: number
}

function profile(inp: BackShapeInput): Sample[] {
  const s = inp.contour.map((p) => ({ y: p.y, u: -inp.f * p.x })).sort((a, b) => a.y - b.y)
  // 軽くならす（隣との 1:2:1）
  return s.map((p, i) => {
    const a = s[i - 1]
    const b = s[i + 1]
    if (!a || !b || p.y - a.y > MAX_GAP * inp.H || b.y - p.y > MAX_GAP * inp.H) return p
    return { y: p.y, u: (a.u + 2 * p.u + b.u) / 4 }
  })
}

function uAt(s: Sample[], y: number, maxGap: number): number | null {
  const x = interpX(
    s.map((p) => ({ x: p.u, y: p.y })),
    y,
    maxGap,
  )
  return x
}

const toPx = (f: number, p: Sample): Point => ({ x: -f * p.u, y: p.y })

/** 区間 [ya, yb] の中で輪郭が途切れていないか */
function continuous(s: Sample[], ya: number, yb: number, maxGap: number): boolean {
  const inside = s.filter((p) => p.y >= ya && p.y <= yb)
  if (inside.length < 2) return false
  if (inside[0].y - ya > maxGap || yb - inside[inside.length - 1].y > maxGap) return false
  return inside.every((p, i) => i === 0 || p.y - inside[i - 1].y <= maxGap)
}

/** 腕・手が区間 [ya, yb] で背中の輪郭に近すぎないか */
function armOverlap(inp: BackShapeInput, s: Sample[], ya: number, yb: number): boolean {
  const margin = BACK_ARM_MARGIN * inp.H
  return inp.arms.some((a) => {
    if (a.y < ya - margin || a.y > yb + margin) return false
    const y = Math.min(Math.max(a.y, s[0].y), s[s.length - 1].y)
    const ub = uAt(s, y, MAX_GAP * inp.H)
    return ub !== null && -inp.f * a.x > ub - margin
  })
}

const ARM_FAIL = '腕や手が背中・腰の輪郭に重なっている可能性があるため、測れません（腕は体の横に力を抜いて下ろしてください）'

/** 背中上部の丸み: 肩の高さと胸の下を結ぶ線から、輪郭がどれだけ後ろへ膨らんでいるか */
export function backUpper(inp: BackShapeInput): BackResult<BackUpper> {
  const j = inp.jitter ?? (() => 0)
  const span = inp.hipY - inp.shoulderY
  if (span < 0.1 * inp.H) return { fail: '肩と股関節の高さが近すぎるため、背中の区間を決められません' }
  const s = profile(inp)
  const gap = MAX_GAP * inp.H
  const yT = inp.shoulderY
  const yB = inp.shoulderY + BACK_UPPER_FRACTION * span
  const uT = uAt(s, yT, gap)
  const uB = uAt(s, yB, gap)
  if (uT === null || uB === null || !continuous(s, yT, yB, gap)) return { fail: '肩から胸の下までの背中の輪郭が、途中で途切れています' }
  if (armOverlap(inp, s, yT, yB)) return { fail: ARM_FAIL }
  const T = { y: yT, u: uT + j('top') }
  const B = { y: yB, u: uB + j('bottom') }
  const dy = B.y - T.y
  const du = B.u - T.u
  const L = Math.hypot(dy, du)
  let best: Sample | null = null
  let bestD = -Infinity
  for (const p of s) {
    if (p.y <= yT || p.y >= yB) continue
    const d = (dy * (p.u - T.u) - du * (p.y - T.y)) / L
    if (d > bestD) {
      bestD = d
      best = p
    }
  }
  if (!best) return { fail: '背中の輪郭の点が足りません' }
  const depth = bestD + j('apex')
  // 線へ下ろした足（線の単位法線は後ろ向き (−du, dy)/L … (y, u) の順）
  const foot = { y: best.y + (du / L) * bestD, u: best.u - (dy / L) * bestD }
  return {
    ok: {
      top: toPx(inp.f, T),
      bottom: toPx(inp.f, B),
      apex: toPx(inp.f, best),
      foot: toPx(inp.f, foot),
      depth,
      chord: L,
      angleDeg: (4 * Math.atan2(2 * depth, L) * 180) / Math.PI,
    },
  }
}

/**
 * 腰のすき間: 肩の高さからお尻の下までの輪郭に、後ろから定規を当てる（輪郭の後ろ側の凸包）。
 * 腰のあたりで定規から最も前へ離れている点までの距離を、すき間の深さとする
 */
export function backLower(inp: BackShapeInput): BackResult<BackLower> {
  const j = inp.jitter ?? (() => 0)
  const span = inp.hipY - inp.shoulderY
  if (span < 0.1 * inp.H) return { fail: '肩と股関節の高さが近すぎるため、背中の区間を決められません' }
  const s = profile(inp)
  const gap = MAX_GAP * inp.H
  const yA = inp.shoulderY
  const last = s.length ? s[s.length - 1].y : yA
  const yZ = Math.min(last, inp.hipY + 0.12 * inp.H)
  if (yZ <= inp.hipY || !continuous(s, yA, yZ, gap)) return { fail: '背中から腰・お尻までの輪郭が、途中で途切れています' }
  const seg = s.filter((p) => p.y >= yA && p.y <= yZ)
  // 後ろ側の凸包（u が大きい側）
  const hull: Sample[] = []
  for (const p of seg) {
    while (hull.length >= 2) {
      const o = hull[hull.length - 2]
      const a = hull[hull.length - 1]
      const cross = (a.y - o.y) * (p.u - o.u) - (a.u - o.u) * (p.y - o.y)
      if (cross >= 0) hull.pop()
      else break
    }
    hull.push(p)
  }
  const yLo = inp.shoulderY + 0.45 * span
  const yHi = inp.hipY + 0.02 * inp.H
  let best: { p: Sample; a: Sample; b: Sample; d: number } | null = null
  let h = 0
  for (const p of seg) {
    while (h < hull.length - 2 && hull[h + 1].y <= p.y) h++
    if (p.y < yLo || p.y > yHi) continue
    const a = hull[h]
    const b = hull[h + 1]
    if (!a || !b) continue
    const L = Math.hypot(b.y - a.y, b.u - a.u)
    const d = -((b.y - a.y) * (p.u - a.u) - (b.u - a.u) * (p.y - a.y)) / L
    if (!best || d > best.d) best = { p, a, b, d }
  }
  if (!best) return { fail: '腰の輪郭の点が足りません' }
  if (best.b.y >= seg[seg.length - 1].y - 0.01 * inp.H) {
    return { fail: 'お尻のいちばん後ろに出ているところが輪郭の範囲で見つからないため、すき間の深さを決められません' }
  }
  if (armOverlap(inp, s, best.a.y, best.b.y)) return { fail: ARM_FAIL }
  const A = { y: best.a.y, u: best.a.u + j('upperTouch') }
  const Bv = { y: best.b.y, u: best.b.u + j('lowerTouch') }
  const P = { y: best.p.y, u: best.p.u + j('deepest') }
  const dy = Bv.y - A.y
  const du = Bv.u - A.u
  const L = Math.hypot(dy, du)
  const depth = -(dy * (P.u - A.u) - du * (P.y - A.y)) / L
  const foot = { y: P.y - (du / L) * depth, u: P.u + (dy / L) * depth }
  return {
    ok: {
      upperTouch: toPx(inp.f, A),
      lowerTouch: toPx(inp.f, Bv),
      deepest: toPx(inp.f, P),
      foot: toPx(inp.f, foot),
      depth,
    },
  }
}

function round5(v: number) {
  return Math.round(v * 1e5) / 1e5
}
