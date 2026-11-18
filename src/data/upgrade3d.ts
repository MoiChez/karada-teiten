// 版 0.26.0 より前に撮った、真横でないスクワットの記録に、向きによらない 3D を足して計算し直す。
// 推定した点（画面の上の点と推定モデルの 3D）は記録に残っているので、動画がなくてもできる。手で直した点はそのまま使う。
// アプリを開いたときに 1 回だけ、裏で行う（対象がなければモデルも読まない）
import { analyzeMotion, motionInputOf, type MotionRecord } from '../domain/motion'
import type { View3DModel } from '../domain/view3d'
import { loadView3D, view3dFrames } from '../pose/view3dRun'
import { db } from './db'

/** 3D を足すと値が変わる記録か（スクワットで、真横でなく、まだ 3D がなく、推定モデルの 3D の点が残っている） */
export function needsView3d(r: MotionRecord): boolean {
  const squat = r.kind === 'squat' || r.kind === 'squat_front'
  const side = r.analysis.view?.view === 'side' || (r.analysis.view === undefined && r.analysis.sideView !== false)
  return squat && !side && r.frames.length > 0 && r.frames.every((f) => !f.v) && r.frames.some((f) => !!f.w)
}

/** 記録に 3D を足して計算し直したもの（3D を出せたコマがなければ null） */
export function withView3d(r: MotionRecord, model: View3DModel): MotionRecord | null {
  const frames = view3dFrames(model, r.frames, r.video.width, r.video.height)
  if (!frames.some((f) => f.v)) return null
  const next = { ...r, frames }
  const analysis = analyzeMotion(motionInputOf(next), r.kind)
  return { ...next, kind: analysis.kind, analysis }
}

let started = false

/** 対象の記録をすべて計算し直して保存する。直した件数を返す */
export async function addView3dToOldMotions(): Promise<number> {
  if (started) return 0
  started = true
  const list = (await db.motions.toArray()).filter(needsView3d)
  if (!list.length) return 0
  const model = await loadView3D()
  if (!model) return 0
  let n = 0
  for (const r of list) {
    const next = withView3d(r, model)
    if (!next) continue
    await db.motions.put(next)
    n++
  }
  return n
}
