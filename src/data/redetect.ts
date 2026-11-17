// 写真・動画を残した記録を、今の点の推定（MediaPipe + RTMPose）で計算し直す。
// 写真を残していない記録は、点しか残っていないので計算し直せない（比べるときに「推定モデルが違う」と注意を出す）。
// 手で直した点は、直した位置をそのまま当て直す
import type { AssessmentSession, ConsciousPose, PlaneRecord } from '../domain/types'
import { applyCorrection, correctedSet, recomputeSession } from '../domain/session'
import { analyzeMotion, motionInputOf, type MotionRecord } from '../domain/motion'
import { analyzePlane } from '../pose/analyzePlane'
import { prepareFromFile } from '../pose/image'
import { POSE_MODEL, modelVersion } from '../pose/landmarker'
import { detectRecorded } from '../pose/motionVideo'
import { currentRtmName } from '../pose/rtmpose'
import { db } from './db'

/** 今の推定（設定で選んだ RTMPose のモデル）で求めた記録か */
export function isCurrentDetection(modelVersionText: string | undefined) {
  return !!modelVersionText && modelVersionText.includes(currentRtmName())
}

const hasImage = (r?: PlaneRecord) => !!r?.imageMetadata.imageId && !r.burst

/** 計算し直せる記録（写真・動画を残していて、前の推定のもの） */
export async function redetectTargets(): Promise<{ sessions: AssessmentSession[]; motions: MotionRecord[] }> {
  const sessions = (await db.assessments.toArray()).filter((s) => !isCurrentDetection(s.modelVersion) && (hasImage(s.front) || hasImage(s.side)))
  const motions = (await db.motions.toArray()).filter((m) => !isCurrentDetection(m.modelVersion) && m.videoSaved)
  return { sessions, motions }
}

async function redetectPlane(rec: PlaneRecord | undefined): Promise<PlaneRecord | undefined> {
  if (!rec || !hasImage(rec)) return rec
  const row = await db.images.get(rec.imageMetadata.imageId!)
  if (!row) return rec
  // 残した写真は、鏡の自撮りでも左右を戻したあとのもの
  const image = await prepareFromFile(row.blob)
  const fresh = await analyzePlane({
    plane: rec.plane,
    image,
    source: rec.imageMetadata.source,
    model: POSE_MODEL,
    deviceTilt: rec.imageMetadata.deviceTilt,
    facingOverride: rec.imageMetadata.facing,
    mirrorSelfie: rec.imageMetadata.mirrorSelfie,
  })
  if (!fresh.landmarksRaw.length) return rec
  let out: PlaneRecord = { ...fresh, imageMetadata: { ...fresh.imageMetadata, capturedAt: rec.imageMetadata.capturedAt, imageId: rec.imageMetadata.imageId } }
  // 手で直した点は、直した位置へ当て直す
  for (const i of correctedSet(rec)) {
    const p = rec.landmarksCorrected[i]
    if (p) out = applyCorrection(out, i, { x: p.x, y: p.y }, rec.correctionLog.at(-1)?.at, false)
  }
  return out
}

async function redetectConscious(c: ConsciousPose | undefined): Promise<ConsciousPose | undefined> {
  if (!c) return c
  return { ...c, front: await redetectPlane(c.front), side: await redetectPlane(c.side) }
}

export async function redetectSession(s: AssessmentSession): Promise<AssessmentSession> {
  const front = await redetectPlane(s.front)
  const side = await redetectPlane(s.side)
  const conscious = await redetectConscious(s.conscious)
  return recomputeSession({ ...s, front, side, conscious, modelVersion: modelVersion(POSE_MODEL) })
}

export async function redetectMotion(r: MotionRecord, onFrame?: (done: number, total: number) => void): Promise<MotionRecord> {
  const video = await db.motionVideos.get(r.id)
  if (!video?.images.length) return r
  const images = [...video.images].sort((a, b) => a.t - b.t)
  // 残したコマは、回して起こしたあとの向き。回さずに推定する
  const clip = {
    frames: images.map((f) => ({ t: f.t, blob: f.blob })),
    width: video.width,
    height: video.height,
    durationMs: images.at(-1)!.t - images[0].t,
  }
  const det = await detectRecorded(clip, 0, (p) => onFrame?.(p.done, p.total))
  if (det.frames.length < 2) return r
  const next: MotionRecord = { ...r, frames: det.frames, modelVersion: modelVersion(POSE_MODEL) }
  const analysis = analyzeMotion(motionInputOf(next), r.kind ?? 'squat')
  return { ...next, kind: analysis.kind, analysis }
}

/** 対象の記録をすべて計算し直して保存する。進み具合は「何件目か」と、動画のコマ */
export async function redetectAll(onProgress: (p: { done: number; total: number; frame?: { done: number; total: number } }) => void): Promise<{ sessions: number; motions: number }> {
  const { sessions, motions } = await redetectTargets()
  const total = sessions.length + motions.length
  let done = 0
  for (const s of sessions) {
    onProgress({ done, total })
    const next = await redetectSession(s)
    await db.assessments.put(next)
    done++
  }
  for (const m of motions) {
    onProgress({ done, total })
    const next = await redetectMotion(m, (d, t) => onProgress({ done, total, frame: { done: d, total: t } }))
    await db.motions.put(next)
    done++
  }
  onProgress({ done, total })
  return { sessions: sessions.length, motions: motions.length }
}
