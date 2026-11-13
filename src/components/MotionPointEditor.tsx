// 動画のコマの上で、ずれた点を動かして直す（カメラ側の半身の点）。直した位置は、推定した点とは別に記録する。
// 動かせるのは画面の上の位置だけで、奥行きは直せない
import { useMemo, useRef, useState } from 'react'
import type { MotionEdit, PreparedMotion } from '../domain/motion'
import { sidePoints } from '../domain/landmarks'
import { indexAt, useClockValue, type Clock } from './motionClock'
import { cx } from './ui'

const NAMES: Record<string, string> = { ear: '耳', shoulder: '肩', elbow: 'ひじ', wrist: '手首', hip: '股関節', knee: '膝', ankle: '足首', heel: 'かかと', foot: '足先' }
const LINKS: [string, string][] = [
  ['ear', 'shoulder'],
  ['shoulder', 'elbow'],
  ['elbow', 'wrist'],
  ['shoulder', 'hip'],
  ['hip', 'knee'],
  ['knee', 'ankle'],
  ['ankle', 'heel'],
  ['heel', 'foot'],
]

/**
 * 今のコマの点を、ドラッグか矢印キーで動かす。onEdit には、そのコマの直した位置と、
 * 「前後のコマにもなじませる」ときは前後 spread コマぶんの位置（ずらした量をだんだん小さくしたもの）を渡す
 */
export function MotionPointEditor({ prep, clock, spread, onEdit }: { prep: PreparedMotion; clock: Clock; spread: number; onEdit: (edits: MotionEdit[]) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const ts = useMemo(() => prep.frames.map((f) => f.t), [prep])
  const t = useClockValue(clock, (c) => c.get())
  const k = indexAt(ts, t)
  const frame = prep.frames[k]
  const [drag, setDrag] = useState<{ i: number; x: number; y: number } | null>(null)
  const points = useMemo(() => {
    const s = sidePoints(prep.nearSide)
    return { ear: s.ear, shoulder: s.shoulder, elbow: s.wrist - 2, wrist: s.wrist, hip: s.hip, knee: s.knee, ankle: s.ankle, heel: s.heel, foot: s.foot } as Record<string, number>
  }, [prep.nearSide])
  if (!frame) return null
  const pos = (i: number) => (drag && drag.i === i ? drag : frame.lm[i])

  const commit = (i: number, x: number, y: number) => {
    const dx = x - frame.lm[i].x
    const dy = y - frame.lm[i].y
    if (Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5) return
    const edits: MotionEdit[] = [{ t: frame.t, i, x, y }]
    for (const dir of [-1, 1]) {
      for (let d = 1; d <= spread; d++) {
        const j = k + dir * d
        if (j < 0 || j >= prep.frames.length) break
        // 途切れをまたがない。すでに手で直した点は書き換えない
        if (dir === 1 ? prep.breaks.has(j) : prep.breaks.has(j + 1)) break
        const f = prep.frames[j]
        if (f.edited.includes(i)) continue
        const w = 1 - d / (spread + 1)
        edits.push({ t: f.t, i, x: f.lm[i].x + dx * w, y: f.lm[i].y + dy * w })
      }
    }
    onEdit(edits)
  }

  const toNorm = (clientX: number, clientY: number) => {
    const r = box.current!.getBoundingClientRect()
    return { x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)) }
  }

  return (
    <div ref={box} className="absolute inset-0 touch-none select-none">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden>
        {LINKS.map(([a, b]) => (
          <line
            key={a + b}
            x1={pos(points[a]).x * 100}
            y1={pos(points[a]).y * 100}
            x2={pos(points[b]).x * 100}
            y2={pos(points[b]).y * 100}
            stroke="rgba(205,225,75,0.95)"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {Object.entries(points).map(([name, i]) => {
        const p = pos(i)
        const edited = frame.edited.includes(i)
        return (
          <button
            key={name}
            type="button"
            aria-label={`${NAMES[name]}の点。ドラッグか矢印キーで動かせます${edited ? '（直した点）' : ''}`}
            className="absolute flex size-10 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full focus-visible:outline-2 active:cursor-grabbing"
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              clock.pause()
              setDrag({ i, ...toNorm(e.clientX, e.clientY) })
            }}
            onPointerMove={(e) => {
              if (drag?.i === i) setDrag({ i, ...toNorm(e.clientX, e.clientY) })
            }}
            onPointerUp={() => {
              if (drag?.i === i) {
                commit(i, drag.x, drag.y)
                setDrag(null)
              }
            }}
            onPointerCancel={() => setDrag(null)}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 0.01 : 0.002
              const d = e.key === 'ArrowLeft' ? [-step, 0] : e.key === 'ArrowRight' ? [step, 0] : e.key === 'ArrowUp' ? [0, -step] : e.key === 'ArrowDown' ? [0, step] : null
              if (!d) return
              e.preventDefault()
              commit(i, Math.min(1, Math.max(0, frame.lm[i].x + d[0])), Math.min(1, Math.max(0, frame.lm[i].y + d[1])))
            }}
          >
            <span className={cx('block size-3.5 rounded-full border-2', edited ? 'border-ink bg-level' : 'border-level bg-ink')} />
          </button>
        )
      })}
    </div>
  )
}
