// 角度（または深さ）の時間変化のグラフ。今の時刻に縦線を引き、触ったところへ移る。1 回ごとの区間に帯を付ける
import { useMemo, useRef } from 'react'
import { fmtNum } from '../domain/format'
import { indexAt, useClockValue, type Clock } from './motionClock'

const W = 340
const H = 150
const PAD = { l: 34, r: 8, t: 10, b: 22 }

function niceStep(range: number) {
  const raw = range / 3
  const p = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return m * p
  return 10 * p
}

export function AngleChart({
  ts,
  values,
  unit,
  digits,
  reps,
  clock,
  label,
}: {
  ts: number[]
  values: number[]
  unit: string
  digits: number
  reps: { start: number; bottom: number; end: number }[]
  clock: Clock
  label: string
}) {
  const svg = useRef<SVGSVGElement>(null)
  const geo = useMemo(() => {
    const t0 = clock.start
    const t1 = clock.end
    const lo0 = Math.min(...values)
    const hi0 = Math.max(...values)
    const step = niceStep(Math.max(1, hi0 - lo0))
    const lo = Math.floor(lo0 / step) * step
    const hi = Math.ceil(hi0 / step) * step
    const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r)
    const y = (v: number) => H - PAD.b - ((v - lo) / Math.max(1e-6, hi - lo)) * (H - PAD.t - PAD.b)
    const ticks: number[] = []
    for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(v)
    const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(ts[i]).toFixed(1)},${y(v).toFixed(1)}`).join('')
    const seconds = Math.floor((t1 - t0) / 1000)
    const every = seconds > 12 ? 5 : seconds > 6 ? 2 : 1
    return { x, y, ticks, path, seconds, every, t0, t1 }
  }, [ts, values, clock])

  const seekAt = (clientX: number) => {
    const el = svg.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const sx = ((clientX - r.left) / r.width) * W
    const t = geo.t0 + ((sx - PAD.l) / (W - PAD.l - PAD.r)) * (geo.t1 - geo.t0)
    clock.pause()
    clock.set(t)
  }

  return (
    <figure className="rounded-[var(--radius-panel)] bg-surface p-3 shadow-lift">
      <figcaption className="flex items-baseline justify-between gap-2 text-sm text-ink-2">
        <span className="font-medium">{label}</span>
        <NowValue ts={ts} values={values} clock={clock} unit={unit} digits={digits} />
      </figcaption>
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className="mt-1 w-full touch-none select-none"
        role="img"
        aria-label={`${label}の時間変化。触ると、その時刻へ移ります`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          seekAt(e.clientX)
        }}
        onPointerMove={(e) => {
          if (e.buttons) seekAt(e.clientX)
        }}
      >
        {reps.map((r, i) => (
          <rect key={i} x={geo.x(r.start)} y={PAD.t} width={Math.max(1, geo.x(r.end) - geo.x(r.start))} height={H - PAD.t - PAD.b} fill="var(--color-measure-soft)" />
        ))}
        {geo.ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={geo.y(v)} y2={geo.y(v)} stroke="var(--color-grid)" />
            <text x={PAD.l - 4} y={geo.y(v) + 4} textAnchor="end" fontSize="10" fill="var(--color-ink-3)">
              {fmtNum(v, 0)}
            </text>
          </g>
        ))}
        {Array.from({ length: Math.floor(geo.seconds / geo.every) + 1 }, (_, k) => k * geo.every).map((s) => (
          <text key={s} x={geo.x(geo.t0 + s * 1000)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--color-ink-3)">
            {s}秒
          </text>
        ))}
        <path d={geo.path} fill="none" stroke="var(--color-measure)" strokeWidth="1.8" strokeLinejoin="round" />
        {reps.map((r, i) => {
          const k = indexAt(ts, r.bottom)
          return <circle key={i} cx={geo.x(r.bottom)} cy={geo.y(values[k])} r="3.5" fill="var(--color-level)" stroke="var(--color-ink)" strokeWidth="1" />
        })}
        <Cursor clock={clock} x={geo.x} />
      </svg>
    </figure>
  )
}

function Cursor({ clock, x }: { clock: Clock; x: (t: number) => number }) {
  const t = useClockValue(clock, (c) => c.get())
  const cx = x(t)
  return <line x1={cx} x2={cx} y1={PAD.t - 4} y2={H - PAD.b + 2} stroke="var(--color-ink)" strokeWidth="1.2" strokeDasharray="3 2" />
}

function NowValue({ ts, values, clock, unit, digits }: { ts: number[]; values: number[]; clock: Clock; unit: string; digits: number }) {
  const t = useClockValue(clock, (c) => c.get())
  const v = values[indexAt(ts, t)]
  return (
    <span className="text-[15px] font-bold text-ink num">
      {v === undefined ? '—' : `${fmtNum(v, digits)}${unit}`}
    </span>
  )
}
