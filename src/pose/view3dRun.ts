// 向きによらない 3D のモデル（src/domain/view3d.ts）を、動画のコマにかける。
// 推定の点を出したあとに 1 回だけかけ、結果（19 点の 3D と上の向き）をコマに残す。計算は端末の中だけ。
// モデルのファイルがないとき・読めないときは、何もしない（真横からの見かけの角度だけになる）
import { VIEW3D_WINDOW_MS, parseView3DModel, runView3D, view3dFrameFeatures, type View3DModel, type View3DModelFile } from '../domain/view3d'
import { unpackLandmarks, unpackWorld, type MotionFrameData } from '../domain/motionCore'

const FILE = 'models/view3d-v2.json'
let loading: Promise<View3DModel | null> | null = null

function assetUrl(path: string) {
  return new URL(`${import.meta.env.BASE_URL}${path}`, window.location.href).href
}

export function loadView3D(): Promise<View3DModel | null> {
  loading ??= (async () => {
    try {
      const r = await fetch(assetUrl(FILE))
      if (!r.ok) return null
      return parseView3DModel((await r.json()) as View3DModelFile)
    } catch (e) {
      console.warn('向きによらない 3D のモデルを読めませんでした', e)
      return null
    }
  })()
  return loading
}

/** 時刻の並んだコマのうち、t にいちばん近いコマ（ok のコマだけから） */
function nearest(ts: number[], ok: number[], t: number): number {
  let best = ok[0]
  let d = Infinity
  for (const k of ok) {
    const e = Math.abs(ts[k] - t)
    if (e < d) {
      d = e
      best = k
    }
  }
  return best
}

/** コマごとに 3D を求めて v に入れる（学習と同じく、前後 ±0.2 秒の 5 コマを入力にする） */
export function view3dFrames(model: View3DModel, frames: MotionFrameData[], width: number, height: number): MotionFrameData[] {
  const ts = frames.map((f) => f.t)
  const feats = frames.map((f) => {
    if (!f.w) return null
    const lm = unpackLandmarks(f.p)
    const world = unpackWorld(f.w)
    if (lm.length < 33 || world.length < 33) return null
    return view3dFrameFeatures(
      lm.map((l) => ({ x: l.x * width, y: l.y * height })),
      lm,
      world,
    )
  })
  const ok = feats.map((x, k) => (x ? k : -1)).filter((k) => k >= 0)
  if (!ok.length) return frames
  const n = feats[ok[0]]!.length
  const input = new Float32Array(n * VIEW3D_WINDOW_MS.length)
  return frames.map((f, k) => {
    if (!feats[k]) return f
    VIEW3D_WINDOW_MS.forEach((o, j) => input.set(feats[nearest(ts, ok, ts[k] + o)]!, j * n))
    const y = runView3D(model, input)
    return { ...f, v: Array.from(y, (x) => Math.round(x * 1000) / 1000) }
  })
}

/** 動画 1 本ぶんのコマに 3D を足す（モデルがなければそのまま） */
export async function attachView3D(frames: MotionFrameData[], width: number, height: number): Promise<MotionFrameData[]> {
  const model = await loadView3D()
  return model ? view3dFrames(model, frames, width, height) : frames
}
