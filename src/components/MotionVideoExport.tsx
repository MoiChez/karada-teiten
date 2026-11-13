// 再生している動き（撮った動画と重ね表示・3D の体・今の値・グラフ）を 1 枚の縦長の画面にまとめて、そのまま録画し、ファイルにする。
// 端末の中だけで作り、どこにも送らない。録画は再生と同じ速さで進む（10 秒の動きを 0.5 倍で書き出すと 20 秒かかる）
import { useEffect, useRef, useState, type RefObject } from 'react'
import { Film, Square } from 'lucide-react'
import { PROFILES, type MotionCycle, type MotionRecord, type PreparedMotion, type SeriesDef } from '../domain/motion'
import { fmtDate, fmtNum } from '../domain/format'
import type { MotionVideoData } from '../state/motionMedia'
import { drawOverlay, type OverlayInput } from './FrameVideo'
import { indexAt, type Clock } from './motionClock'
import { download } from './download'
import { Button } from './ui'

const OUT_W = 720
const OUT_H = 1280
const GAP = 12
const INK = '#10282f'
const INK3 = '#5d7176'
const MEASURE = '#1f7a8c'

/** この端末で録画できる形式（MP4 を優先し、できなければ WebM） */
function pickFormat(): { mime: string; ext: 'mp4' | 'webm' } | null {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined' || !('captureStream' in HTMLCanvasElement.prototype)) return null
  const list: [string, 'mp4' | 'webm'][] = [
    ['video/mp4;codecs=avc1', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9', 'webm'],
    ['video/webm', 'webm'],
  ]
  for (const [mime, ext] of list) if (MediaRecorder.isTypeSupported(mime)) return { mime, ext }
  return null
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 縦長の画面の割り付け: 見出し・動画と 3D・今の値・グラフ・注意書き */
function layoutOf(video: MotionVideoData | null) {
  const top = 84
  const inner = OUT_W - 2 * GAP
  let videoRect: Rect | null = null
  let threeRect: Rect
  if (video && video.height >= video.width) {
    const w = (inner - GAP) / 2
    const h = Math.min(620, (w * video.height) / video.width)
    videoRect = { x: GAP, y: top, w, h }
    threeRect = { x: GAP * 2 + w, y: top, w, h }
  } else if (video) {
    const h = Math.min(380, (inner * video.height) / video.width)
    videoRect = { x: GAP, y: top, w: inner, h }
    threeRect = { x: GAP, y: top + h + GAP, w: inner, h: 360 }
  } else {
    threeRect = { x: GAP, y: top, w: inner, h: 560 }
  }
  const mediaBottom = Math.max(videoRect ? videoRect.y + videoRect.h : 0, threeRect.y + threeRect.h)
  const values: Rect = { x: GAP, y: mediaBottom + GAP, w: inner, h: 190 }
  const chart: Rect = { x: GAP, y: values.y + values.h + GAP, w: inner, h: OUT_H - (values.y + values.h + GAP) - 70 }
  return { videoRect, threeRect, values, chart }
}

/** 中に収まるように、縦横比を保って置く */
function contain(src: { width: number; height: number }, r: Rect): Rect {
  const k = Math.min(r.w / src.width, r.h / src.height)
  const w = src.width * k
  const h = src.height * k
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h }
}

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, fill: string) {
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, 16)
  ctx.fill()
}

export function MotionVideoExport({
  rec,
  prep,
  cycles,
  video,
  clock,
  three,
  series,
  overlayAt,
  fileStem,
}: {
  rec: MotionRecord
  prep: PreparedMotion
  cycles: MotionCycle[]
  video: MotionVideoData | null
  clock: Clock
  /** 3D の体を描いている canvas */
  three: RefObject<HTMLCanvasElement | null>
  /** グラフに出す値 */
  series: SeriesDef
  /** コマ k に重ねるもの（重ねないなら null） */
  overlayAt: (k: number) => OverlayInput | null
  fileStem: string
}) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const stop = useRef(false)
  // 画面を離れたら、録画をやめる（3D が動かなくなり、途中までの動画になるため）
  useEffect(
    () => () => {
      stop.current = true
    },
    [],
  )
  const format = pickFormat()
  if (!format) return <p className="mt-2 text-sm text-ink-3">この端末のブラウザは、動画の書き出しに対応していません。</p>
  const profile = PROFILES[rec.kind]
  const speed = Math.max(0.5, clock.getSpeed())
  const seconds = (clock.end - clock.start) / 1000 / speed

  const run = async () => {
    setError('')
    const out = document.createElement('canvas')
    out.width = OUT_W
    out.height = OUT_H
    const ctx = out.getContext('2d')
    if (!ctx) return
    const L = layoutOf(video)
    const frameTs = prep.frames.map((f) => f.t)
    const imgTs = video?.images.map((im) => im.t) ?? []
    const values = prep.series[series.key]
    const shownDefs = profile.series.filter((d) => d.value || d.key === 'ratio').slice(0, 8)
    // グラフの範囲（値の範囲）
    const fin = values.filter(Number.isFinite)
    const lo = fin.length ? Math.min(...fin) : 0
    const hi = fin.length ? Math.max(...fin) : 1
    // 今描いているコマの画像（関数の中から書き換えるので、入れ物に持つ）
    const cache: { k: number; bmp: ImageBitmap | null } = { k: -1, bmp: null }

    const draw = async (t: number) => {
      if (video?.images.length) {
        const k = indexAt(imgTs, t)
        if (k !== cache.k) {
          const next = await createImageBitmap(video.images[k].blob)
          cache.bmp?.close()
          cache.bmp = next
          cache.k = k
        }
      }
      const k = indexAt(frameTs, t)
      ctx.fillStyle = '#eef3f2'
      ctx.fillRect(0, 0, OUT_W, OUT_H)
      // 見出し
      ctx.fillStyle = INK
      ctx.font = '700 34px system-ui, sans-serif'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(profile.label, GAP + 4, 48)
      ctx.font = '400 22px system-ui, sans-serif'
      ctx.fillStyle = INK3
      ctx.textAlign = 'right'
      ctx.fillText(`${fmtDate(rec.createdAt, true)}・からだ定点`, OUT_W - GAP - 4, 46)
      ctx.textAlign = 'left'
      // 動画と重ね表示
      const bmp = cache.bmp
      if (L.videoRect && video && bmp) {
        roundRect(ctx, L.videoRect, INK)
        const r = contain({ width: video.width, height: video.height }, L.videoRect)
        ctx.save()
        ctx.beginPath()
        ctx.roundRect(L.videoRect.x, L.videoRect.y, L.videoRect.w, L.videoRect.h, 16)
        ctx.clip()
        ctx.drawImage(bmp, r.x, r.y, r.w, r.h)
        ctx.translate(r.x, r.y)
        const o = overlayAt(k)
        if (o) drawOverlay(ctx, r.w, r.h, o)
        ctx.restore()
      }
      // 3D の体（画面に出ている 3D をそのまま写す）
      roundRect(ctx, L.threeRect, '#ffffff')
      const c3 = three.current
      if (c3 && c3.width > 0) {
        const r = contain(c3, L.threeRect)
        ctx.drawImage(c3, r.x, r.y, r.w, r.h)
      }
      // 今の値
      roundRect(ctx, L.values, '#ffffff')
      const cols = 4
      const cw = L.values.w / cols
      shownDefs.forEach((d, i) => {
        const cx = L.values.x + cw * (i % cols) + cw / 2
        const cy = L.values.y + 52 + Math.floor(i / cols) * 86
        ctx.textAlign = 'center'
        ctx.fillStyle = INK3
        ctx.font = '400 21px system-ui, sans-serif'
        ctx.fillText(d.short, cx, cy - 20)
        ctx.fillStyle = INK
        ctx.font = '700 32px system-ui, sans-serif'
        const v = prep.series[d.key][k]
        ctx.fillText(Number.isFinite(v) ? `${fmtNum(v, d.digits)}${d.unit === '°' || d.unit === '%' ? d.unit : ` ${d.unit}`}` : '—', cx, cy + 16)
      })
      ctx.textAlign = 'left'
      // グラフ（1 回ごとの区間の帯・線・今の時刻）
      const C = L.chart
      roundRect(ctx, C, '#ffffff')
      ctx.fillStyle = INK
      ctx.font = '600 22px system-ui, sans-serif'
      ctx.fillText(series.label, C.x + 16, C.y + 34)
      const P = { x: C.x + 16, y: C.y + 50, w: C.w - 32, h: C.h - 70 }
      const X = (tt: number) => P.x + ((tt - clock.start) / Math.max(1, clock.end - clock.start)) * P.w
      const Y = (v: number) => P.y + P.h - ((v - lo) / Math.max(1e-6, hi - lo)) * P.h
      ctx.fillStyle = 'rgba(31,122,140,0.10)'
      for (const c of cycles) ctx.fillRect(X(c.start), P.y, Math.max(1, X(c.end) - X(c.start)), P.h)
      ctx.strokeStyle = MEASURE
      ctx.lineWidth = 3
      ctx.beginPath()
      let pen = false
      values.forEach((v, i) => {
        if (!Number.isFinite(v)) {
          pen = false
          return
        }
        if (pen) ctx.lineTo(X(frameTs[i]), Y(v))
        else ctx.moveTo(X(frameTs[i]), Y(v))
        pen = true
      })
      ctx.stroke()
      ctx.strokeStyle = INK
      ctx.lineWidth = 2
      ctx.setLineDash([6, 5])
      ctx.beginPath()
      ctx.moveTo(X(t), P.y - 6)
      ctx.lineTo(X(t), P.y + P.h + 4)
      ctx.stroke()
      ctx.setLineDash([])
      // 注意書きと時刻
      ctx.fillStyle = INK3
      ctx.font = '400 19px system-ui, sans-serif'
      ctx.fillText('横から見た見かけの角度と、条件付きの推定です。医療診断ではありません。', GAP + 4, OUT_H - 38)
      ctx.textAlign = 'right'
      ctx.fillText(`${fmtNum((t - clock.start) / 1000, 2)} 秒・${speed === 1 ? '等速' : `${speed} 倍`}`, OUT_W - GAP - 4, OUT_H - 12)
      ctx.textAlign = 'left'
    }

    setBusy(true)
    setProgress(0)
    stop.current = false
    clock.pause()
    clock.set(clock.start)
    clock.setSpeed(speed)
    const stream = out.captureStream(30)
    const recorder = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: 5_000_000 })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()))
    try {
      // 3D が最初の姿勢を描くまで少し待ってから、最初のコマを描き、録画を始める
      await new Promise((r) => setTimeout(r, 300))
      await draw(clock.start)
      recorder.start(500)
      clock.play()
      await new Promise<void>((resolve) => {
        let last = -Infinity
        let shown = 0
        const tick = async () => {
          const t = clock.get()
          // 終わりで最初に戻ったら止める
          if (stop.current || t < last) return resolve()
          last = t
          await draw(t)
          const p = (t - clock.start) / Math.max(1, clock.end - clock.start)
          if (p - shown > 0.02) {
            shown = p
            setProgress(p)
          }
          if (t >= clock.end - 1) return resolve()
          requestAnimationFrame(() => void tick())
        }
        requestAnimationFrame(() => void tick())
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : '書き出しの途中で問題が起きました。')
    } finally {
      clock.pause()
      if (recorder.state !== 'inactive') recorder.stop()
      await stopped
      stream.getTracks().forEach((tr) => tr.stop())
      cache.bmp?.close()
      setBusy(false)
    }
    if (!stop.current && chunks.length) download(`${fileStem}.${format.ext}`, new Blob(chunks, { type: format.mime.split(';')[0] }))
  }

  return (
    <div className="mt-3 rounded-[var(--radius-panel)] bg-surface p-3 shadow-lift">
      {busy ? (
        <>
          <p className="text-sm font-medium" role="status">
            動画を作っています… {Math.round(progress * 100)}%
          </p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-sunken" aria-hidden>
            <div className="h-full rounded-full bg-measure" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="mt-2 text-xs text-ink-3">再生と同じ速さで録画しています。終わるまで、この画面を開いたままにしてください。</p>
          <Button className="mt-2" variant="quiet" icon={<Square aria-hidden className="size-4" />} onClick={() => (stop.current = true)}>
            やめる
          </Button>
        </>
      ) : (
        <>
          <Button variant="secondary" block icon={<Film aria-hidden className="size-5" />} onClick={() => void run()}>
            この再生を動画にする（{format.ext.toUpperCase()}）
          </Button>
          <p className="mt-2 text-xs text-ink-3">
            撮った動画（重ね表示つき）・3D の体・今の値・「{series.short}」のグラフを縦長の 1 画面にまとめて、{speed === 1 ? '等速' : `${speed} 倍`}で録画します（約 {Math.ceil(seconds)} 秒かかります）。端末の中で作り、どこにも送りません。
          </p>
        </>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  )
}
