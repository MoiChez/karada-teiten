// 画面をまたぐ保存処理
import type { AssessmentSession } from '../domain/types'
import { buildConscious } from '../domain/session'
import { compareConscious } from '../domain/conscious'
import { hasBlocking } from '../domain/quality'
import { buildPlan } from '../domain/recommend/engine'
import type { PlaneDraft } from '../state/stores'
import { data } from './repo'

/** おすすめを作り直し、セッションの recommendationSnapshot を更新する（保存は呼び出し側） */
export async function refreshPlan(s: AssessmentSession): Promise<AssessmentSession> {
  const [profile, logs, checkins] = await Promise.all([data.getProfile(), data.listLogs(), data.listCheckins()])
  const plan = buildPlan({
    traits: s.postureTraits,
    profile,
    recentLogs: logs.slice(-30),
    fatigue: checkins.find((c) => c.id === s.checkinId)?.fatigueRating,
    basedOnAssessmentId: s.id,
    lastAssessmentAt: s.createdAt,
    conscious: compareConscious(s),
  })
  await data.savePlan(plan)
  return { ...s, recommendationSnapshot: { planId: plan.id, routineIds: plan.routines.map((r) => r.routineId) } }
}

/** 測定済みのセッションに「意識した姿勢」を付けて保存する */
export async function attachConscious(params: { sessionId: string; front?: PlaneDraft; side?: PlaneDraft; saveImages: boolean }): Promise<AssessmentSession> {
  const s = await data.getSession(params.sessionId)
  if (!s) throw new Error('記録が見つかりませんでした')
  const front = params.front && !hasBlocking(params.front.record.qualityFlags) ? params.front : undefined
  const side = params.side && !hasBlocking(params.side.record.qualityFlags) ? params.side : undefined
  if (!front && !side) throw new Error('骨格を検出できた写真がありません')
  const next = await refreshPlan({ ...s, conscious: buildConscious({ front: front?.record, side: side?.record }) })
  await data.saveConscious(next, params.saveImages ? { front: front?.imageBlob, side: side?.imageBlob } : undefined)
  return next
}
