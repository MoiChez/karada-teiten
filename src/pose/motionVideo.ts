// 動きの撮影と推定。カメラの映像をコマごとに JPEG で一時的にため、撮り終わってから 1 コマずつ骨格を推定する
// （その場で推定すると、スマホでは 1 秒あたりのコマ数が足りないため）。動画ファイルからも同じようにコマを取り出す。
// ためたコマ（画像）は、結果の画面で動画として再生するのに使う。端末に残すのは、残すと選んだときだけ
import { packLandmarks, packWorld, turnsFromBody, voteTurns } from '../domain/motion'
import { POSE_MODEL, createVideoLandmarker, detectImage } from './landmarker'

/** 推定と再生に使うコマの長い辺（ピクセル）。推定モデルの入力より十分に大きく、再生用に残しても重くなりすぎない大きさ */
export const MOTION_MAX_SIDE = 720
/** 動画ファイルから取り出す間隔 */
const FILE_FPS = 30
/** 動画ファイルの長さの上限（ミリ秒） */
export const FILE_MAX_MS = 20_000

export interface RecordedClip {
  frames: { t: number; blob: Blob }[]
  width: number
  height: number
  durationMs: number
}

/** 再生用のコマの画像 */
export interface ClipImage {
  t: number
  blob: Blob
}

export interface DetectedClip {
  frames: { t: number; p: number[]; w?: number[] }[]
  /** 推定に使ったコマの画像（回したあと） */
  images: ClipImage[]
  width: number
  height: number
  durationMs: number
  frameCount: number
  fps: number
  quarterTurns: number
}

type FrameMeta = { mediaTime?: number }
type VideoWithFrames = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

/** 映像を時計回りに turns × 90° 回し、長い辺を MOTION_MAX_SIDE 以下にして描く台 */
function rotatedCanvas(srcW: number, srcH: number, turns: number) {
  const odd = Math.abs(turns) % 2 === 1
  const w0 = odd ? srcH : srcW
  const h0 = odd ? srcW : srcH
  const scale = Math.min(1, MOTION_MAX_SIDE / Math.max(w0, h0))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w0 * scale)
  canvas.height = Math.round(h0 * scale)
  const ctx = canvas.getContext('2d')!
  const draw = (src: CanvasImageSource) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((turns * Math.PI) / 2)
    ctx.drawImage(src, (-srcW * scale) / 2, (-srcH * scale) / 2, srcW * scale, srcH * scale)
  }
  return { canvas, draw }
}

type RecordOpts = { durationMs: number; turns: number; onTick?: (ms: number) => void; stopRef?: { current: boolean } }

type TrackProcessor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }

function jpeg(canvas: HTMLCanvasElement) {
  return new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.8))
}

/**
 * カメラの映像を、durationMs のあいだコマごとにためる。
 * 映像のコマを直接受け取れるブラウザ（Chrome）ではそれを使う（画面の描き換えの間隔に左右されず、撮った時刻も正確）
 */
export function recordFrames(video: HTMLVideoElement, opts: RecordOpts): Promise<RecordedClip> {
  const track = (video.srcObject as MediaStream | null)?.getVideoTracks?.()[0]
  const Processor = (window as unknown as { MediaStreamTrackProcessor?: TrackProcessor }).MediaStreamTrackProcessor
  if (track && Processor) return recordFromTrack(track, Processor, opts)
  return recordFromElement(video, opts)
}

async function recordFromTrack(track: MediaStreamTrack, Processor: TrackProcessor, opts: RecordOpts): Promise<RecordedClip> {
  const reader = new Processor({ track }).readable.getReader()
  const frames: { t: number; blob: Blob }[] = []
  const pending: Promise<void>[] = []
  let target: ReturnType<typeof rotatedCanvas> | null = null
  let t0: number | null = null
  let lastT = -1
  try {
    for (;;) {
      if (opts.stopRef?.current) break
      const { value: frame, done } = await reader.read()
      if (done || !frame) break
      try {
        const raw = frame.timestamp / 1000
        t0 ??= raw
        const t = raw - t0
        if (t <= lastT) continue
        lastT = t
        target ??= rotatedCanvas(frame.displayWidth, frame.displayHeight, opts.turns)
        target.draw(frame)
      } finally {
        frame.close()
      }
      const t = lastT
      pending.push(jpeg(target.canvas).then((b) => void (b && frames.push({ t, blob: b }))))
      opts.onTick?.(t)
      if (t >= opts.durationMs) break
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
  await Promise.all(pending)
  frames.sort((a, b) => a.t - b.t)
  return { frames, width: target?.canvas.width ?? 0, height: target?.canvas.height ?? 0, durationMs: Math.max(0, lastT) }
}

function recordFromElement(video: HTMLVideoElement, opts: RecordOpts): Promise<RecordedClip> {
  const v = video as VideoWithFrames
  const { canvas, draw } = rotatedCanvas(video.videoWidth, video.videoHeight, opts.turns)
  const frames: { t: number; blob: Blob }[] = []
  const pending: Promise<void>[] = []
  return new Promise((resolve) => {
    let t0: number | null = null
    let lastMedia = -1
    let lastT = -1
    let done = false
    const finish = async () => {
      if (done) return
      done = true
      await Promise.all(pending)
      frames.sort((a, b) => a.t - b.t)
      resolve({ frames, width: canvas.width, height: canvas.height, durationMs: Math.max(0, lastT) })
    }
    const onFrame = (now: number, meta?: FrameMeta) => {
      if (done) return
      const media = meta?.mediaTime
      // 同じコマが 2 度届いたら飛ばす
      if (media !== undefined && media === lastMedia) return schedule()
      if (media !== undefined) lastMedia = media
      const raw = media !== undefined ? media * 1000 : now
      t0 ??= raw
      const t = raw - t0
      if (t <= lastT || (media === undefined && t - lastT < 25)) return schedule()
      lastT = t
      draw(video)
      pending.push(
        new Promise<void>((res) =>
          canvas.toBlob(
            (b) => {
              if (b) frames.push({ t, blob: b })
              res()
            },
            'image/jpeg',
            0.8,
          ),
        ),
      )
      opts.onTick?.(t)
      if (t >= opts.durationMs || opts.stopRef?.current) return void finish()
      schedule()
    }
    const schedule = () => {
      if (done) return
      if (opts.stopRef?.current) return void finish()
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame)
      else requestAnimationFrame((now) => onFrame(now))
    }
    schedule()
  })
}

function once(target: EventTarget, ok: string, fail = 'error') {
  return new Promise<void>((resolve, reject) => {
    const onOk = () => {
      cleanup()
      resolve()
    }
    const onFail = () => {
      cleanup()
      reject(new Error('動画を読み込めませんでした'))
    }
    const cleanup = () => {
      target.removeEventListener(ok, onOk)
      target.removeEventListener(fail, onFail)
    }
    target.addEventListener(ok, onOk)
    target.addEventListener(fail, onFail)
  })
}

async function seek(video: HTMLVideoElement, sec: number) {
  const p = once(video, 'seeked')
  video.currentTime = sec
  await p
}

export interface Progress {
  done: number
  total: number
}

/** -1..2 にそろえる */
const normTurns = (k: number) => (((k % 4) + 5) % 4) - 1

/** ためたコマを順に推定する。写っている人が横に倒れていれば、さらに回して起こす */
export async function detectRecorded(clip: RecordedClip, turns: number, onProgress: (p: Progress) => void, stopRef?: { current: boolean }): Promise<DetectedClip> {
  const n = clip.frames.length
  const votes: (number | null)[] = []
  for (const frac of [0.5, 0.3, 0.7, 0.15, 0.85]) {
    const f = clip.frames[Math.floor((n - 1) * frac)]
    if (!f) break
    const bmp = await createImageBitmap(f.blob)
    try {
      const r = await detectImage(bmp, POSE_MODEL)
      votes.push(r.landmarks ? turnsFromBody(r.landmarks, clip.width, clip.height) : null)
    } finally {
      bmp.close()
    }
  }
  const extra = voteTurns(votes)
  const fix = extra ? rotatedCanvas(clip.width, clip.height, extra) : null
  const lm = await createVideoLandmarker(POSE_MODEL)
  const out: DetectedClip['frames'] = []
  const images: ClipImage[] = []
  try {
    for (let i = 0; i < clip.frames.length; i++) {
      if (stopRef?.current) throw new Error('cancelled')
      const f = clip.frames[i]
      const bmp = await createImageBitmap(f.blob)
      try {
        let src: TexImageSource = bmp
        if (fix) {
          fix.draw(bmp)
          src = fix.canvas
        }
        const r = lm.detect(src, f.t)
        if (r.landmarks) out.push({ t: Math.round(f.t), p: packLandmarks(r.landmarks), w: r.worldLandmarks ? packWorld(r.worldLandmarks) : undefined })
        // 回したときは、回した向きの画像を再生用に作り直す
        const blob = fix ? await jpeg(fix.canvas) : f.blob
        if (blob) images.push({ t: Math.round(f.t), blob })
      } finally {
        bmp.close()
      }
      onProgress({ done: i + 1, total: clip.frames.length })
      // 画面の更新のために少し待つ
      if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0))
    }
  } finally {
    lm.close()
  }
  return {
    frames: out,
    images,
    width: fix ? fix.canvas.width : clip.width,
    height: fix ? fix.canvas.height : clip.height,
    durationMs: clip.durationMs,
    frameCount: n,
    fps: n > 1 && clip.durationMs > 0 ? ((n - 1) * 1000) / clip.durationMs : FILE_FPS,
    quarterTurns: normTurns(turns + extra),
  }
}

/** 動画ファイルから一定の間隔でコマを取り出して推定する。人が横に写っていれば、映像を回して起こす */
export async function detectVideoFile(file: File, onProgress: (p: Progress) => void, stopRef?: { current: boolean }): Promise<DetectedClip> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  // 画面に置かないとコマを描かない端末があるので、見えない形で置く
  Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' })
  document.body.appendChild(video)
  try {
    const loaded = once(video, 'loadeddata')
    video.src = url
    await loaded
    let duration = video.duration
    if (!Number.isFinite(duration)) {
      // 長さが入っていない動画は、末尾まで飛んで長さを確かめる
      await seek(video, 1e7)
      duration = video.duration
    }
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('動画の長さが分かりませんでした')
    const end = Math.min(duration, FILE_MAX_MS / 1000)
    const step = 1 / FILE_FPS
    const vw = video.videoWidth
    const vh = video.videoHeight

    // 人が横向きに写っていないか（5 コマのうち 3 コマ以上が横倒しを示したときだけ回す）
    const votes: (number | null)[] = []
    for (const frac of [0.5, 0.3, 0.7, 0.15, 0.85]) {
      await seek(video, end * frac)
      const r = await detectImage(video, POSE_MODEL)
      votes.push(r.landmarks ? turnsFromBody(r.landmarks, vw, vh) : null)
    }
    const turns = voteTurns(votes)

    const { canvas, draw } = rotatedCanvas(vw, vh, turns)
    const total = Math.floor(end / step) + 1
    const lm = await createVideoLandmarker(POSE_MODEL)
    const out: DetectedClip['frames'] = []
    const images: ClipImage[] = []
    try {
      for (let k = 0; k < total; k++) {
        if (stopRef?.current) throw new Error('cancelled')
        await seek(video, k * step)
        draw(video)
        const t = Math.round(k * step * 1000)
        const r = lm.detect(canvas, t)
        if (r.landmarks) out.push({ t, p: packLandmarks(r.landmarks), w: r.worldLandmarks ? packWorld(r.worldLandmarks) : undefined })
        const blob = await jpeg(canvas)
        if (blob) images.push({ t, blob })
        onProgress({ done: k + 1, total })
      }
    } finally {
      lm.close()
    }
    return { frames: out, images, width: canvas.width, height: canvas.height, durationMs: end * 1000, frameCount: total, fps: FILE_FPS, quarterTurns: turns }
  } finally {
    video.remove()
    URL.revokeObjectURL(url)
  }
}
