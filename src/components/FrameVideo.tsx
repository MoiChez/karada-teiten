// 撮った動画（コマの画像の並び）を、時計に合わせて表示する。骨格の線を重ねられる
import { useEffect, useMemo, useRef } from 'react'
import type { Landmark, Point } from '../domain/types'
import { SKELETON_EDGES } from '../domain/landmarks'
import { indexAt, type Clock } from './motionClock'

export function FrameVideo({
  images,
  width,
  height,
  clock,
  overlay,
  nearSide,
  com,
  bar,
  bothSides,
}: {
  images: { t: number; blob: Blob }[]
  width: number
  height: number
  clock: Clock
  /** なめらかにした体の点（画像に対する比）。重ねないときは undefined */
  overlay?: { t: number; lm: Landmark[] }[]
  nearSide: 'left' | 'right'
  /** 推定の重心と、かかと・つま先（画像に対する比。overlay と同じ時刻の並び）。骨格を重ねるときに一緒に描く */
  com?: { c: Point; heel: Point; toe: Point }[]
  /** バーの位置（手首の点。画像に対する比）と、コマごとの軌道の始まり（その回の始めのコマ。回の外は -1） */
  bar?: { points: Point[]; from: number[] }
  /** 両側を同じ明るさで描く（正面・後ろから撮ったとき） */
  bothSides?: boolean
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const ts = useMemo(() => images.map((im) => im.t), [images])
  const overlayTs = useMemo(() => overlay?.map((o) => o.t) ?? [], [overlay])

  useEffect(() => {
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    let drawn = -1
    let wanted = -1
    let busy = false
    let alive = true
    let lastBitmap: ImageBitmap | null = null

    const paint = (bmp: ImageBitmap) => {
      ctx.drawImage(bmp, 0, 0, c.width, c.height)
      if (!overlay?.length) return
      const o = overlay[indexAt(overlayTs, clock.get())]
      if (!o) return
      const k = indexAt(overlayTs, clock.get())
      drawOverlay(ctx, c.width, c.height, {
        lm: o.lm,
        nearSide,
        com: com?.[k],
        trail: bar && bar.from[k] >= 0 ? bar.points.slice(bar.from[k], k + 1) : undefined,
        bothSides,
      })
    }

    const pump = async () => {
      if (busy) return
      busy = true
      while (alive && wanted !== drawn && wanted >= 0) {
        const k = wanted
        try {
          const bmp = await createImageBitmap(images[k].blob)
          if (!alive) {
            bmp.close()
            break
          }
          lastBitmap?.close()
          lastBitmap = bmp
          paint(bmp)
          drawn = k
        } catch {
          drawn = k
        }
      }
      busy = false
    }

    const update = () => {
      wanted = indexAt(ts, clock.get())
      if (wanted === drawn) {
        // 同じコマでも、骨格の重ね表示は時刻に合わせて描き直す
        if (overlay?.length && lastBitmap) paint(lastBitmap)
        return
      }
      void pump()
    }
    update()
    const off = clock.subscribe(update)
    return () => {
      alive = false
      off()
      lastBitmap?.close()
    }
  }, [images, ts, clock, overlay, overlayTs, nearSide, com, bar, bothSides])

  return (
    <canvas
      ref={canvas}
      width={width}
      height={height}
      role="img"
      aria-label="撮った動画"
      className="block size-full object-contain"
      style={{ aspectRatio: `${width} / ${height}` }}
    />
  )
}

/** 重ねて描くもの（画像に対する比） */
export interface OverlayInput {
  lm: Landmark[]
  nearSide: 'left' | 'right'
  /** 推定の重心と、かかと・つま先 */
  com?: { c: Point; heel: Point; toe: Point }
  /** バーの軌跡（その回の始めから今まで） */
  trail?: Point[]
  /** 両側を同じ明るさで描く（正面・後ろから撮ったとき） */
  bothSides?: boolean
}

/** 骨格の線・重心の線・バーの軌跡を、w × h の範囲に描く（画面の動画と、書き出す動画で同じ描き方にする） */
export function drawOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, o: OverlayInput) {
  const near = (i: number) => o.bothSides || i === 0 || (o.nearSide === 'left' ? i % 2 === 1 : i % 2 === 0)
  const s = Math.max(w, h) / 400
  const X = (p: Point) => p.x * w
  const Y = (p: Point) => p.y * h
  ctx.lineCap = 'round'
  for (const [a, b] of SKELETON_EDGES) {
    const front = near(a) && near(b)
    ctx.strokeStyle = front ? 'rgba(205,225,75,0.95)' : 'rgba(255,255,255,0.45)'
    ctx.lineWidth = (front ? 2.6 : 1.6) * s
    ctx.beginPath()
    ctx.moveTo(X(o.lm[a]), Y(o.lm[a]))
    ctx.lineTo(X(o.lm[b]), Y(o.lm[b]))
    ctx.stroke()
  }
  const m = o.com
  if (m && Number.isFinite(m.c.x)) {
    const floor = Math.max(Y(m.heel), Y(m.toe))
    // 足（かかと〜つま先）と、重心から床への線
    ctx.strokeStyle = 'rgba(91,174,255,0.95)'
    ctx.lineWidth = 3.2 * s
    ctx.beginPath()
    ctx.moveTo(X(m.heel), floor)
    ctx.lineTo(X(m.toe), floor)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(233,184,94,0.95)'
    ctx.lineWidth = 2 * s
    ctx.setLineDash([5 * s, 4 * s])
    ctx.beginPath()
    ctx.moveTo(X(m.c), Y(m.c))
    ctx.lineTo(X(m.c), floor)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(233,184,94,1)'
    ctx.strokeStyle = '#10282f'
    ctx.lineWidth = 1.5 * s
    ctx.beginPath()
    ctx.arc(X(m.c), Y(m.c), 4.5 * s, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(X(m.c), floor, 2.6 * s, 0, Math.PI * 2)
    ctx.fill()
  }
  if (o.trail && o.trail.length > 1) {
    ctx.lineJoin = 'round'
    for (const [lw, color] of [
      [4.2, 'rgba(16,40,47,0.55)'],
      [2.2, 'rgba(255,255,255,0.95)'],
    ] as const) {
      ctx.strokeStyle = color
      ctx.lineWidth = lw * s
      ctx.beginPath()
      o.trail.forEach((p, j) => (j ? ctx.lineTo(X(p), Y(p)) : ctx.moveTo(X(p), Y(p))))
      ctx.stroke()
    }
  }
  for (const i of [11, 12, 23, 24, 25, 26, 27, 28]) {
    if (!near(i)) continue
    ctx.fillStyle = '#10282f'
    ctx.strokeStyle = 'rgba(205,225,75,1)'
    ctx.lineWidth = 1.5 * s
    ctx.beginPath()
    ctx.arc(X(o.lm[i]), Y(o.lm[i]), 3.2 * s, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
}
