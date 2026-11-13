// ローイングエルゴの、脚・上体・腕が動く順番（仕様書の「運動連鎖のタイミング」）。
// ドライブ（キャッチ→フィニッシュ）の中で、それぞれの動く速さがいちばん大きくなる時刻を、ドライブの % で表す。
// 脚: 腰の位置（シート）が後ろへ動く速さ、上体: 上体が後ろへ開く速さ、腕: ひじが曲がる速さ。
// 順番や間隔の良し悪しは判定しない
import { segmentsOf } from './motionCore'
import type { MotionCycle, PreparedMotion } from './motionSports'

export type SequencePart = 'leg' | 'trunk' | 'arm'
export const SEQUENCE_PARTS: SequencePart[] = ['leg', 'trunk', 'arm']
export const SEQUENCE_LABELS: Record<SequencePart, string> = { leg: '脚（シートが下がる速さ）', trunk: '上体（後ろへ開く速さ）', arm: '腕（ひじが曲がる速さ）' }

/** 前後 2 コマの差から求めた速さ（1 秒あたり）。区間の切れ目はまたがない */
export function rateOf(v: number[], ts: number[], segOf: number[], sign = 1): number[] {
  return v.map((_, k) => {
    let a = Math.max(0, k - 2)
    let b = Math.min(v.length - 1, k + 2)
    while (segOf[a] !== segOf[k]) a++
    while (segOf[b] !== segOf[k]) b--
    if (b <= a || ts[b] <= ts[a]) return 0
    return (sign * (v[b] - v[a]) * 1000) / (ts[b] - ts[a])
  })
}

/** コマごとの速さ（脚: 脚の長さの %/秒、上体・腕: °/秒。ドライブの向きを + にする） */
export function sequenceRates(prep: PreparedMotion): Record<SequencePart, number[]> {
  const ts = prep.frames.map((f) => f.t)
  const segOf = segmentsOf(ts.length, prep.breaks)
  return {
    leg: rateOf(prep.series.seat, ts, segOf),
    trunk: rateOf(prep.series.trunk, ts, segOf, -1),
    arm: rateOf(prep.series.elbow, ts, segOf),
  }
}

/** 1 本のドライブの中で、速さがいちばん大きくなる時刻（ドライブの %）。フィニッシュがなければ null */
export function drivePeaks(prep: PreparedMotion, c: MotionCycle, rates = sequenceRates(prep)): Record<SequencePart, number | null> {
  const fin = c.events.find((e) => e.key === 'finish')
  const out = { leg: null, trunk: null, arm: null } as Record<SequencePart, number | null>
  if (!fin || fin.index <= c.startIndex) return out
  const t0 = prep.frames[c.startIndex].t
  const t1 = prep.frames[fin.index].t
  for (const part of SEQUENCE_PARTS) {
    let best = -Infinity
    let at = -1
    for (let k = c.startIndex; k <= fin.index; k++) {
      if (rates[part][k] > best) {
        best = rates[part][k]
        at = k
      }
    }
    out[part] = at >= 0 && best > 0 ? ((prep.frames[at].t - t0) / (t1 - t0)) * 100 : null
  }
  return out
}

/**
 * 1 本（キャッチ→次のキャッチ）を 0〜100% にそろえた、速さの平均の曲線。
 * それぞれの速さは、その本の中の最大を 1 にしてから平均する（単位の違う 3 つを 1 つのグラフに並べるため）
 */
export function strokeProfile(prep: PreparedMotion, cycles: MotionCycle[], n = 101) {
  const rates = sequenceRates(prep)
  const sum: Record<SequencePart, number[]> = { leg: Array(n).fill(0), trunk: Array(n).fill(0), arm: Array(n).fill(0) }
  let count = 0
  const finishes: number[] = []
  for (const c of cycles) {
    if (c.endIndex <= c.startIndex) continue
    const fin = c.events.find((e) => e.key === 'finish')
    if (fin) finishes.push(((fin.t - c.start) / (c.end - c.start)) * 100)
    for (const part of SEQUENCE_PARTS) {
      const seg = rates[part].slice(c.startIndex, c.endIndex + 1)
      const max = Math.max(...seg)
      let j = c.startIndex
      for (let k = 0; k < n; k++) {
        const t = c.start + ((c.end - c.start) * k) / (n - 1)
        while (j < c.endIndex && prep.frames[j + 1].t <= t) j++
        const a = prep.frames[j].t
        const b = prep.frames[Math.min(j + 1, c.endIndex)].t
        const w = b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 0
        const v = rates[part][j] + (rates[part][Math.min(j + 1, c.endIndex)] - rates[part][j]) * w
        sum[part][k] += max > 0 ? v / max : 0
      }
    }
    count++
  }
  if (!count) return null
  const mean = (v: number[]) => v.map((x) => x / count)
  return {
    curves: { leg: mean(sum.leg), trunk: mean(sum.trunk), arm: mean(sum.arm) } as Record<SequencePart, number[]>,
    /** フィニッシュの位置（1 本の %、平均） */
    finish: finishes.length ? finishes.reduce((a, b) => a + b, 0) / finishes.length : null,
    strokes: count,
  }
}
