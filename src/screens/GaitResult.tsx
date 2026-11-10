// 歩き方の一覧と結果（試作）
import { Suspense, lazy, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { ChevronRight, Footprints, Trash2, Video } from 'lucide-react'
import {
  FOOTWEAR_LABELS,
  GAIT_LABELS,
  GAIT_METRIC_KEYS,
  compareGait,
  gaitInputOf,
  gaitMetric,
  preparePasses,
  type GaitMetric,
  type GaitMetricKey,
  type GaitRecord,
} from '../domain/gait'
import { gaitClips } from '../domain/gaitPose'
import type { AssessmentSession, MetricKey, UserProfile } from '../domain/types'
import { fmtDate, fmtNum, localDateKey } from '../domain/format'
import { data } from '../data/repo'
import { useGaits, useProfile, useSessions } from '../data/hooks'
import { useToast } from '../state/stores'
import { Badge, Button, ButtonLink, Details, Dialog, EmptyState, IconButton, Notice, Screen, SectionTitle } from '../components/ui'

// 3D（three.js）は重いので、結果を開いたときに読み込む
const GaitPlayer = lazy(() => import('../three/GaitPlayer'))

function fmtMetric(m: GaitMetric | undefined) {
  if (!m || m.status !== 'ok' || m.value === null) return '測定不可'
  const { unit, digits } = GAIT_LABELS[m.key]
  const sign = (m.key === 'trunk_lean' || m.key === 'head_forward') && m.value > 0 ? '+' : ''
  return `${sign}${fmtNum(m.value, digits)}${unit === '%' || unit === '°' ? unit : ` ${unit}`}`
}

/** 差や揺れの単位（% の差は「ポイント」） */
function diffUnit(key: GaitMetricKey) {
  const { unit } = GAIT_LABELS[key]
  return unit === '%' ? ' ポイント' : unit === '°' ? '°' : ` ${unit}`
}

function fmtDiff(key: GaitMetricKey, d: number) {
  return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmtNum(Math.abs(d), GAIT_LABELS[key].digits)}${diffUnit(key)}`
}

// ---------- 一覧 ----------

export function GaitList() {
  const gaits = useGaits()
  if (gaits === undefined) return <Screen title="歩き方（試作）" back="/">{null}</Screen>
  return (
    <Screen title="歩き方（試作）" back="/">
      {!gaits.length ? (
        <EmptyState
          title="横から歩く様子を撮って、歩き方を記録します"
          action={
            <ButtonLink to="/gait/capture" variant="primary" size="lg" block icon={<Video aria-hidden className="size-5" />}>
              歩き方を撮る
            </ButtonLink>
          }
        >
          歩くテンポ・歩幅・上体の傾き・頭の位置・腕の振りを測り、マネキンで動きを再生します。動画は保存しません。
        </EmptyState>
      ) : (
        <>
          <ButtonLink to="/gait/capture" variant="primary" size="lg" block className="mt-2" icon={<Video aria-hidden className="size-5" />}>
            歩き方を撮る
          </ButtonLink>
          <SectionTitle>記録</SectionTitle>
          <ul className="divide-y divide-line rounded-[var(--radius-panel)] bg-surface shadow-lift">
            {gaits.map((g) => (
              <li key={g.id}>
                <Link to={`/gait/${g.id}`} className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-sunken">
                  <Footprints aria-hidden className="size-5 shrink-0 text-measure" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium num">{fmtDate(g.createdAt, true)}</p>
                    <p className="text-sm text-ink-3 num">
                      テンポ {fmtMetric(gaitMetric(g.analysis, 'cadence'))}・歩幅 {fmtMetric(gaitMetric(g.analysis, 'step_length'))}・上体{' '}
                      {fmtMetric(gaitMetric(g.analysis, 'trunk_lean'))}
                    </p>
                  </div>
                  <ChevronRight aria-hidden className="size-5 text-ink-3" />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </Screen>
  )
}

// ---------- 結果 ----------

/** 立ち姿の測定の、同じ考え方の指標（参考に並べる） */
const STANDING: Partial<Record<GaitMetricKey, MetricKey>> = {
  trunk_lean: 'side_trunk_lean',
  head_forward: 'side_head_forward',
}

function standingValue(s: AssessmentSession | undefined, key: GaitMetricKey) {
  const k = STANDING[key]
  const m = k ? s?.computedMetrics.find((c) => c.key === k) : undefined
  if (!m || m.rawValue === null || m.status === 'unassessable' || m.status === 'unsupported') return null
  return m.rawValue
}

export function GaitResult() {
  const { id } = useParams()
  const gaits = useGaits()
  const sessions = useSessions()
  const profile = useProfile()
  if (gaits === undefined || sessions === undefined || profile === undefined) return <Screen title="歩き方" back="/gait">{null}</Screen>
  const idx = gaits.findIndex((g) => g.id === id)
  if (idx < 0) return <Navigate to="/gait" replace />
  const rec = gaits[idx]
  const prev = gaits[idx + 1]
  // 同じ日か、それより前の、横向きのある立ち姿の測定
  const standing = sessions.find((s) => s.side && localDateKey(new Date(s.createdAt)) <= localDateKey(new Date(rec.createdAt)))
  return <GaitResultBody rec={rec} prev={prev} standing={standing} sex={profile?.sex} />
}

function GaitResultBody({ rec, prev, standing, sex }: { rec: GaitRecord; prev?: GaitRecord; standing?: AssessmentSession; sex?: UserProfile['sex'] }) {
  const navigate = useNavigate()
  const toast = useToast((t) => t.show)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const input = useMemo(() => gaitInputOf(rec), [rec])
  const clips = useMemo(() => gaitClips(input), [input])
  const passes = useMemo(() => preparePasses(input).passes.filter((p) => !p.pass.excluded), [input])
  const changes = useMemo(() => (prev ? compareGait(prev.analysis, rec.analysis) : []), [prev, rec])
  const a = rec.analysis
  const conditions: string[] = []
  if (prev && (prev.footwear ?? 'shoes') !== (rec.footwear ?? 'shoes')) {
    conditions.push(`足元が前回（${FOOTWEAR_LABELS[prev.footwear ?? 'shoes']}）と今回（${FOOTWEAR_LABELS[rec.footwear ?? 'shoes']}）で違います。歩幅やテンポが変わりやすくなります。`)
  }
  if (prev && prev.source !== rec.source) conditions.push('前回と今回で撮り方（アプリのカメラ / 選んだ動画）が違います。')

  const del = async () => {
    await data.deleteGait(rec.id)
    toast('記録を削除しました')
    navigate('/gait', { replace: true })
  }

  return (
    <Screen
      title="歩き方"
      back="/gait"
      action={
        <IconButton label="この記録を削除" onClick={() => setConfirmDelete(true)}>
          <Trash2 aria-hidden className="size-5" />
        </IconButton>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-3 num">{fmtDate(rec.createdAt, true)}</span>
        <Badge tone="measure">試作</Badge>
        <Badge>{rec.source === 'camera' ? 'アプリで撮影' : '選んだ動画'}</Badge>
        {rec.footwear && <Badge>{FOOTWEAR_LABELS[rec.footwear]}</Badge>}
      </div>

      {a.warnings.length > 0 && (
        <div className="mt-3">
          <Notice tone="warn" title="撮影の注意">
            <ul className="list-disc space-y-1 pl-4">
              {a.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      <div className="mt-4">
        <Suspense fallback={<div className="h-[min(56dvh,460px)] rounded-[var(--radius-panel)] bg-surface" />}>
          <GaitPlayer clips={clips} sex={sex} />
        </Suspense>
      </div>

      <SectionTitle sub="正常範囲とは比べていません。自分の過去の記録と比べるための値です。">測った値</SectionTitle>
      {conditions.length > 0 && (
        <div className="mb-3">
          <Notice tone="info" title="前回と条件が違います">
            {conditions.join('')}
          </Notice>
        </div>
      )}
      <ul className="space-y-3">
        {GAIT_METRIC_KEYS.map((key) => {
          const m = gaitMetric(a, key)
          const doc = GAIT_LABELS[key]
          const ch = changes.find((c) => c.key === key)
          const pm = prev ? gaitMetric(prev.analysis, key) : undefined
          const st = standingValue(standing, key)
          const ok = m?.status === 'ok'
          return (
            <li key={key} className="rounded-[var(--radius-panel)] bg-surface p-4 shadow-lift">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-bold">{doc.label}</h3>
                <span className="text-[22px] font-bold num">{fmtMetric(m)}</span>
              </div>
              {ok && m && (
                <p className="mt-0.5 text-right text-sm text-ink-3 num">
                  歩ごとの揺れの目安 ±{fmtNum(m.uncertainty ?? 0, 1)}
                  {diffUnit(key)}・{m.steps} 歩
                </p>
              )}
              {m?.note && <p className="mt-1 text-sm text-ink-2">{m.note}</p>}
              {prev && pm && (
                <p className="mt-2 text-[15px] text-ink-2 num">
                  前回（{fmtDate(prev.createdAt)}）{fmtMetric(pm)}
                  {ch && (
                    <>
                      {' '}→ 差 {fmtDiff(key, ch.diff)}{' '}
                      <Badge tone={ch.noticeable ? 'attention' : 'neutral'}>{ch.noticeable ? '差が見られる' : 'ばらつきの範囲内'}</Badge>
                    </>
                  )}
                </p>
              )}
              {st !== null && standing && (
                <p className="mt-1 text-sm text-ink-3 num">
                  参考: 立ち姿（{fmtDate(standing.createdAt)}）{st > 0 ? '+' : ''}
                  {fmtNum(st, 1)}°
                </p>
              )}
              <Details summary="この値について">{doc.doc}</Details>
            </li>
          )
        })}
      </ul>
      {prev && <p className="mt-2 text-sm text-ink-3">「ばらつきの範囲内」は、1 回の撮影の中の歩ごとの揺れから見た判断です。日をまたいだ体調・服・撮影位置の違いは含みません。</p>}

      {passes.length > 0 && (
        <>
          <SectionTitle sub="山が 1 歩（片足が着地したころ）です。山の高さが歩幅になります。">足首の前後の開き</SectionTitle>
          <div className="space-y-3">
            {passes.map((p, i) => (
              <SeparationChart key={i} title={`${i + 1} 回目（画面の${p.pass.dir === 1 ? '右' : '左'}へ）`} ts={p.frames.map((f) => f.t)} sep={p.sep} strikes={p.pass.strikes} strikeSep={p.strikeSep} />
            ))}
          </div>
        </>
      )}

      <div className="mt-6">
        <Details summary="撮影の情報">
          <ul className="space-y-1 text-sm num">
            <li>
              推定したコマ {rec.video.frameCount}（1 秒あたり {fmtNum(rec.video.fps, 1)}）・全身が写っていたコマ {a.validFrames}
            </li>
            <li>使った通過 {passes.length} 回{a.passes.some((p) => p.excluded) ? `（使わなかった通過 ${a.passes.filter((p) => p.excluded).length} 回）` : ''}</li>
            <li>{rec.video.rollDeg !== undefined ? `端末の傾き ${fmtNum(rec.video.rollDeg, 1)}° を戻して計算` : '端末の傾きは分からないため、戻していません'}</li>
            <li>
              映像 {rec.video.width}×{rec.video.height}
              {rec.video.quarterTurns ? `（${rec.video.quarterTurns * 90}° 回して使用）` : ''}・{rec.modelVersion}
            </li>
          </ul>
        </Details>
      </div>

      <p className="mt-4 text-sm text-ink-3">
        医療診断ではありません。歩き方の良し悪しは判定していません。動画は保存せず、体の点の動きだけを端末に保存しています。
      </p>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="この記録を削除しますか"
        actions={
          <>
            <Button variant="danger" block onClick={del}>
              削除する
            </Button>
            <Button variant="quiet" block onClick={() => setConfirmDelete(false)}>
              やめる
            </Button>
          </>
        }
      />
    </Screen>
  )
}

function SeparationChart({ title, ts, sep, strikes, strikeSep }: { title: string; ts: number[]; sep: number[]; strikes: number[]; strikeSep: number[] }) {
  const W = 320
  const H = 110
  const pad = { l: 36, r: 8, t: 8, b: 22 }
  const t0 = ts[0]
  const t1 = ts[ts.length - 1]
  const maxY = Math.max(1, ...sep)
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r)
  const y = (v: number) => H - pad.b - (v / maxY) * (H - pad.t - pad.b)
  const line = sep.map((v, i) => `${x(ts[i]).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const seconds = Math.floor((t1 - t0) / 1000)
  return (
    <figure className="rounded-[var(--radius-panel)] bg-surface p-3 shadow-lift">
      <figcaption className="text-sm font-medium text-ink-2">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 w-full" role="img" aria-label={`${title}。${strikes.length} 歩の山`}>
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--color-grid)" />
            <text x={pad.l - 4} y={y(v) + 4} textAnchor="end" fontSize="10" fill="var(--color-ink-3)">
              {Math.round(v * 100)}%
            </text>
          </g>
        ))}
        {Array.from({ length: seconds + 1 }, (_, s) => (
          <text key={s} x={x(t0 + s * 1000)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--color-ink-3)">
            {s}秒
          </text>
        ))}
        <polyline points={line} fill="none" stroke="var(--color-measure)" strokeWidth="1.8" />
        {strikes.map((t, i) => (
          <circle key={i} cx={x(t)} cy={y(strikeSep[i])} r="3.5" fill="var(--color-level)" stroke="var(--color-ink)" strokeWidth="1" />
        ))}
      </svg>
    </figure>
  )
}
