import { describe, expect, it } from 'vitest'
import type { AssessmentSession } from '../src/domain/types'
import { buildConscious, buildSession, recomputeSession } from '../src/domain/session'
import { compareConscious } from '../src/domain/conscious'
import { buildPlan, scoreRoutines } from '../src/domain/recommend/engine'
import { frontPose, record, sidePose } from './helpers'

const session = (habitual: { drop?: number; ear?: number }, conscious: { drop?: number; ear?: number }): AssessmentSession => {
  const s = buildSession({
    createdAt: '2026-11-01T09:00:00.000Z',
    front: record('front', frontPose({ leftShoulderDrop: habitual.drop ?? 0 })),
    side: record('side', sidePose({ earForward: habitual.ear ?? 0 })),
    imagesSaved: false,
    modelVersion: 'full',
  })
  return {
    ...s,
    conscious: buildConscious({
      capturedAt: '2026-11-01T09:05:00.000Z',
      front: record('front', frontPose({ leftShoulderDrop: conscious.drop ?? 0 })),
      side: record('side', sidePose({ earForward: conscious.ear ?? 0 })),
    }),
  }
}

const effectOf = (s: AssessmentSession, key: string) => compareConscious(s)!.items.find((i) => i.key === key)?.effect

describe('いつもの姿勢と意識した姿勢', () => {
  it('意識すると差がばらつきの範囲まで小さくなる', () => {
    expect(effectOf(session({ drop: 40 }, { drop: 0 }), 'front_shoulder_tilt')).toBe('resolved')
  })
  it('意識すると小さくなるが残る', () => {
    expect(effectOf(session({ drop: 80 }, { drop: 40 }), 'front_shoulder_tilt')).toBe('reduced')
  })
  it('意識しても変わりにくい', () => {
    expect(effectOf(session({ drop: 40 }, { drop: 40 }), 'front_shoulder_tilt')).toBe('remains')
  })
  it('意識すると反対の向きへ', () => {
    expect(effectOf(session({ drop: 40 }, { drop: -40 }), 'front_shoulder_tilt')).toBe('overshoot')
  })
  it('いつもは差がないが、意識すると差が出る', () => {
    expect(effectOf(session({ drop: 0 }, { drop: 40 }), 'front_shoulder_tilt')).toBe('increased')
  })
  it('どちらも差がない項目は一覧に入れず、数だけ数える', () => {
    const c = compareConscious(session({}, {}))!
    expect(c.items).toHaveLength(0)
    expect(c.quietCount).toBeGreaterThan(5)
    expect(c.planes).toEqual(['front', 'side'])
  })
  it('意識した姿勢がなければ null', () => {
    const s = session({}, {})
    expect(compareConscious({ ...s, conscious: undefined })).toBeNull()
  })
  it('再計算しても、意識した姿勢の指標は残る', () => {
    const s = session({ drop: 40 }, { drop: 0 })
    const r = recomputeSession({ ...s, conscious: { ...s.conscious!, computedMetrics: [] } })
    expect(r.conscious!.computedMetrics.length).toBeGreaterThan(0)
    expect(effectOf(r, 'front_shoulder_tilt')).toBe('resolved')
  })
})

describe('意識した姿勢による提案の分け方', () => {
  it('意識で変わる差は意識づけ（姿勢のコツ）、意識しても残る差は体を動かすメニューを上げる', () => {
    const changes = session({ ear: 80 }, { ear: 0 })
    const stays = session({ ear: 80 }, { ear: 80 })
    expect(effectOf(changes, 'side_head_forward')).toBe('resolved')
    expect(effectOf(stays, 'side_head_forward')).toBe('remains')
    const score = (s: typeof changes) => scoreRoutines({ traits: s.postureTraits, conscious: compareConscious(s) })
    const tipOf = (list: ReturnType<typeof score>) => list.find((r) => r.routine.category === 'posture_tip' && r.routine.targetTags.includes('forward_head'))!
    const bodyOf = (list: ReturnType<typeof score>) =>
      list.find((r) => r.routine.category !== 'posture_tip' && r.routine.targetTags.includes('forward_head'))!
    const a = score(changes)
    const b = score(stays)
    expect(tipOf(a).reasons.some((x) => x.includes('意識すると'))).toBe(true)
    expect(bodyOf(a).reasons.some((x) => x.includes('意識しても'))).toBe(false)
    expect(bodyOf(b).reasons.some((x) => x.includes('意識しても'))).toBe(true)
    expect(tipOf(a).score).toBeGreaterThan(tipOf(b).score)
  })

  it('意識すると反対へ行く差は、意識の向け方を確かめる習慣を提案する', () => {
    const s = session({ ear: 80 }, { ear: -80 })
    const plan = buildPlan({ traits: s.postureTraits, conscious: compareConscious(s) })
    expect(plan.habitSuggestions.some((h) => h.id === 'conscious_adjust')).toBe(true)
    expect(plan.habitSuggestions.some((h) => h.id === 'conscious_habit')).toBe(false)
  })
})
