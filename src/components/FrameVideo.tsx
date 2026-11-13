// 撮った動画（コマの画像の並び）を、時計に合わせて表示する。骨格の線を重ねられる
import { useEffect, useMemo, useRef } from 'react'
import type { Landmark } from '../domain/types'
import { SKELETON_EDGES } from '../domain/landmarks'
import { indexAt, type Clock } from './motionClock'

export function FrameVideo({
  images,
  width,
  height,
  clock,
  overlay,
  nearSide,
}: {
  images: { t: number; blob: Blob }[]
  width: number
  height: number
  clock: Clock
  /** なめらかにした体の点（画像に対する比）。重ねないときは undefined */
  overlay?: { t: number; lm: Landmark[] }[]
  nearSide: 'left' | 'right'
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
      const near = (i: number) => i === 0 || (nearSide === 'left' ? i % 2 === 1 : i % 2 === 0)
      const s = Math.max(c.width, c.height) / 400
      ctx.lineCap = 'round'
      for (const [a, b] of SKELETON_EDGES) {
        const front = near(a) && near(b)
        ctx.strokeStyle = front ? 'rgba(205,225,75,0.95)' : 'rgba(255,255,255,0.45)'
        ctx.lineWidth = (front ? 2.6 : 1.6) * s
        ctx.beginPath()
        ctx.moveTo(o.lm[a].x * c.width, o.lm[a].y * c.height)
        ctx.lineTo(o.lm[b].x * c.width, o.lm[b].y * c.height)
        ctx.stroke()
      }
      for (const i of [11, 12, 23, 24, 25, 26, 27, 28]) {
        if (!near(i)) continue
        ctx.fillStyle = '#10282f'
        ctx.strokeStyle = 'rgba(205,225,75,1)'
        ctx.lineWidth = 1.5 * s
        ctx.beginPath()
        ctx.arc(o.lm[i].x * c.width, o.lm[i].y * c.height, 3.2 * s, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
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
  }, [images, ts, clock, overlay, overlayTs, nearSide])

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
