// 角度（または位置）の時間変化のグラフ。今の時刻に縦線を引き、触ったところへ移る。1 回ごとの区間に帯を付ける
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
  cycles,
  clock,
  label,
  band,
  reference,
}: {
  ts: number[]
  /** 出せないコマは NaN（線を切る） */
  values: number[]
  unit: string
  digits: number
  /** 1 回ごとの区間と、点を打つ時刻 */
  cycles: { start: number; end: number; mark?: number }[]
  clock: Clock
  label: string
  /** 仮定を動かした幅（下限・上限） */
  band?: { lo: number[]; hi: number[] }
  /** 出典のある目安の範囲 */
  reference?: { lo: number; hi: number; label: string }
}) {
  const svg = useRef<SVGSVGElement>(null)
  const geo = useMemo(() => {
    const t0 = clock.start
    const t1 = clock.end
    // 幅の帯は、値の範囲の上下に値の幅ぶんまでで切る（ほぼ立っているところで幅が大きく広がり、線がつぶれないように）
    const fin = values.filter(Number.isFinite)
    const vlo = fin.length ? Math.min(...fin) : 0
    const vhi = fin.length ? Math.max(...fin) : 1
    const span = Math.max(vhi - vlo, Math.abs(vhi) * 0.2, 1e-6)
    const cap = (v: number) => Math.min(vhi + span, Math.max(vlo - span, v))
    const all = [...fin, ...(band ? [...band.lo, ...band.hi].filter(Number.isFinite).map(cap) : []), ...(reference ? [reference.lo, reference.hi] : [])]
    const lo0 = all.length ? Math.min(...all) : 0
    const hi0 = all.length ? Math.max(...all) : 1
    const step = niceStep(Math.max(1, hi0 - lo0))
    const lo = Math.floor(lo0 / step) * step
    const hi = Math.ceil(hi0 / step) * step
    const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r)
    const y = (v: number) => H - PAD.b - ((v - lo) / Math.max(1e-6, hi - lo)) * (H - PAD.t - PAD.b)
    const ticks: number[] = []
    for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(v)
    // NaN のコマで線を切る
    const path = values
      .map((v, i) => (Number.isFinite(v) ? `${i && Number.isFinite(values[i - 1]) ? 'L' : 'M'}${x(ts[i]).toFixed(1)},${y(v).toFixed(1)}` : ''))
      .join('')
    // 幅の帯（続いているところごとに、上限を行って下限を戻る）
    const area: string[] = []
    if (band) {
      let run: number[] = []
      const flush = () => {
        if (run.length > 1) area.push(`M${run.map((i) => `${x(ts[i]).toFixed(1)},${y(cap(band.hi[i])).toFixed(1)}`).join('L')}L${[...run].reverse().map((i) => `${x(ts[i]).toFixed(1)},${y(cap(band.lo[i])).toFixed(1)}`).join('L')}Z`)
        run = []
      }
      ts.forEach((_, i) => (Number.isFinite(band.lo[i]) && Number.isFinite(band.hi[i]) ? run.push(i) : flush()))
      flush()
    }
    const seconds = Math.floor((t1 - t0) / 1000)
    const every = seconds > 12 ? 5 : seconds > 6 ? 2 : 1
    return { x, y, ticks, path, area: area.join(''), seconds, every, t0, t1 }
  }, [ts, values, clock, band, reference])

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
        {cycles.map((r, i) => (
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
        {reference && (
          <g>
            <rect
              x={PAD.l}
              y={geo.y(reference.hi)}
              width={W - PAD.l - PAD.r}
              height={Math.max(1, geo.y(reference.lo) - geo.y(reference.hi))}
              fill="var(--color-level)"
              fillOpacity="0.18"
              stroke="var(--color-ink-3)"
              strokeDasharray="3 3"
              strokeWidth="0.8"
            />
            <text x={PAD.l + 4} y={geo.y(reference.hi) - 3} fontSize="9.5" fill="var(--color-ink-2)">
              {reference.label}
            </text>
          </g>
        )}
        {geo.area && <path d={geo.area} fill="#E9B85E" fillOpacity="0.28" stroke="none" />}
        <path d={geo.path} fill="none" stroke="var(--color-measure)" strokeWidth="1.8" strokeLinejoin="round" />
        {cycles.map((r, i) => {
          if (r.mark === undefined) return null
          const k = indexAt(ts, r.mark)
          if (!Number.isFinite(values[k])) return null
          return <circle key={i} cx={geo.x(r.mark)} cy={geo.y(values[k])} r="3.5" fill="var(--color-level)" stroke="var(--color-ink)" strokeWidth="1" />
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
      {v === undefined || !Number.isFinite(v) ? '—' : `${fmtNum(v, digits)}${unit}`}
    </span>
  )
}
