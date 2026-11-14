// 横から撮った画像の、胴の前と後ろの輪郭の位置。人の領域（推定モデルが出すマスク）と体の点から測る。
// 3D の胴の前後の厚みを動画の人に合わせるため（表示だけに使い、数値は画面に出さない）。docs/05 の動きの 3D
import type { Landmark } from './types'
import type { MaskData } from './backContour'

/** 胴の線（股関節の中点→両肩の点の中点）の上で輪郭を測る高さ（股関節からの割合） */
export const TORSO_ROWS = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]

/**
 * 高さごとの、胴の線から前（お腹・胸）と後ろ（背中）の輪郭までの距離（線に垂直に。カメラ側の脚の長さ（股関節〜膝〜足首）に
 * 対する比）。腕や脚が重なって測れない高さは null
 */
export interface TorsoProfile {
  front: (number | null)[]
  back: (number | null)[]
}

interface P {
  x: number
  y: number
}

/** 端が腕・脚の線からこれより近ければ（脚の長さに対する比）、腕・脚が重なっているとみなす */
const LIMB_NEAR = 0.12
/** 端を探すとき、人の領域の外がこれだけ続けば（マスクのピクセル）端とする */
const GAP = 3
/** 記録の値にするのに要る、高さごとの画像の数 */
const MIN_SAMPLES = 3

const LIMBS: [number, number][] = [
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [15, 19],
  [16, 20],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
]

function segDist(p: P, a: P, b: P) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

/**
 * 1 枚の画像の、高さごとの胴の前と後ろの輪郭の位置。lm は画像に対する比の体の点、width・height は画像の大きさ。
 * 胴の線に垂直に、前と後ろへ人の領域の端まで測る。端が腕・脚の線に近い側（腕や脚が胴に重なっている）は null。
 * 体の点が足りないときは null
 */
export function torsoDepthRows(
  lm: Landmark[],
  mask: MaskData,
  width: number,
  height: number,
  /** 確かめ用: 測った高さごとの前と後ろの端（ピクセル）と、使ったかどうか */
  rowsOut?: { front: P; back: P; frontUsed: boolean; backUsed: boolean }[],
): TorsoProfile | null {
  const need = [0, 11, 12, 23, 24, 25, 26, 27, 28]
  if (need.some((i) => !lm[i])) return null
  const px = (i: number): P => ({ x: lm[i].x * width, y: lm[i].y * height })
  const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const H = mid(px(23), px(24))
  const S = mid(px(11), px(12))
  const len = Math.hypot(S.x - H.x, S.y - H.y)
  if (!(len > 1)) return null
  const u = { x: (S.x - H.x) / len, y: (S.y - H.y) / len }
  let n = { x: -u.y, y: u.x }
  // 前（鼻のある側）を +n にする
  const nose = px(0)
  if ((nose.x - S.x) * n.x + (nose.y - S.y) * n.y < 0) n = { x: -n.x, y: -n.y }
  // カメラ側（よく見えている側）の脚の長さで割る（動きの記録の体の大きさの物差しと同じ）
  const leg = (h: number, k: number, a: number) => Math.hypot(px(k).x - px(h).x, px(k).y - px(h).y) + Math.hypot(px(a).x - px(k).x, px(a).y - px(k).y)
  const seen = (ids: number[]) => ids.reduce((sum, i) => sum + Math.min(lm[i].visibility ?? 1, lm[i].presence ?? 1), 0)
  const legLen = seen([23, 25, 27]) >= seen([24, 26, 28]) ? leg(23, 25, 27) : leg(24, 26, 28)
  if (!(legLen > 1)) return null
  const sx = mask.width / width
  const sy = mask.height / height
  const inside = (p: P) => {
    const mx = Math.floor(p.x * sx)
    const my = Math.floor(p.y * sy)
    if (mx < 0 || my < 0 || mx >= mask.width || my >= mask.height) return false
    return mask.data[my * mask.width + mx] > 0.5
  }
  const step = 1 / Math.max(sx, sy)
  const edge = (p: P, d: P) => {
    let last = 0
    let out = 0
    for (let t = step; t < len * 1.5; t += step) {
      if (inside({ x: p.x + d.x * t, y: p.y + d.y * t })) {
        last = t
        out = 0
      } else if (++out >= GAP) break
    }
    return last
  }
  const limbs = LIMBS.filter(([a, b]) => lm[a] && lm[b]).map(([a, b]) => [px(a), px(b)] as const)
  const near = (p: P) => limbs.some(([a, b]) => segDist(p, a, b) < LIMB_NEAR * legLen)
  const front: (number | null)[] = []
  const back: (number | null)[] = []
  for (const f of TORSO_ROWS) {
    const p = { x: H.x + (S.x - H.x) * f, y: H.y + (S.y - H.y) * f }
    if (!inside(p)) {
      front.push(null)
      back.push(null)
      continue
    }
    const a = edge(p, n)
    const b = edge(p, { x: -n.x, y: -n.y })
    const fp = { x: p.x + n.x * a, y: p.y + n.y * a }
    const bp = { x: p.x - n.x * b, y: p.y - n.y * b }
    const frontUsed = !near(fp)
    const backUsed = !near(bp)
    rowsOut?.push({ front: fp, back: bp, frontUsed, backUsed })
    front.push(frontUsed ? a / legLen : null)
    back.push(backUsed ? b / legLen : null)
  }
  return { front, back }
}

/** 何枚かの画像から、記録の値（高さごとの中央値。測れた画像が 3 枚未満の高さは null）。どの高さも測れなければ null */
export function torsoProfileOf(samples: TorsoProfile[]): TorsoProfile | null {
  const side = (key: 'front' | 'back') =>
    TORSO_ROWS.map((_, i) => {
      const v = samples.map((s) => s[key][i]).filter((x): x is number => x !== null && Number.isFinite(x))
      if (v.length < MIN_SAMPLES) return null
      v.sort((a, b) => a - b)
      return v[Math.floor(v.length / 2)]
    })
  const out = { front: side('front'), back: side('back') }
  return out.front.some((v) => v !== null) || out.back.some((v) => v !== null) ? out : null
}
