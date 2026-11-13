// 1 回をそろえた曲線: エルゴの「脚・上体・腕が動く順番」と、自転車の「クランクの角度ごとの関節の角度」
import { useMemo, useState } from 'react'
import { PROFILES, type MotionCycle, type PreparedMotion } from '../domain/motion'
import { SEQUENCE_LABELS, SEQUENCE_PARTS, strokeProfile, type SequencePart } from '../domain/motionSequence'
import { crankProfile } from '../domain/motionCrank'
import { fmtNum } from '../domain/format'
import { Segmented } from './ui'

const W = 340
const H = 170
const PAD = { l: 34, r: 16, t: 10, b: 24 }
const plotW = W - PAD.l - PAD.r
const plotH = H - PAD.t - PAD.b

const SEQ_STYLE: Record<SequencePart, { color: string; dash?: string; short: string }> = {
  leg: { color: 'var(--color-measure)', short: '脚' },
  trunk: { color: '#C98A1E', dash: '6 3', short: '上体' },
  arm: { color: 'var(--color-ink)', dash: '2 2.5', short: '腕' },
}

/** 続いている有限の値ごとに線を引く */
function linePath(xs: number[], ys: number[], x: (v: number) => number, y: (v: number) => number) {
  return ys.map((v, i) => (Number.isFinite(v) ? `${i && Number.isFinite(ys[i - 1]) ? 'L' : 'M'}${x(xs[i]).toFixed(1)},${y(v).toFixed(1)}` : '')).join('')
}

export function SequenceChart({ prep, cycles }: { prep: PreparedMotion; cycles: MotionCycle[] }) {
  const prof = useMemo(() => strokeProfile(prep, cycles), [prep, cycles])
  if (!prof) return null
  const xs = prof.curves.leg.map((_, k) => k)
  const x = (p: number) => PAD.l + (p / 100) * plotW
  const lo = -0.4
  const y = (v: number) => PAD.t + (1 - (Math.max(lo, Math.min(1.05, v)) - lo) / (1.05 - lo)) * plotH
  const end = prof.finish ?? 100
  const peaks = SEQUENCE_PARTS.map((part) => {
    const c = prof.curves[part]
    let at = 0
    for (let k = 0; k <= Math.round(end); k++) if (c[k] > c[at]) at = k
    return { part, at, v: c[at] }
  })
  return (
    <figure className="rounded-[var(--radius-panel)] bg-surface p-3 shadow-lift">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`1 本の中の、脚・上体・腕の動く速さ。速さがいちばん大きい時刻は、${peaks.map((p) => `${SEQ_STYLE[p.part].short} ${p.at}%`).join('、')}`}>
        <rect x={PAD.l} y={PAD.t} width={x(end) - PAD.l} height={plotH} fill="var(--color-measure-soft)" />
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--color-grid)" />
            <text x={PAD.l - 4} y={y(v) + 3.5} textAnchor="end" fontSize="9.5" fill="var(--color-ink-3)">
              {v}
            </text>
          </g>
        ))}
        {[0, 25, 50, 75, 100].map((p) => (
          <text key={p} x={x(p)} y={H - 7} textAnchor="middle" fontSize="9.5" fill="var(--color-ink-3)">
            {p}%
          </text>
        ))}
        <text x={x(end / 2)} y={H - PAD.b - 4} textAnchor="middle" fontSize="9.5" fill="var(--color-ink-2)">
          ドライブ
        </text>
        <text x={x((end + 100) / 2)} y={H - PAD.b - 4} textAnchor="middle" fontSize="9.5" fill="var(--color-ink-2)">
          リカバリー
        </text>
        {SEQUENCE_PARTS.map((part) => (
          <path key={part} d={linePath(xs, prof.curves[part], x, y)} fill="none" stroke={SEQ_STYLE[part].color} strokeWidth="2" strokeDasharray={SEQ_STYLE[part].dash} />
        ))}
        {peaks.map((p) => (
          <g key={p.part}>
            <circle cx={x(p.at)} cy={y(p.v)} r="3.5" fill={SEQ_STYLE[p.part].color} stroke="var(--color-surface)" strokeWidth="1" />
            <text x={x(p.at) + 5} y={y(p.v) + 3.5} fontSize="10" fontWeight="bold" fill="var(--color-ink)">
              {SEQ_STYLE[p.part].short}
            </text>
          </g>
        ))}
      </svg>
      <ul className="mt-1 space-y-0.5 text-sm">
        {peaks.map((p) => (
          <li key={p.part} className="flex items-center gap-2">
            <svg width="28" height="8" aria-hidden>
              <line x1="0" x2="28" y1="4" y2="4" stroke={SEQ_STYLE[p.part].color} strokeWidth="2" strokeDasharray={SEQ_STYLE[p.part].dash} />
            </svg>
            <span className="flex-1">{SEQUENCE_LABELS[p.part]}</span>
            <span className="num text-ink-2">ドライブの {Math.round((p.at / end) * 100)}%</span>
          </li>
        ))}
      </ul>
      <figcaption className="mt-2 text-xs text-ink-3">
        横軸は 1 本（キャッチから次のキャッチ）を 0〜100% にそろえたもので、色の帯がドライブです。それぞれの速さは、その本の中の最大を 1 として {prof.strokes} 本を平均しました。右の % は、平均の曲線でいちばん速いところがドライブのどこにあるかです（下の「平均」の値は 1 本ごとに求めて平均したもので、少し違うことがあります）。順番や間隔の良し悪しは判定しません。
      </figcaption>
    </figure>
  )
}

export function CrankChart({ prep, cycles }: { prep: PreparedMotion; cycles: MotionCycle[] }) {
  const options = PROFILES.bike.series.filter((d) => ['knee', 'hip', 'ankle'].includes(d.key))
  const [key, setKey] = useState('knee')
  const crank = prep.crank
  const prof = useMemo(() => (crank ? crankProfile(prep, crank, cycles, key, 36) : null), [prep, crank, cycles, key])
  if (!crank || !prof) return <p className="text-sm text-ink-3">足首の点の動きが円になっていなかったため、クランクの角度ごとの曲線は出していません。</p>
  const def = options.find((d) => d.key === key) ?? options[0]
  const lows = prof.mean.map((m, b) => m - (Number.isFinite(prof.sd[b]) ? prof.sd[b] : 0)).filter(Number.isFinite)
  const highs = prof.mean.map((m, b) => m + (Number.isFinite(prof.sd[b]) ? prof.sd[b] : 0)).filter(Number.isFinite)
  const lo = Math.floor(Math.min(...lows) / 10) * 10
  const hi = Math.ceil(Math.max(...highs) / 10) * 10
  const x = (a: number) => PAD.l + (a / 360) * plotW
  const y = (v: number) => PAD.t + (1 - (v - lo) / Math.max(1, hi - lo)) * plotH
  // コマのない角度の区間（1 回転のコマ数が少ないとき）は、前後をつないで描く
  const has = prof.mean.map((_, b) => b).filter((b) => Number.isFinite(prof.mean[b]))
  const up = has.map((b) => `${x(prof.centers[b]).toFixed(1)},${y(prof.mean[b] + (prof.sd[b] || 0)).toFixed(1)}`)
  const down = [...has].reverse().map((b) => `${x(prof.centers[b]).toFixed(1)},${y(prof.mean[b] - (prof.sd[b] || 0)).toFixed(1)}`)
  const area = has.length > 1 ? [`M${up.join('L')}L${down.join('L')}Z`] : []
  const line = has.map((b, i) => `${i ? 'L' : 'M'}${x(prof.centers[b]).toFixed(1)},${y(prof.mean[b]).toFixed(1)}`).join('')
  const step = hi - lo > 60 ? 20 : 10
  const ticks: number[] = []
  for (let v = lo; v <= hi; v += step) ticks.push(v)
  return (
    <figure className="rounded-[var(--radius-panel)] bg-surface p-3 shadow-lift">
      <Segmented legend="値" value={key} onChange={setKey} columns={options.length} options={options.map((d) => ({ value: d.key, label: d.short }))} />
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" role="img" aria-label={`クランクの角度ごとの${def.label}の平均と揺れ`}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--color-grid)" />
            <text x={PAD.l - 4} y={y(v) + 3.5} textAnchor="end" fontSize="9.5" fill="var(--color-ink-3)">
              {v}
            </text>
          </g>
        ))}
        {(
          [
            [0, '上死点 0°'],
            [90, crank.reversed ? '後ろ 90°' : '前 90°'],
            [180, '下死点 180°'],
            [270, crank.reversed ? '前 270°' : '後ろ 270°'],
          ] as const
        ).map(([a, label]) => (
          <g key={a}>
            <line x1={x(a)} x2={x(a)} y1={PAD.t} y2={H - PAD.b} stroke="var(--color-grid)" strokeDasharray="2 3" />
            <text x={x(a) + (a === 0 ? 2 : 0)} y={H - 7} textAnchor={a === 0 ? 'start' : 'middle'} fontSize="9.5" fill="var(--color-ink-3)">
              {label}
            </text>
          </g>
        ))}
        <path d={area.join('')} fill="var(--color-measure)" fillOpacity="0.18" />
        <path d={line} fill="none" stroke="var(--color-measure)" strokeWidth="2" />
      </svg>
      <figcaption className="mt-1 text-xs text-ink-3">
        {def.label}（{def.unit}）を、クランクの角度 10° ごとに平均した線と、回転ごとの揺れ（± 標準偏差の帯）です。クランクの角度は、足首の点の軌跡に当てた円（半径 {fmtNum(crank.circle.r, 0)} ピクセル、円からのずれ {fmtNum(crank.roundness * 100, 0)}%）のまわりの向きで、足首はペダルの軸から少し離れているため、クランクそのものの角度とは少しずれます。
        {crank.reversed && '顔の向きから見ると後ろ向きに回っていたため、回る向きに角度を数えています（90° が後ろになります）。'}
      </figcaption>
    </figure>
  )
}
