// 動画のコマの画像から、胴の厚み（3D の表示に使う）を測る。端末の中だけで行う
import { detectImage, POSE_MODEL } from './landmarker'
import { torsoDepthRows, torsoProfileOf, type TorsoProfile } from '../domain/torsoDepth'

/** 厚みを測るコマの数（動画の全体から等間隔に選ぶ。腕・脚が胴に重ならないコマが混ざるように） */
export const TORSO_FRAMES = 16

/**
 * コマの画像（動画の記録に残す画像と同じもの）から、胴の厚みを測る。推定モデルの人の領域を使うので、
 * 1 コマずつ推定し直す（16 コマで、スマホで数秒）。測れなければ null
 */
export async function measureTorso(images: { blob: Blob }[], count = TORSO_FRAMES): Promise<TorsoProfile | null> {
  if (!images.length) return null
  const picks = new Set<number>()
  for (let k = 0; k < count; k++) picks.add(Math.min(images.length - 1, Math.round(((k + 0.5) * images.length) / count)))
  const samples: TorsoProfile[] = []
  for (const i of picks) {
    let bmp: ImageBitmap | undefined
    try {
      bmp = await createImageBitmap(images[i].blob)
      const r = await detectImage(bmp, POSE_MODEL, { withMask: true })
      if (!r.landmarks || !r.mask) continue
      const rows = torsoDepthRows(r.landmarks, r.mask, bmp.width, bmp.height)
      if (rows) samples.push(rows)
    } catch {
      // 読めないコマは飛ばす
    } finally {
      bmp?.close()
    }
  }
  return torsoProfileOf(samples)
}
