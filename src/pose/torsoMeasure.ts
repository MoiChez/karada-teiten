// 動画のコマの画像から、胴の厚み（3D の表示に使う）を測る。端末の中だけで行う
import { detectImage, POSE_MODEL } from './landmarker'
import { evenPicks, torsoDepthRows, torsoProfileOf, TORSO_FRAMES, TORSO_PROFILE_VERSION, type TorsoProfile } from '../domain/torsoDepth'
import type { Landmark } from '../domain/types'

/** frames（時刻の順）の中で、時刻 t にいちばん近いコマ（コマの間隔の 2 倍より離れていれば null） */
function nearestFrame<F extends { t: number }>(frames: F[], t: number): F | null {
  if (!frames.length) return null
  let lo = 0
  let hi = frames.length - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (frames[m].t < t) lo = m
    else hi = m
  }
  const best = Math.abs(frames[lo].t - t) <= Math.abs(frames[hi].t - t) ? frames[lo] : frames[hi]
  const gap = frames.length > 1 ? (frames[frames.length - 1].t - frames[0].t) / (frames.length - 1) : Infinity
  return Math.abs(best.t - t) <= 2 * gap ? best : null
}

/**
 * コマの画像（動画の記録に残す画像と同じもの）から、胴の厚みを測る。推定モデルの人の領域を使うので、
 * 1 コマずつ推定し直す（16 コマで、スマホで数秒）。frames（記録のなめらかにした推定の点、画像に対する比）と side
 * （カメラ側）があれば、胴の線と脚の長さはその側の点で決める（3D を置くのと同じ点）。測れなければ null
 */
export async function measureTorso(
  images: { t: number; blob: Blob }[],
  frames?: { t: number; lm: Landmark[] }[],
  side?: 'left' | 'right',
  count = TORSO_FRAMES,
): Promise<TorsoProfile | null> {
  if (!images.length) return null
  const samples: TorsoProfile[] = []
  for (const i of evenPicks(images.length, count)) {
    let bmp: ImageBitmap | undefined
    try {
      bmp = await createImageBitmap(images[i].blob)
      const r = await detectImage(bmp, POSE_MODEL, { withMask: true })
      const own = frames && side ? nearestFrame(frames, images[i].t)?.lm : undefined
      const lm = own ?? r.landmarks
      if (!lm || !r.mask) continue
      const rows = torsoDepthRows(lm, r.mask, bmp.width, bmp.height, undefined, own ? side : undefined)
      if (rows) samples.push(rows)
    } catch {
      // 読めないコマは飛ばす
    } finally {
      bmp?.close()
    }
  }
  const out = torsoProfileOf(samples)
  return out && frames && side ? { ...out, version: TORSO_PROFILE_VERSION } : out
}
