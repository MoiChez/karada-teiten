// 専門家に見せる画面。正面と横向きの骨格（前回を点線で重ねる）、主な値と判定の幅、前回との差、撮影の条件を 1 画面にまとめる。
// 利用者が押したときだけ、この画面を 1 枚の画像にして端末に保存する（外へは送らない）
import { useMemo, useRef, useState } from 'react'
import { Navigate, useParams } from 'react-router'
import { Download } from 'lucide-react'
import type { AssessmentSession, ComputedMetric, Plane } from '../domain/types'
import { compareSessions, CHANGE_LABELS, type MetricChange } from '../domain/compare'
import { AREA_LABELS, JUDGE_WIDTH_NOTE, SESSION_TAG_LABELS, aboutCm, confidenceLabel, fmtDate, fmtShortDate, fmtValue, judgeWidth, offsetCm } from '../domain/format'
import { ALGORITHM_VERSION } from '../domain/constants'
import { APP_VERSION, correctedSet } from '../domain/session'
import { useCheckins, useProfile, useSession, useSessions } from '../data/hooks'
import { PhotoWithPose, PostureGrid, useStoredImageUrl } from '../components/PoseViews'
import { Button, Screen, cx } from '../components/ui'
import { useToast } from '../state/stores'

const PLANE_NAME: Record<Plane, string> = { front: '正面', side: '横向き' }

export function ShareView() {
  const { id } = useParams()
  const s = useSession(id)
  if (s === undefined) return <Screen title="専門家に見せる" back="/history">{null}</Screen>
  if (!s) return <Navigate to="/history" replace />
  return <ShareBody s={s} />
}

interface Row {
  m: ComputedMetric
  value: string
  width: string
  change?: MetricChange
}

function rowsOf(s: AssessmentSession, plane: Plane, heightCm: number | undefined, changes: Map<string, MetricChange>): Row[] {
  return s.computedMetrics
    .filter((m) => m.plane === plane && m.rawValue !== null && m.status !== 'unsupported' && m.group !== 'composite')
    .map((m) => {
      const cm = offsetCm(m, heightCm)
      const w = m.status === 'descriptive' ? null : judgeWidth(m.uncertainty)
      return {
        m,
        value: `${fmtValue(m.rawValue, m.unit)}${cm ? `（${aboutCm(Math.abs(cm.cm), cm.sigmaCm)}）` : ''}`,
        width: w === null ? '記録のみ' : `±${fmtValue(w, m.unit)}`,
        change: changes.get(m.key),
      }
    })
}

function changeText(c: MetricChange | undefined): string {
  if (!c) return ''
  const sign = c.diff > 0 ? '+' : c.diff < 0 ? '−' : '±'
  return `${fmtValue(c.before, c.unit)} → 差 ${sign}${fmtValue(Math.abs(c.diff), c.unit)}（${CHANGE_LABELS[c.change]}）`
}

function ShareBody({ s }: { s: AssessmentSession }) {
  const toast = useToast((t) => t.show)
  const profile = useProfile()
  const sessions = useSessions()
  const checkins = useCheckins()
  const [withPhotos, setWithPhotos] = useState(false)
  const [busy, setBusy] = useState(false)
  const figs = useRef<HTMLDivElement>(null)
  const heightCm = profile?.heightCm
  const planes: Plane[] = [s.front && 'front', s.side && 'side'].filter(Boolean) as Plane[]
  const prev = (sessions ?? []).filter((x) => x.createdAt < s.createdAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)
  const cmp = useMemo(() => (prev ? compareSessions(prev, s) : null), [prev, s])
  const changes = useMemo(() => new Map((cmp?.changes ?? []).map((c) => [c.key, c])), [cmp])
  const checkin = checkins?.find((c) => c.id === s.checkinId)
  const conditions = useMemo(() => conditionLines(s), [s])
  const noticeable = s.postureTraits.filter((t) => t.status === 'noticeable')

  const save = async () => {
    setBusy(true)
    try {
      const blob = await renderImage({
        s,
        prevDate: prev?.createdAt,
        planes,
        rows: planes.map((p) => ({ plane: p, rows: rowsOf(s, p, heightCm, changes) })),
        conditions: [...conditions, ...(cmp?.warnings.map((w) => w.message) ?? [])],
        checkin: checkinLine(checkin),
        figures: figs.current,
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const d = new Date(s.createdAt)
      a.href = url
      a.download = `karada-teiten-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      toast('画像を保存しました')
    } catch {
      toast('画像を作れませんでした')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen
      title="専門家に見せる"
      back={`/session/${s.id}`}
      footer={
        <Button variant="primary" size="lg" block onClick={save} loading={busy} icon={<Download aria-hidden className="size-5" />}>
          この画面を画像で保存
        </Button>
      }
    >
      <p className="text-[15px] text-ink-2">
        整体・理学療法などの専門家に見せるための画面です。画像はこのスマホに保存するだけで、外へは送りません。
      </p>

      <section className="mt-4 border-t border-line pt-3">
        <h2 className="text-[19px] font-bold num">{fmtDate(s.createdAt, true)} の記録</h2>
        <p className="mt-0.5 text-sm text-ink-2">
          {prev ? `前回（${fmtShortDate(prev.createdAt)}）を点線で重ねています。` : '前回の記録はありません。'}
          {s.tags?.length ? ` 札: ${s.tags.map((t) => SESSION_TAG_LABELS[t]).join('・')}` : ''}
        </p>
        {s.note && <p className="mt-1 text-[15px]">メモ: {s.note}</p>}
      </section>

      <div ref={figs} className={cx('mt-3 grid gap-3', planes.length > 1 ? 'grid-cols-2' : 'mx-auto max-w-[300px] grid-cols-1')}>
        {planes.map((p) => (
          <ShareFigure key={p} s={s} plane={p} prev={prev} withPhoto={withPhotos} />
        ))}
      </div>
      {s.imagesSaved && (
        <label className="mt-2 flex min-h-11 items-center gap-2 text-[15px]">
          <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} />
          写真で見せる（画像にも写真が入ります）
        </label>
      )}

      {noticeable.length > 0 && (
        <section className="mt-5">
          <h2 className="text-[17px] font-bold">判定の幅を超えた差</h2>
          <ul className="mt-1 space-y-1">
            {noticeable.map((t) => (
              <li key={t.key} className="rule-fact pl-3 text-[15px]">
                <span className="font-medium">{t.label}</span>: {t.summary}
                {t.relatedAreas.filter((a) => a !== 'whole_body').length > 0 && (
                  <span className="text-ink-3">（関連が考えられる部位: {t.relatedAreas.filter((a) => a !== 'whole_body').map((a) => AREA_LABELS[a]).join('・')}）</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {planes.map((p) => {
        const rows = rowsOf(s, p, heightCm, changes)
        return (
          <section key={p} className="mt-5">
            <h2 className="text-[17px] font-bold">{PLANE_NAME[p]}の値</h2>
            <ul className="mt-1 divide-y divide-line border-y border-line">
              {rows.map((r) => (
                <li key={r.m.key} className="py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 text-[15px] font-medium">{r.m.label}</span>
                    <span className="shrink-0 text-[15px] whitespace-nowrap num">{r.value}</span>
                  </div>
                  <p className="text-sm text-ink-2 num">
                    {r.m.direction}・判定の幅 {r.width}
                    {r.m.status === 'noticeable' ? '・差あり' : ''}
                  </p>
                  {r.change && <p className="text-sm text-ink-3 num">前回 {changeText(r.change)}</p>}
                </li>
              ))}
            </ul>
          </section>
        )
      })}

      <section className="mt-5">
        <h2 className="text-[17px] font-bold">撮影の条件</h2>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[15px] text-ink-2">
          {conditions.map((c) => (
            <li key={c}>{c}</li>
          ))}
          {cmp?.warnings.map((w) => (
            <li key={w.key}>{w.message}</li>
          ))}
          {checkinLine(checkin) && <li>{checkinLine(checkin)}</li>}
        </ul>
      </section>

      <p className="mt-5 text-sm text-ink-2">
        良し悪しの判定ではありません。「差あり」は判定の幅を超える差です。{JUDGE_WIDTH_NOTE}医療の診断ではありません。
      </p>
      <p className="mt-2 text-xs text-ink-3 num">
        からだ定点 {APP_VERSION}・計算 v{ALGORITHM_VERSION}・{s.modelVersion}
      </p>
    </Screen>
  )
}

function ShareFigure({ s, plane, prev, withPhoto }: { s: AssessmentSession; plane: Plane; prev?: AssessmentSession; withPhoto: boolean }) {
  const rec = s[plane]!
  const url = useStoredImageUrl(withPhoto ? rec.imageMetadata.imageId : undefined)
  return (
    <figure className="min-w-0" data-plane={plane}>
      {withPhoto && url ? (
        <PhotoWithPose record={rec} imageUrl={url} alt={`${PLANE_NAME[plane]}の写真と骨格`} />
      ) : (
        <PostureGrid current={rec} past={prev?.[plane]} label={`${PLANE_NAME[plane]}の骨格${prev ? '（点線は前回）' : ''}`} />
      )}
      <figcaption className="mt-1 text-center text-sm text-ink-2">{PLANE_NAME[plane]}</figcaption>
    </figure>
  )
}

function conditionLines(s: AssessmentSession): string[] {
  const out = [
    s.shootStyle === 'mirror' ? '撮り方: 鏡の前で自撮り' : '撮り方: スマホを置いて撮影',
    `点の写り: ${confidenceLabel(s.confidenceScores.overall)}`,
    (s.front && correctedSet(s.front).size > 0) || (s.side && correctedSet(s.side).size > 0) ? '点を手で直した所があります' : '点は手で直していません',
  ]
  const tilt = (['front', 'side'] as const)
    .map((p) => (s[p]?.imageMetadata.deviceTilt ? `${PLANE_NAME[p]} ${Math.abs(s[p]!.imageMetadata.deviceTilt!.rollDeg).toFixed(0)}°` : null))
    .filter(Boolean)
  if (tilt.length) out.push(`撮影時の端末の傾き: ${tilt.join('・')}`)
  if (s.side?.imageMetadata.facing) out.push(`横向きの向き: 画面の${s.side.imageMetadata.facing === 'left' ? '左' : '右'}を向いて撮影`)
  for (const f of s.qualityFlags) if (f.severity !== 'minor') out.push(f.message)
  return out
}

function checkinLine(c: { fatigueRating?: number; sleepRating?: number; discomfortAreas: string[] } | undefined): string {
  if (!c) return ''
  const parts = [
    c.fatigueRating ? `疲れ ${c.fatigueRating}/5` : '',
    c.sleepRating ? `睡眠 ${c.sleepRating}/5` : '',
    c.discomfortAreas.length ? `気になるところ: ${c.discomfortAreas.map((a) => AREA_LABELS[a as keyof typeof AREA_LABELS] ?? a).join('・')}` : '',
  ].filter(Boolean)
  return parts.length ? `その日の調子: ${parts.join('、')}` : ''
}

// ---------- 画像にする（端末の中だけで描く） ----------

const COLOR_VARS = ['paper', 'surface', 'sunken', 'ink', 'ink-2', 'ink-3', 'line', 'line-strong', 'grid', 'level', 'level-soft', 'level-ink', 'measure', 'measure-soft', 'past', 'load', 'attention']

/** SVG の中の CSS の色の名前（var(--color-…)）を、実際の色に置き換えて、画像として読める形にする */
function svgToImage(svg: SVGSVGElement): Promise<HTMLImageElement> {
  const css = getComputedStyle(document.documentElement)
  let text = new XMLSerializer().serializeToString(svg)
  for (const v of COLOR_VARS) text = text.split(`var(--color-${v})`).join(css.getPropertyValue(`--color-${v}`).trim() || '#000')
  if (!text.includes('xmlns=')) text = text.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
  return loadImage(url)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image'))
    img.src = src
  })
}

/** 日本語の文を、幅に収まるように 1 文字ずつ折り返す */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > width && line) {
      lines.push(line)
      line = ch
    } else line += ch
  }
  if (line) lines.push(line)
  return lines
}

async function renderImage(o: {
  s: AssessmentSession
  prevDate?: string
  planes: Plane[]
  rows: { plane: Plane; rows: Row[] }[]
  conditions: string[]
  checkin: string
  figures: HTMLDivElement | null
}): Promise<Blob> {
  const css = getComputedStyle(document.documentElement)
  const col = (v: string) => css.getPropertyValue(`--color-${v}`).trim()
  const font = getComputedStyle(document.body).fontFamily
  const W = 1080
  const pad = 56
  const inner = W - pad * 2
  // 図を先に読む（写真と骨格の線は重ねて描く）
  const figs: { plane: Plane; layers: HTMLImageElement[]; ratio: number }[] = []
  for (const el of Array.from(o.figures?.querySelectorAll('figure[data-plane]') ?? [])) {
    const plane = el.getAttribute('data-plane') as Plane
    const layers: HTMLImageElement[] = []
    const photo = el.querySelector('img')
    if (photo) layers.push(await loadImage(photo.src))
    const svg = el.querySelector('svg')
    if (svg) layers.push(await svgToImage(svg as SVGSVGElement))
    const box = (photo ?? svg)?.getBoundingClientRect()
    figs.push({ plane, layers, ratio: box && box.width ? box.height / box.width : 1.4 })
  }

  // 高さを見積もるため、いったん大きめのキャンバスに描いてから切り出す
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = 6000
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = col('paper') || '#f2f5f4'
  ctx.fillRect(0, 0, W, canvas.height)
  let y = pad
  const text = (t: string, size: number, color: string, weight = 400, x = pad, width = inner, lh = 1.5) => {
    ctx.font = `${weight} ${size}px ${font}`
    ctx.fillStyle = color
    for (const line of wrap(ctx, t, width)) {
      ctx.fillText(line, x, y + size)
      y += size * lh
    }
  }
  text(`からだ定点 ${fmtDate(o.s.createdAt, true)} の記録`, 40, col('ink'), 700)
  y += 4
  text(
    [o.prevDate ? `点線は前回（${fmtShortDate(o.prevDate)}）` : '前回の記録はありません', o.s.tags?.length ? `札: ${o.s.tags.map((t) => SESSION_TAG_LABELS[t]).join('・')}` : ''].filter(Boolean).join('　'),
    26,
    col('ink-2'),
  )
  if (o.s.note) text(`メモ: ${o.s.note}`, 26, col('ink'))
  y += 16

  // 図（横に並べる）
  if (figs.length) {
    const gap = 32
    const fw = figs.length > 1 ? (inner - gap) / 2 : Math.min(inner, 560)
    const fh = Math.max(...figs.map((f) => f.ratio)) * fw
    figs.forEach((f, i) => {
      const x = figs.length > 1 ? pad + i * (fw + gap) : (W - fw) / 2
      const h = f.ratio * fw
      for (const img of f.layers) ctx.drawImage(img, x, y, fw, h)
      ctx.font = `400 24px ${font}`
      ctx.fillStyle = col('ink-2')
      ctx.textAlign = 'center'
      ctx.fillText(PLANE_NAME[f.plane], x + fw / 2, y + h + 32)
      ctx.textAlign = 'left'
    })
    y += fh + 56
  }

  // 値の表
  for (const block of o.rows) {
    text(`${PLANE_NAME[block.plane]}の値`, 30, col('ink'), 700)
    y += 4
    for (const r of block.rows) {
      ctx.strokeStyle = col('line')
      ctx.beginPath()
      ctx.moveTo(pad, y)
      ctx.lineTo(W - pad, y)
      ctx.stroke()
      y += 8
      const top = y
      text(r.m.label, 24, col('ink'), 500, pad, inner * 0.55)
      const leftEnd = y
      y = top
      text(r.value, 24, col('ink'), 500, pad + inner * 0.58, inner * 0.42)
      y = Math.max(leftEnd, y)
      text(`${r.m.direction}・判定の幅 ${r.width}${r.m.status === 'noticeable' ? '・差あり' : ''}`, 21, col('ink-2'))
      if (r.change) text(`前回 ${changeText(r.change)}`, 21, col('ink-3'))
      y += 6
    }
    y += 20
  }

  text('撮影の条件', 30, col('ink'), 700)
  y += 4
  for (const c of [...o.conditions, o.checkin].filter(Boolean)) text(`・${c}`, 22, col('ink-2'))
  y += 16
  text(`良し悪しの判定ではありません。「差あり」は判定の幅を超える差です。${JUDGE_WIDTH_NOTE}医療の診断ではありません。`, 21, col('ink-2'))
  y += 8
  text(`からだ定点 ${APP_VERSION}・計算 v${ALGORITHM_VERSION}・${o.s.modelVersion}`, 18, col('ink-3'))
  y += pad

  const out = document.createElement('canvas')
  out.width = W
  out.height = Math.ceil(y)
  out.getContext('2d')!.drawImage(canvas, 0, 0)
  return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('blob'))), 'image/png'))
}
