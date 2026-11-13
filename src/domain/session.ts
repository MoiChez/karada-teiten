// 測定セッションの組み立て・補正・再計算
import type { AssessmentSession, ConsciousPose, Landmark, Plane, PlaneRecord, Point, QualityFlag } from './types'
import { ALGORITHM_VERSION, SNAP_FRACTION } from './constants'
import { assessQuality } from './quality'
import { computeAllMetrics, confidenceSummary } from './metrics'
import { deriveTraits } from './traits'

export const APP_VERSION = '0.16.1'

export function newId(prefix = ''): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return prefix ? `${prefix}_${rand}` : rand
}

export function correctedSet(rec: PlaneRecord): Set<number> {
  const s = new Set<number>()
  for (const e of rec.correctionLog) s.add(e.index)
  for (const i of [...s]) {
    const a = rec.landmarksCorrected[i]
    const b = rec.landmarksRaw[i]
    if (a && b && a.x === b.x && a.y === b.y) s.delete(i)
  }
  return s
}

/** 補正後のランドマークで品質フラグを判定し直す（画像由来の情報はメタデータから） */
export function requalify(rec: PlaneRecord): PlaneRecord {
  const meta = rec.imageMetadata
  const flags = assessQuality({
    plane: rec.plane,
    landmarks: rec.landmarksRaw.length ? rec.landmarksCorrected : null,
    worldLandmarks: rec.worldLandmarksRaw,
    width: meta.width,
    height: meta.height,
    imageStats: meta.imageStats,
    deviceTilt: meta.deviceTilt,
    secondPersonScale: meta.secondPersonScale,
    nearSide: meta.nearSide,
    correctedIdx: correctedSet(rec),
  })
  return { ...rec, qualityFlags: flags }
}

/**
 * 点を動かす。座標は正規化（0..1）。
 * snap = true（ドラッグ）のときは、元の検出位置の近く（短辺の SNAP_FRACTION 以内）なら元の位置に吸着する。
 * ボタンや矢印キーでの微調整は snap = false（少しずつ動かせるように）
 */
export function applyCorrection(rec: PlaneRecord, index: number, to: Point, at = new Date().toISOString(), snap = true): PlaneRecord {
  const raw = rec.landmarksRaw[index]
  const cur = rec.landmarksCorrected[index]
  if (!raw || !cur) return rec
  const { width, height } = rec.imageMetadata
  const snapPx = SNAP_FRACTION * Math.min(width, height)
  const dx = (to.x - raw.x) * width
  const dy = (to.y - raw.y) * height
  const snapped = snap && Math.hypot(dx, dy) <= snapPx
  const target: Point = snapped ? { x: raw.x, y: raw.y } : { x: clamp01(to.x), y: clamp01(to.y) }
  if (target.x === cur.x && target.y === cur.y) return rec
  const next: Landmark[] = rec.landmarksCorrected.map((l, i) => (i === index ? { ...l, x: target.x, y: target.y } : l))
  return requalify({
    ...rec,
    landmarksCorrected: next,
    correctionLog: [...rec.correctionLog, { index, from: { x: cur.x, y: cur.y }, to: target, at }],
  })
}

/** 点（省略時はすべて）を検出位置に戻す */
export function resetCorrection(rec: PlaneRecord, index?: number, at = new Date().toISOString()): PlaneRecord {
  const targets = index === undefined ? [...correctedSet(rec)] : [index]
  let out = rec
  for (const i of targets) {
    const raw = out.landmarksRaw[i]
    const cur = out.landmarksCorrected[i]
    if (!raw || !cur || (raw.x === cur.x && raw.y === cur.y)) continue
    out = {
      ...out,
      landmarksCorrected: out.landmarksCorrected.map((l, j) => (j === i ? { ...raw } : l)),
      correctionLog: [...out.correctionLog, { index: i, from: { x: cur.x, y: cur.y }, to: { x: raw.x, y: raw.y }, at }],
    }
  }
  return requalify(out)
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v))
}

export interface AnalysisResult {
  computedMetrics: AssessmentSession['computedMetrics']
  computedMetricsRaw: AssessmentSession['computedMetricsRaw']
  postureTraits: AssessmentSession['postureTraits']
  confidenceScores: AssessmentSession['confidenceScores']
  qualityFlags: QualityFlag[]
}

/** 正面・側面のレコードから指標・特徴・信頼度をまとめて計算する */
export function analyze(front?: PlaneRecord, side?: PlaneRecord): AnalysisResult {
  const f = front ? requalify(front) : undefined
  const s = side ? requalify(side) : undefined
  const computedMetrics = computeAllMetrics(f, s, true)
  const computedMetricsRaw = computeAllMetrics(f, s, false)
  const planes: Plane[] = []
  if (f && f.landmarksRaw.length) planes.push('front')
  if (s && s.landmarksRaw.length) planes.push('side')
  return {
    computedMetrics,
    computedMetricsRaw,
    postureTraits: deriveTraits(computedMetrics, planes),
    confidenceScores: confidenceSummary(computedMetrics),
    qualityFlags: [...(f?.qualityFlags ?? []), ...(s?.qualityFlags ?? [])],
  }
}

export function buildSession(params: {
  id?: string
  createdAt?: string
  front?: PlaneRecord
  side?: PlaneRecord
  note?: string
  checkinId?: string
  imagesSaved: boolean
  modelVersion: string
}): AssessmentSession {
  const front = params.front ? requalify(params.front) : undefined
  const side = params.side ? requalify(params.side) : undefined
  const result = analyze(front, side)
  return {
    id: params.id ?? newId('s'),
    createdAt: params.createdAt ?? new Date().toISOString(),
    note: params.note,
    front,
    side,
    ...result,
    checkinId: params.checkinId,
    imagesSaved: params.imagesSaved,
    modelVersion: params.modelVersion,
    appVersion: APP_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
  }
}

/** 「意識した姿勢」の測定をまとめる */
export function buildConscious(params: { front?: PlaneRecord; side?: PlaneRecord; capturedAt?: string }): ConsciousPose {
  const front = params.front ? requalify(params.front) : undefined
  const side = params.side ? requalify(params.side) : undefined
  const r = analyze(front, side)
  return {
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    front,
    side,
    computedMetrics: r.computedMetrics,
    computedMetricsRaw: r.computedMetricsRaw,
    confidenceScores: r.confidenceScores,
    qualityFlags: r.qualityFlags,
  }
}

/** 保存済みセッションを最新の計算ロジックで計算し直す（補正の更新時・版の更新時） */
export function recomputeSession(s: AssessmentSession): AssessmentSession {
  const front = s.front ? requalify(s.front) : undefined
  const side = s.side ? requalify(s.side) : undefined
  const conscious = s.conscious ? buildConscious(s.conscious) : undefined
  return { ...s, front, side, ...analyze(front, side), conscious, algorithmVersion: ALGORITHM_VERSION }
}

/** 補正前後で値が変わった指標 */
export function correctionDiffs(s: AssessmentSession) {
  const raw = new Map(s.computedMetricsRaw.map((m) => [m.key, m]))
  return s.computedMetrics
    .map((m) => {
      const r = raw.get(m.key)
      if (!r || m.rawValue === null || r.rawValue === null) return null
      const diff = m.rawValue - r.rawValue
      if (Math.abs(diff) < 1e-6) return null
      return { key: m.key, label: m.label, before: r.rawValue, after: m.rawValue, diff, unit: m.unit }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
}
