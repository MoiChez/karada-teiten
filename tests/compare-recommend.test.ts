import { describe, expect, it } from 'vitest'
import { behaviorBetween, compareSessions, metricSeries } from '../src/domain/compare'
import { applyCorrection, buildSession } from '../src/domain/session'
import { buildPlan, comparisonSuggestions, packSet, scoreRoutines } from '../src/domain/recommend/engine'
import { ROUTINES } from '../src/domain/recommend/routines'
import { fuse3D } from '../src/domain/fusion3d'
import { deriveHypotheses } from '../src/domain/hypotheses'
import type { UserProfile } from '../src/domain/types'
import { frontPose, record, sidePose } from './helpers'

const session = (createdAt: string, front = {}, side: object | null = {}) =>
  buildSession({
    createdAt,
    front: record('front', frontPose(front)),
    side: side ? record('side', sidePose(side)) : undefined,
    imagesSaved: false,
    modelVersion: 'full',
  })

const profile: UserProfile = {
  id: 'me',
  goals: ['posture'],
  hasClearGoal: true,
  lifestyle: ['desk_work', 'bag_one_side'],
  concernAreas: ['neck'],
  exerciseExperience: 'none',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

describe('過去比較', () => {
  const a = session('2026-10-01T09:00:00.000Z', { leftShoulderDrop: 40 }, { earForward: 40 })
  const b = session('2026-10-15T09:00:00.000Z', { leftShoulderDrop: 5 }, { earForward: 42 })

  it('差が小さくなれば改善傾向、ばらつき内なら横ばい', () => {
    const c = compareSessions(b, a) // 順序は日付で並べ替えられる
    expect(c.before.id).toBe(a.id)
    expect(c.days).toBe(14)
    const sh = c.changes.find((x) => x.key === 'front_shoulder_tilt')!
    expect(sh.change).toBe('improved')
    expect(sh.sentence).toContain('小さくなっています')
    const hf = c.changes.find((x) => x.key === 'side_head_forward')!
    expect(hf.change).toBe('stable')
    expect(c.top[0].key).toBe('front_shoulder_tilt')
    expect(c.counts.improved).toBeGreaterThan(0)
  })

  it('差が大きくなれば悪化傾向、向きだけ逆なら「向きが反対に」', () => {
    // 40px → 90px（約 6.3° → 14.0°）。2 回分のばらつき（約 4.9°）を超える
    const w = session('2026-10-20T09:00:00.000Z', { leftShoulderDrop: 90 }, null)
    expect(compareSessions(a, w).changes.find((x) => x.key === 'front_shoulder_tilt')!.change).toBe('worsened')
    const flip = buildSession({
      createdAt: '2026-10-21T09:00:00.000Z',
      front: record('front', frontPose({ leftShoulderDrop: 0 })),
      imagesSaved: false,
      modelVersion: 'full',
    })
    // 右肩を 40px 下げた姿勢を、左肩を 40px 上げることで作る
    const lm = flip.front!.landmarksRaw[11]
    const flipped = buildSession({
      createdAt: flip.createdAt,
      front: applyCorrection(flip.front!, 11, { x: lm.x, y: lm.y - 40 / 2000 }),
      imagesSaved: false,
      modelVersion: 'full',
    })
    expect(compareSessions(a, flipped).changes.find((x) => x.key === 'front_shoulder_tilt')!.change).toBe('flipped')
  })

  it('撮影条件の違いを注意する（補正の有無・側面の欠け・モデル）', () => {
    const lm = a.front!.landmarksRaw[11]
    const corrected = buildSession({
      createdAt: '2026-10-22T09:00:00.000Z',
      front: applyCorrection(a.front!, 11, { x: lm.x, y: lm.y + 0.01 }),
      imagesSaved: false,
      modelVersion: 'heavy',
    })
    const keys = compareSessions(a, corrected).warnings.map((w) => w.key)
    expect(keys).toEqual(expect.arrayContaining(['front_correction', 'side_missing', 'model']))
  })

  it('測り方（シンプル / 高精度）が違うと注意を出す。どちらかが記録前の測定なら出さない', () => {
    const keys = (x: typeof a, y: typeof b) => compareSessions(x, y).warnings.map((w) => w.key)
    expect(keys({ ...a, captureMode: 'simple' }, { ...b, captureMode: 'precise' })).toContain('mode')
    expect(keys({ ...a, captureMode: 'precise' }, { ...b, captureMode: 'precise' })).not.toContain('mode')
    expect(keys(a, { ...b, captureMode: 'precise' })).not.toContain('mode')
  })

  it('推移: 期間で絞り込み、日付順に並ぶ', () => {
    const s = metricSeries([b, a], 'front_shoulder_tilt', 30, new Date('2026-10-20T00:00:00.000Z'))
    expect(s.map((p) => p.sessionId)).toEqual([a.id, b.id])
    expect(metricSeries([a, b], 'front_shoulder_tilt', 7, new Date('2026-10-20T00:00:00.000Z'))).toHaveLength(1)
  })

  it('期間中の行動記録をまとめる', () => {
    const logs = [
      { id: '1', date: '2026-10-02T08:00:00.000Z', routineId: 'chin_tuck' },
      { id: '2', date: '2026-10-03T08:00:00.000Z', routineId: 'chin_tuck' },
      { id: '3', date: '2026-10-03T09:00:00.000Z', routineId: 'side_bend' },
      { id: '4', date: '2026-10-30T09:00:00.000Z', routineId: 'side_bend' },
    ]
    const checkins = [
      { id: 'c1', date: '2026-10-02T07:00:00.000Z', fatigueRating: 4 as const, discomfortAreas: [] },
      { id: 'c2', date: '2026-10-14T07:00:00.000Z', fatigueRating: 2 as const, discomfortAreas: [] },
    ]
    const sum = behaviorBetween(a.createdAt, b.createdAt, logs, checkins)
    expect(sum.logCount).toBe(3)
    expect(sum.activeDays).toBe(2)
    expect(sum.topRoutines[0]).toEqual({ routineId: 'chin_tuck', count: 2 })
    expect(sum.fatigue).toEqual({ first: 4, last: 2 })
  })
})

describe('運動・習慣の提案', () => {
  const s = session('2026-10-01T09:00:00.000Z', { leftShoulderDrop: 40 }, { earForward: 60 })

  it('差が見られた特徴に対応するメニューが優先される', () => {
    const plan = buildPlan({ traits: s.postureTraits, profile, now: new Date('2026-10-02T00:00:00.000Z') })
    const priority = plan.routines.filter((r) => r.slot === 'priority').map((r) => r.routineId)
    expect(priority.length).toBeGreaterThan(0)
    const targets = priority.flatMap((id) => ROUTINES.find((r) => r.id === id)!.targetTags)
    expect(targets.some((t) => t === 'forward_head' || t === 'shoulder_asymmetry')).toBe(true)
    for (const r of plan.routines) expect(r.reasons.length).toBeGreaterThan(0)
  })

  it('時間別のセットは指定時間を超えない', () => {
    const scored = scoreRoutines({ traits: s.postureTraits, profile })
    for (const min of [3, 5, 10]) {
      const total = packSet(scored, min).reduce((t, x) => t + x.routine.durationMin, 0)
      expect(total).toBeLessThanOrEqual(min)
      expect(total).toBeGreaterThan(0)
    }
  })

  it('運動経験がなければ難易度 3 は出さず、疲れている日は回復系が上がる', () => {
    const tiredPlan = buildPlan({ traits: [], profile, fatigue: 5 })
    const today = ROUTINES.find((r) => r.id === tiredPlan.routines.find((x) => x.slot === 'today')!.routineId)!
    expect(today.category === 'breathing' || today.targetTags.includes('recovery')).toBe(true)
    for (const r of tiredPlan.routines.filter((x) => x.slot === 'tired')) {
      expect(ROUTINES.find((x) => x.id === r.routineId)!.difficulty).toBe(1)
    }
  })

  it('同じ入力からは同じ提案になる', () => {
    const p1 = buildPlan({ traits: s.postureTraits, profile, now: new Date('2026-10-02T00:00:00.000Z') })
    const p2 = buildPlan({ traits: s.postureTraits, profile, now: new Date('2026-10-02T00:00:00.000Z') })
    expect(p1.routines).toEqual(p2.routines)
  })

  it('比較結果から継続・強化・回復を出す', () => {
    const later = session('2026-10-15T09:00:00.000Z', { leftShoulderDrop: 5 }, { earForward: 90 })
    const c = compareSessions(s, later)
    const logs = [
      { id: '1', date: '2026-10-05T08:00:00.000Z', routineId: 'side_bend' },
      { id: '2', date: '2026-10-06T08:00:00.000Z', routineId: 'side_bend' },
    ]
    const sug = comparisonSuggestions(c, logs, { profile })
    expect(sug.continue[0].routineId).toBe('side_bend')
    expect(sug.strengthen.length).toBeGreaterThan(0)
    expect(sug.strengthen.some((r) => ROUTINES.find((x) => x.id === r.routineId)!.targetTags.includes('forward_head'))).toBe(true)
    expect(sug.recovery.length).toBeGreaterThan(0)
  })

  it('生活習慣との関連仮説は「可能性」として出す', () => {
    const hyp = deriveHypotheses(s.postureTraits, profile)
    expect(hyp.map((h) => h.id)).toEqual(expect.arrayContaining(['screen_forward_head', 'bag_shoulder']))
    for (const h of hyp) expect(h.text).toMatch(/かもしれません|可能性|言われています|考えられます/)
  })
})

describe('簡易 3D', () => {
  it('正面 + 側面から 3D 座標を作り、耳が前に出ていれば Z が +', () => {
    const s = session('2026-10-01T09:00:00.000Z', {}, { earForward: 60 })
    const pose = fuse3D(s.front, s.side)!
    expect(pose.depthSource).toBe('side_photo')
    expect(pose.points[7]!.z).toBeGreaterThan(0)
    expect(pose.points[7]!.z).toBeCloseTo(pose.points[8]!.z, 6)
    // 被写体の左が +X
    expect(pose.points[11]!.x).toBeGreaterThan(0)
    expect(pose.points[12]!.x).toBeLessThan(0)
    // 足首の中点が原点、耳の高さは 1 付近
    expect(pose.points[7]!.y).toBeCloseTo(1500 / 1540, 2)
  })

  it('正面がなければ作らない', () => {
    expect(fuse3D(undefined, record('side', sidePose()))).toBeNull()
  })
})
