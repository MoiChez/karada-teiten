// 推移グラフ（直近 7 / 30 / 90 日）。グラフの下に同じ値の表も出す
import { useMemo, useState } from 'react'
import { CartesianGrid, ErrorBar, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { AssessmentSession, MetricKey } from '../domain/types'
import { metricSeries } from '../domain/compare'
import { metricLabel } from '../domain/metrics'
import { fmtShortDate, fmtValue } from '../domain/format'
import { Segmented } from './ui'

const KEYS: MetricKey[] = [
  'front_shoulder_tilt',
  'front_pelvis_tilt',
  'front_head_tilt',
  'front_body_lean',
  'front_trunk_shift',
  'front_lower_lean',
  'front_neck_shift',
  'front_knee_left',
  'front_knee_right',
  'side_head_forward',
  'side_trunk_lean',
  'side_knee_extension',
  'composite_kyphosis',
  'composite_swayback',
]

export default function TrendChart({ sessions }: { sessions: AssessmentSession[] }) {
  const [days, setDays] = useState<7 | 30 | 90>(30)
  const [key, setKey] = useState<MetricKey>('front_shoulder_tilt')
  const series = useMemo(() => metricSeries(sessions, key, days), [sessions, key, days])
  const unit = sessions.flatMap((s) => s.computedMetrics).find((m) => m.key === key)?.unit ?? '°'
  const rows = series.map((p) => ({ date: fmtShortDate(p.date), value: p.value, err: p.uncertainty ? p.uncertainty * 2 : 0 }))

  return (
    <div>
      <Segmented
        legend="期間"
        value={days}
        onChange={setDays}
        options={[
          { value: 7, label: '7 日' },
          { value: 30, label: '30 日' },
          { value: 90, label: '90 日' },
        ]}
      />
      <label htmlFor="trend-key" className="mb-1.5 block font-medium">
        指標
      </label>
      <select id="trend-key" value={key} onChange={(e) => setKey(e.target.value as MetricKey)} className="mb-4 min-h-12 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 text-[16px]">
        {KEYS.map((k) => (
          <option key={k} value={k}>
            {metricLabel(k)}
          </option>
        ))}
      </select>

      {rows.length < 2 ? (
        <p className="rounded-[var(--radius-panel)] bg-surface p-6 text-center text-ink-2">
          この期間の記録が {rows.length} 件のため、推移を描けません。期間を広げるか、測定を続けてください。
        </p>
      ) : (
        <figure>
          <div className="h-64 rounded-[var(--radius-panel)] bg-surface p-2" role="img" aria-label={`${metricLabel(key)}の推移。表は下にあります`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 12, right: 12, bottom: 4, left: -8 }}>
                <CartesianGrid stroke="var(--color-grid)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 12, fill: 'var(--color-ink-3)' }} tickLine={false} axisLine={{ stroke: 'var(--color-line)' }} />
                <YAxis tick={{ fontSize: 12, fill: 'var(--color-ink-3)' }} tickLine={false} axisLine={false} width={44} unit={unit === 'score' ? '' : unit} />
                <Tooltip formatter={(v) => [fmtValue(Number(v), unit), metricLabel(key)]} contentStyle={{ borderRadius: 10, border: '1px solid var(--color-line)' }} />
                <Line type="linear" dataKey="value" stroke="var(--color-ink)" strokeWidth={2.5} dot={{ r: 4, fill: 'var(--color-level)', stroke: 'var(--color-ink)', strokeWidth: 1.5 }} isAnimationActive={false}>
                  <ErrorBar dataKey="err" width={6} stroke="var(--color-past)" direction="y" />
                </Line>
              </LineChart>
            </ResponsiveContainer>
          </div>
          <figcaption className="mt-1 text-sm text-ink-3">縦の線は測定のばらつきの目安（±2σ）です。線どうしが重なる範囲の変化は、ばらつきの範囲内の可能性があります。</figcaption>
        </figure>
      )}

      {rows.length > 0 && (
        <table className="mt-4 w-full text-[15px]">
          <caption className="sr-only">{metricLabel(key)}の値</caption>
          <thead>
            <tr className="border-b border-line text-left text-sm text-ink-3">
              <th className="py-2 font-medium">日付</th>
              <th className="py-2 text-right font-medium">値</th>
              <th className="py-2 text-right font-medium">ばらつき目安</th>
            </tr>
          </thead>
          <tbody>
            {series.map((p) => (
              <tr key={p.sessionId} className="border-b border-line num">
                <td className="py-2">{fmtShortDate(p.date)}</td>
                <td className="py-2 text-right">{fmtValue(p.value, unit)}</td>
                <td className="py-2 text-right text-ink-3">{p.uncertainty !== null ? `±${fmtValue(p.uncertainty, unit)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
