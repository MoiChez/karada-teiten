import { describe, expect, it } from 'vitest'
import { applyCorrection, buildSession, correctedSet, correctionDiffs, recomputeSession, resetCorrection } from '../src/domain/session'
import { computePlaneMetrics, planeInputFrom } from '../src/domain/metrics'
import { H, W, frontPose, record } from './helpers'

const m = (s: ReturnType<typeof buildSession>, key: string, raw = false) =>
  (raw ? s.computedMetricsRaw : s.computedMetrics).find((x) => x.key === key)!

describe('ランドマーク補正と再計算', () => {
  it('点を動かすと補正ログが残り、補正後の値で再計算される', () => {
    const rec = record('front', frontPose())
    // 左肩を 30px 下へ動かす
    const lm = rec.landmarksRaw[11]
    const moved = applyCorrection(rec, 11, { x: lm.x, y: lm.y + 30 / H }, '2026-11-01T10:00:00.000Z')
    expect(moved.correctionLog).toHaveLength(1)
    expect(moved.correctionLog[0]).toMatchObject({ index: 11, from: { x: lm.x, y: lm.y } })
    expect(moved.landmarksCorrected[11].y).toBeCloseTo(lm.y + 30 / H, 10)
    // 生のランドマークは変わらない
    expect(moved.landmarksRaw[11].y).toBe(lm.y)

    const s = buildSession({ front: moved, imagesSaved: false, modelVersion: 'test' })
    const after = m(s, 'front_shoulder_tilt')
    const before = m(s, 'front_shoulder_tilt', true)
    expect(after.rawValue!).toBeGreaterThan(4)
    expect(Math.abs(before.rawValue!)).toBeLessThan(1e-6)
    expect(after.correctedLandmarks).toEqual([11])

    // 補正後の値は、補正後ランドマークを直接計算した値と一致する
    const direct = computePlaneMetrics(planeInputFrom(moved, true)).find((x) => x.key === 'front_shoulder_tilt')!
    expect(after.rawValue).toBe(direct.rawValue)

    const diffs = correctionDiffs(s)
    expect(diffs.map((d) => d.key)).toContain('front_shoulder_tilt')
  })

  it('補正ログの最後の位置と補正後ランドマークが一致する（整合性）', () => {
    let rec = record('front', frontPose())
    const lm = rec.landmarksRaw[25]
    rec = applyCorrection(rec, 25, { x: lm.x + 0.05, y: lm.y })
    rec = applyCorrection(rec, 25, { x: lm.x + 0.08, y: lm.y + 0.01 })
    const last = rec.correctionLog.filter((e) => e.index === 25).at(-1)!
    expect(rec.landmarksCorrected[25].x).toBe(last.to.x)
    expect(rec.landmarksCorrected[25].y).toBe(last.to.y)
  })

  it('元の位置の近くに戻すと吸着し、補正済みに数えない', () => {
    let rec = record('front', frontPose())
    const lm = rec.landmarksRaw[12]
    rec = applyCorrection(rec, 12, { x: lm.x + 0.05, y: lm.y })
    expect(correctedSet(rec).has(12)).toBe(true)
    // 短辺 1000px の 1.2% = 12px 以内 → 5px ずれた位置に戻すと吸着
    rec = applyCorrection(rec, 12, { x: lm.x + 5 / W, y: lm.y })
    expect(rec.landmarksCorrected[12].x).toBe(lm.x)
    expect(correctedSet(rec).has(12)).toBe(false)
  })

  it('微調整（snap = false）は元の位置の近くでも吸着しない', () => {
    let rec = record('front', frontPose())
    const lm = rec.landmarksRaw[12]
    for (let i = 1; i <= 3; i++) rec = applyCorrection(rec, 12, { x: rec.landmarksCorrected[12].x, y: rec.landmarksCorrected[12].y + 1 / H }, undefined, false)
    expect(rec.landmarksCorrected[12].y).toBeCloseTo(lm.y + 3 / H, 10)
    expect(correctedSet(rec).has(12)).toBe(true)
  })

  it('リセットで検出位置に戻り、全リセットですべて戻る', () => {
    let rec = record('front', frontPose())
    rec = applyCorrection(rec, 11, { x: 0.7, y: 0.3 })
    rec = applyCorrection(rec, 23, { x: 0.6, y: 0.52 })
    expect(correctedSet(rec).size).toBe(2)
    rec = resetCorrection(rec, 11)
    expect(correctedSet(rec)).toEqual(new Set([23]))
    rec = resetCorrection(rec)
    expect(correctedSet(rec).size).toBe(0)
    expect(rec.landmarksCorrected[23]).toEqual(rec.landmarksRaw[23])
  })

  it('信頼度が低く評価不可だった点も、補正すれば評価できる', () => {
    let rec = record('front', frontPose({ vis: { 11: 0.2 } }))
    let s = buildSession({ front: rec, imagesSaved: false, modelVersion: 'test' })
    expect(m(s, 'front_shoulder_tilt').status).toBe('unassessable')
    const lm = rec.landmarksRaw[11]
    rec = applyCorrection(rec, 11, { x: lm.x, y: lm.y + 20 / H })
    s = buildSession({ front: rec, imagesSaved: false, modelVersion: 'test' })
    expect(m(s, 'front_shoulder_tilt').rawValue).not.toBeNull()
  })

  it('recomputeSession は同じ結果を再現する', () => {
    const s = buildSession({ front: record('front', frontPose({ leftShoulderDrop: 20 })), imagesSaved: false, modelVersion: 'test' })
    const r = recomputeSession(s)
    expect(r.computedMetrics).toEqual(s.computedMetrics)
    expect(r.postureTraits).toEqual(s.postureTraits)
  })
})
