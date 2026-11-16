// スクワットの腕の構え（バーを担ぐ・頭の後ろで組む・胸の前で組む・前へ伸ばす・腰に当てる・下ろす）を、
// 3D の点から見分ける。3D の手の形（握る・開く・手のひらの向き）を、構えに合わせるために使う。
// 記録の中でいちばん多い構えを 1 つ選ぶ（コマごとに変えると、手の形がちらつくため）
import type { Pose3D, Vec3 } from './fusion3d'

export type ArmStyle = 'bar' | 'head' | 'clasp' | 'front' | 'hips' | 'down' | 'free'

export const ARM_STYLES: ArmStyle[] = ['bar', 'head', 'clasp', 'front', 'hips', 'down', 'free']

export const ARM_LABELS: Record<ArmStyle, string> = {
  bar: 'バーを担ぐ',
  head: '頭の後ろで組む',
  clasp: '胸の前で組む',
  front: '前へ伸ばす',
  hips: '腰に当てる',
  down: '下ろす',
  free: 'そのまま',
}

/** いちばん多い構えが、見分けられたコマのこの割合に満たなければ「そのまま」（手は開いた形） */
const MIN_SHARE = 0.4

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const len = (a: Vec3) => Math.sqrt(dot(a, a))
const mid = (a: Vec3, b: Vec3): Vec3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 })
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k })

/**
 * 1 コマの、片方の腕の構え。胴の長さ（股関節の中点〜両肩の点の中点）を 1 とし、肩から見た位置で決める。
 * a: 胴に沿って上が +、b: 体の前が +。横から撮った記録は左右（x）が当てにならないので、距離は前後・上下だけで測る
 */
export function armStyleOf(p: (Vec3 | null)[], side: 'l' | 'r', frontal: boolean): ArmStyle | null {
  const [s, e, w, hip, ear] = (side === 'l' ? [11, 13, 15, 23, 7] : [12, 14, 16, 24, 8]).map((i) => p[i])
  const [s2, hip2] = (side === 'l' ? [12, 24] : [11, 23]).map((i) => p[i])
  if (!s || !e || !w || !hip || !ear || !s2 || !hip2) return null
  const S = mid(s, s2)
  const Hm = mid(hip, hip2)
  const trunk = sub(S, Hm)
  const T = len(trunk)
  if (!(T > 1e-6)) return null
  const u = scale(trunk, 1 / T)
  // 体の前（+z）を、胴に垂直にしたもの
  const f0 = sub({ x: 0, y: 0, z: 1 }, scale(u, u.z))
  const lf = len(f0)
  if (!(lf > 1e-6)) return null
  const f = scale(f0, 1 / lf)
  const a = (q: Vec3) => dot(sub(q, s), u) / T
  const b = (q: Vec3) => dot(sub(q, s), f) / T
  const d = (q: Vec3, r: Vec3) => {
    const v = sub(q, r)
    return (frontal ? len(v) : Math.hypot(v.y, v.z)) / T
  }
  const ua = sub(s, e)
  const fa = sub(w, e)
  const cos = dot(ua, fa) / Math.max(1e-9, len(ua) * len(fa))
  const elbowFlex = 180 - (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
  // 腰に当てる: ひじを曲げて、手首が股関節の近く
  if (elbowFlex > 50 && d(w, hip) < 0.32) return 'hips'
  // 下ろす: ひじが伸びて、手首が腰より下・体の横
  if (elbowFlex < 40 && a(w) < -0.6 && Math.abs(b(w)) < 0.45) return 'down'
  // 前へ伸ばす: ひじが伸びて、手首が体の前
  if (elbowFlex < 40 && b(w) > 0.55) return 'front'
  // バーを担ぐ: 手首はひじより上で、肩の近く。ひじは肩より後ろで、肩より大きくは上がらない
  if (a(w) > a(e) + 0.05 && a(w) > -0.2 && b(e) < -0.08 && a(e) < 0.22 && b(w) < 0.2) return 'bar'
  // 頭の後ろで組む: 手首が耳の近くで、ひじが上がっている（横から見ると、ひじは頭の横に写る）
  if (a(w) > -0.05 && d(w, ear) < 0.45 && a(e) > -0.05 && b(w) < 0.25) return 'head'
  // 胸の前で組む（ダンベルやケトルベルを胸の前で持つときも）: ひじを曲げて、手首が胸の前
  if (elbowFlex > 55 && b(w) > 0.05 && b(w) < 0.75 && a(w) > -0.75 && a(w) < 0.35) return 'clasp'
  return 'free'
}

/**
 * 記録の腕の構え（いちばん多い構え）。frontal: 正面・後ろから撮った記録（左右の位置が使える）。
 * loadKg: 入力された持つ重さ。重さがあって「頭の後ろ」に見えるときは、バーを担いでいるとみなす
 * （下から見上げて撮ると、担いだバーと手が頭より上に写る）
 */
export function detectArms(poses: { pose: Pose3D }[], opts: { frontal?: boolean; loadKg?: number } = {}): ArmStyle {
  const count = new Map<ArmStyle, number>()
  let n = 0
  for (const { pose } of poses) {
    for (const side of ['l', 'r'] as const) {
      const st = armStyleOf(pose.points, side, !!opts.frontal)
      if (!st) continue
      n++
      count.set(st, (count.get(st) ?? 0) + 1)
    }
  }
  let best: ArmStyle = 'free'
  let top = 0
  for (const [st, c] of count) {
    if (st !== 'free' && c > top) {
      best = st
      top = c
    }
  }
  if (!n || top < MIN_SHARE * n) return 'free'
  if (best === 'head' && (opts.loadKg ?? 0) > 0) return 'bar'
  return best
}

export function isArmStyle(v: unknown): v is ArmStyle {
  return typeof v === 'string' && (ARM_STYLES as string[]).includes(v)
}
