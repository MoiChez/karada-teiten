// 向きによらない 3D から作る 3D の体を落ち着かせる（斜め・正面・後ろから撮ったスクワット）。
// 実際の動画では、バーやプレート・体の陰で手首などが見えにくく、その推定がコマごとに揺れて、腕が暴れて見えた。
// 角度の値（motion3d.ts）には使わない。画面の 3D の体と、動画に重ねる位置だけに使う
import type { Vec3 } from './fusion3d'

export type FramePoints = Map<number, Vec3>

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a.x, a.y, a.z) || 1
  return { x: a.x / l, y: a.y / l, z: a.z / l }
}
const mid = (a: Vec3, b: Vec3): Vec3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 })
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })

/** 時刻のガウスの重みでの平均（σ ミリ秒、前後 3σ まで）。値は数の並び */
export function smoothSeries(values: number[], ts: number[], sigmaMs: number): number[] {
  return values.map((_, i) => {
    let s = 0
    let w = 0
    for (let j = i; j >= 0 && ts[i] - ts[j] <= 3 * sigmaMs; j--) {
      const g = Math.exp(-0.5 * ((ts[i] - ts[j]) / sigmaMs) ** 2)
      s += g * values[j]
      w += g
    }
    for (let j = i + 1; j < values.length && ts[j] - ts[i] <= 3 * sigmaMs; j++) {
      const g = Math.exp(-0.5 * ((ts[j] - ts[i]) / sigmaMs) ** 2)
      s += g * values[j]
      w += g
    }
    return s / w
  })
}

/** 点ごと・座標ごとに、時刻のガウスの重みで平均する */
export function smoothPointsInTime(frames: FramePoints[], ts: number[], sigmaMs: number): FramePoints[] {
  const keys = [...(frames[0]?.keys() ?? [])]
  const out: FramePoints[] = frames.map(() => new Map())
  for (const m of keys) {
    for (const c of ['x', 'y', 'z'] as const) {
      const s = smoothSeries(
        frames.map((f) => f.get(m)![c]),
        ts,
        sigmaMs,
      )
      s.forEach((v, i) => {
        const p = out[i].get(m) ?? { x: 0, y: 0, z: 0 }
        p[c] = v
        out[i].set(m, p)
      })
    }
  }
  return out
}

/** 胴の座標（原点は両肩の中点、x は体の左、y は股関節の中点から両肩の中点、z は x × y） */
function trunkFrame(f: FramePoints) {
  const sh = mid(f.get(11)!, f.get(12)!)
  const y = unit(sub(sh, mid(f.get(23)!, f.get(24)!)))
  const l = sub(f.get(11)!, f.get(12)!)
  const x = unit(sub(l, { x: y.x * dot(l, y), y: y.y * dot(l, y), z: y.z * dot(l, y) }))
  return { o: sh, x, y, z: cross(x, y) }
}

const ARM = [13, 14, 15, 16]

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b)
  const n = s.length
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}

/**
 * 腕（ひじ・手首）を、胴に対する位置の、前後 halfMs の中央値に置き直す。スクワットでは、手はバー・頭の後ろ・胸の前などに置いたまま、
 * 胴に対してほとんど動かないので、見えにくいコマの外れた推定に引っぱられないようにする（ゆっくりした持ち替えは残る）
 */
export function stabilizeArms(frames: FramePoints[], ts: number[], halfMs: number): FramePoints[] {
  const tf = frames.map(trunkFrame)
  const local = frames.map((f, i) =>
    ARM.map((m) => {
      const d = sub(f.get(m)!, tf[i].o)
      return [dot(d, tf[i].x), dot(d, tf[i].y), dot(d, tf[i].z)]
    }),
  )
  let lo = 0
  let hi = 0
  return frames.map((f, i) => {
    while (ts[i] - ts[lo] > halfMs) lo++
    while (hi + 1 < frames.length && ts[hi + 1] - ts[i] <= halfMs) hi++
    const out = new Map(f)
    ARM.forEach((m, a) => {
      const q = [0, 1, 2].map((c) => median(local.slice(lo, hi + 1).map((l) => l[a][c])))
      const { o, x, y, z } = tf[i]
      out.set(m, { x: o.x + q[0] * x.x + q[1] * y.x + q[2] * z.x, y: o.y + q[0] * x.y + q[1] * y.y + q[2] * z.y, z: o.z + q[0] * x.z + q[1] * y.z + q[2] * z.z })
    })
    return out
  })
}
