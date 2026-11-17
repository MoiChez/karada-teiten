// RTMPose（MMPose、Halpe 26 点）を端末の中で動かし、MediaPipe の 2D の点を細かくする。
// 標準は RTMPose-m、高精度は RTMPose-l（設定で選ぶ。l は大きく重いので、ハイエンド・最新のスマホ向け）。
// 推定の部品（onnxruntime-web の WASM）とモデルは自サイトから配信し、使うときに読み込む（1 回読めば端末に残る）。
// 高精度のモデルを読めないときは標準で、標準も読めないとき・動かないときは、MediaPipe の点のまま使う
import type { Landmark } from '../domain/types'
import { RTM_H, RTM_W, cropBox, decodeSimcc, mergeRtm, toImage } from './rtmMerge'

export type RtmQuality = 'standard' | 'high'
/**
 * モデルのファイル。GitHub は 100MB を超えるファイルを置けないので、l（112MB）は 2 つに分けて置き、
 * 読み込むときにつなぐ（中身は配布元のファイルのまま）
 */
export const RTM_MODELS: Record<RtmQuality, { files: string[]; name: string }> = {
  standard: { files: ['models/rtmpose-m-halpe26.onnx'], name: 'rtmpose-m_simcc-body7_pt-body7-halpe26_700e-256x192' },
  high: {
    files: ['models/rtmpose-l-halpe26.onnx.part1', 'models/rtmpose-l-halpe26.onnx.part2'],
    name: 'rtmpose-l_simcc-body7_pt-body7-halpe26_700e-256x192',
  },
}

/** 分けたファイルを読んで 1 つにつなぐ */
async function fetchJoined(urls: string[]): Promise<Uint8Array> {
  const parts = await Promise.all(
    urls.map(async (u) => {
      const r = await fetch(u)
      if (!r.ok) throw new Error(`${u}: ${r.status}`)
      return new Uint8Array(await r.arrayBuffer())
    }),
  )
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const MEAN = [123.675, 116.28, 103.53]
const STD = [58.395, 57.12, 57.375]
const K = 26

type Ort = typeof import('onnxruntime-web/wasm')
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>

type Loaded = { ort: Ort; session: Session; quality: RtmQuality }
const loading = new Map<RtmQuality, Promise<Loaded | null>>()
/** 設定で選んだ精度 */
let wanted: RtmQuality = 'standard'
/** 実際に読めた精度（高精度を読めず標準にしたとき、ここが standard になる） */
let effective: RtmQuality | null = null
/** RTMPose で点を細かくできたときの、そのモデルの名前（記録の推定モデルの版に書く） */
let usedName: string | null = null

function assetUrl(path: string) {
  return new URL(`${import.meta.env.BASE_URL}${path}`, window.location.href).href
}

/** 設定で選んだ精度にする（次に読むときから使う） */
export function setRtmQuality(q: RtmQuality | undefined) {
  const next = q === 'high' ? 'high' : 'standard'
  if (next !== wanted) {
    wanted = next
    effective = null
  }
}

/** いま使う（使うはずの）モデルの名前。読み込みを試したあとは、実際に読めた方 */
export function currentRtmName() {
  return RTM_MODELS[effective ?? wanted].name
}

function loadOne(q: RtmQuality): Promise<Loaded | null> {
  let p = loading.get(q)
  if (!p) {
    p = (async () => {
      try {
        const ort = await import('onnxruntime-web/wasm')
        // 複数のスレッドは、ページが「クロスオリジン分離」のときだけ使える（GitHub Pages では使えないので 1 本）
        ort.env.wasm.numThreads = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1
        const files = RTM_MODELS[q].files.map(assetUrl)
        const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' as const }
        const session = files.length === 1 ? await ort.InferenceSession.create(files[0], opts) : await ort.InferenceSession.create(await fetchJoined(files), opts)
        return { ort, session, quality: q }
      } catch (e) {
        console.warn(`RTMPose（${q}）を読み込めませんでした`, e)
        loading.delete(q)
        return null
      }
    })()
    loading.set(q, p)
  }
  return p
}

/** 設定で選んだモデルを読み込む（何度呼んでも 1 回だけ）。高精度を読めなければ標準、それも読めなければ null */
export async function loadRtm(): Promise<Loaded | null> {
  const want = wanted
  const got = (await loadOne(want)) ?? (want === 'high' ? await loadOne('standard') : null)
  if (want === wanted) effective = got?.quality ?? want
  if (!got) console.warn('RTMPose を読み込めませんでした。MediaPipe の点だけで測ります')
  return got
}

/** RTMPose で点を細かくしたときの、そのモデルの名前（使っていなければ null） */
export function rtmUsed() {
  return usedName
}

let canvas: OffscreenCanvas | HTMLCanvasElement | null = null
function cropContext() {
  if (!canvas) {
    canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(RTM_W, RTM_H) : Object.assign(document.createElement('canvas'), { width: RTM_W, height: RTM_H })
  }
  return canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
}

/**
 * MediaPipe の点（0..1）のまわりを切り抜いて RTMPose にかけ、2D の点を置き換えた点を返す。
 * 使えないときは、渡した点をそのまま返す
 */
export async function refineLandmarks(source: CanvasImageSource, width: number, height: number, landmarks: Landmark[]): Promise<Landmark[]> {
  if (landmarks.length < 33) return landmarks
  const box = cropBox(landmarks, width, height)
  if (!box) return landmarks
  const rt = await loadRtm()
  if (!rt) return landmarks
  try {
    const ctx = cropContext()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, RTM_W, RTM_H)
    // 範囲が絵の外にはみ出した部分は、黒のまま（切り抜きの範囲と行き先は、同じ割合で切り詰められる）
    ctx.drawImage(source, box.cx - box.w / 2, box.cy - box.h / 2, box.w, box.h, 0, 0, RTM_W, RTM_H)
    const px = ctx.getImageData(0, 0, RTM_W, RTM_H).data
    const n = RTM_W * RTM_H
    const input = new Float32Array(3 * n)
    for (let i = 0; i < n; i++) {
      input[i] = (px[i * 4] - MEAN[0]) / STD[0]
      input[n + i] = (px[i * 4 + 1] - MEAN[1]) / STD[1]
      input[2 * n + i] = (px[i * 4 + 2] - MEAN[2]) / STD[2]
    }
    const out = await rt.session.run({ input: new rt.ort.Tensor('float32', input, [1, 3, RTM_H, RTM_W]) })
    const sx = out.simcc_x.data as Float32Array
    const sy = out.simcc_y.data as Float32Array
    const pts = toImage(decodeSimcc(sx, sy, K), box, width, height)
    const merged = mergeRtm(landmarks, pts)
    if (merged.replaced > 0) usedName = RTM_MODELS[rt.quality].name
    return merged.landmarks
  } catch (e) {
    console.warn('RTMPose で推定できませんでした', e)
    return landmarks
  }
}

/**
 * 動画 1 本ぶんの点を細かくする。RTMPose は重いので、端末の速さに合わせて何コマかおき（1〜4 コマごと）にかけ、
 * 間のコマは、前後のかけたコマの「RTMPose − MediaPipe」のずれを時間で割り振って足す（ずれはゆっくりしか変わらない）
 */
export function createClipRefiner(opts: { refine?: typeof refineLandmarks; step?: number } = {}) {
  const refine = opts.refine ?? refineLandmarks
  const frames: { lms: Landmark[]; off?: Float32Array }[] = []
  const ms: number[] = []
  let step = opts.step ?? 1
  return {
    /** 1 コマを加える（検出できたコマだけ、時刻の順に） */
    async push(source: CanvasImageSource, width: number, height: number, lms: Landmark[]) {
      const k = frames.length
      const f: { lms: Landmark[]; off?: Float32Array } = { lms }
      frames.push(f)
      if (k % step !== 0) return
      const t0 = performance.now()
      const ref = await refine(source, width, height, lms)
      ms.push(performance.now() - t0)
      if (ms.length === 3 && opts.step === undefined) {
        const med = [...ms].sort((a, b) => a - b)[1]
        step = med <= 70 ? 1 : med <= 140 ? 2 : med <= 210 ? 3 : 4
      }
      if (ref === lms) return
      const off = new Float32Array(lms.length * 2)
      for (let i = 0; i < lms.length; i++) {
        off[i * 2] = ref[i].x - lms[i].x
        off[i * 2 + 1] = ref[i].y - lms[i].y
      }
      f.off = off
      f.lms = ref
    },
    /** 細かくした点（加えた順）。間のコマには、前後のずれを割り振って足す */
    finish(): Landmark[][] {
      const keys = frames.map((f, k) => (f.off ? k : -1)).filter((k) => k >= 0)
      if (!keys.length) return frames.map((f) => f.lms)
      let j = 0
      return frames.map((f, k) => {
        if (f.off) return f.lms
        while (j + 1 < keys.length && keys[j + 1] < k) j++
        const a = keys[j] <= k ? keys[j] : -1
        const b = keys.find((q) => q > k) ?? -1
        const oa = a >= 0 ? frames[a].off! : null
        const ob = b >= 0 ? frames[b].off! : null
        const w = oa && ob ? (k - a) / (b - a) : oa ? 0 : 1
        return f.lms.map((l, i) => {
          const dx = (oa ? oa[i * 2] * (1 - w) : 0) + (ob ? ob[i * 2] * w : 0)
          const dy = (oa ? oa[i * 2 + 1] * (1 - w) : 0) + (ob ? ob[i * 2 + 1] * w : 0)
          return { ...l, x: l.x + dx, y: l.y + dy }
        })
      })
    },
    /** 何コマごとにかけたか（確かめる用） */
    get step() {
      return step
    },
  }
}
