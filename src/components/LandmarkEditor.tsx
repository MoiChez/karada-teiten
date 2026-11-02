// ランドマーク手動補正エディタ（docs/07 の 1 章）
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, RotateCcw, ScanSearch, Undo2 } from 'lucide-react'
import type { PlaneRecord, Point } from '../domain/types'
import { CORRECTABLE, LEFT_SIDE_CORRECTABLE, RIGHT_SIDE_CORRECTABLE, landmarkName } from '../domain/landmarks'
import { correctedSet } from '../domain/session'
import { visibilityOf } from '../domain/metrics'
import { SkeletonLayer } from './PoseViews'
import { Badge, Button, cx } from './ui'

const DRAG_THRESHOLD_PX = 4
const LOUPE = 128
const LOUPE_ZOOM = 2.5

export function LandmarkEditor({
  record,
  imageUrl,
  onMove,
  onReset,
  onRedetect,
  redetecting,
}: {
  record: PlaneRecord
  imageUrl: string
  onMove: (index: number, to: Point, opts: { snap: boolean }) => void
  onReset: (index?: number) => void
  onRedetect?: () => void
  redetecting?: boolean
}) {
  const { width, height } = record.imageMetadata
  const svgRef = useRef<SVGSVGElement>(null)
  const [zoom, setZoom] = useState<1 | 2 | 3>(1)
  const [showFar, setShowFar] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [drag, setDrag] = useState<{ index: number; start: Point; pos: Point; active: boolean; client: Point; pointerId: number } | null>(null)

  const corrected = useMemo(() => correctedSet(record), [record])
  const editable = useMemo(() => {
    if (record.plane === 'front' || showFar) return CORRECTABLE
    return record.imageMetadata.nearSide === 'right' ? RIGHT_SIDE_CORRECTABLE : LEFT_SIDE_CORRECTABLE
  }, [record, showFar])

  const lms = record.landmarksCorrected
  const pos = (i: number): Point => (drag && drag.index === i ? drag.pos : { x: lms[i].x, y: lms[i].y })
  const shown = useMemo(() => lms.map((l, i) => (drag && drag.index === i ? { ...l, ...drag.pos } : l)), [lms, drag])

  const toNorm = (clientX: number, clientY: number): Point => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height }
  }

  const onPointerDown = (i: number) => (e: RPointerEvent<SVGElement>) => {
    e.preventDefault()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    setSelected(i)
    setDrag({ index: i, start: { x: e.clientX, y: e.clientY }, pos: { x: lms[i].x, y: lms[i].y }, active: false, client: { x: e.clientX, y: e.clientY }, pointerId: e.pointerId })
  }
  const onPointerMove = (e: RPointerEvent<SVGElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return
    const moved = Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y)
    if (!drag.active && moved < DRAG_THRESHOLD_PX) return
    const n = toNorm(e.clientX, e.clientY)
    setDrag({ ...drag, active: true, pos: { x: clamp01(n.x), y: clamp01(n.y) }, client: { x: e.clientX, y: e.clientY } })
  }
  const onPointerUp = (e: RPointerEvent<SVGElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return
    if (drag.active) onMove(drag.index, drag.pos, { snap: true })
    setDrag(null)
  }

  const nudge = (i: number, dx: number, dy: number) => {
    const p = { x: lms[i].x, y: lms[i].y }
    onMove(i, { x: clamp01(p.x + dx / width), y: clamp01(p.y + dy / height) }, { snap: false })
  }
  const onKey = (i: number) => (e: KeyboardEvent<SVGElement>) => {
    const step = e.shiftKey ? 10 : 1
    const map: Record<string, [number, number]> = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] }
    const d = map[e.key]
    if (d) {
      e.preventDefault()
      setSelected(i)
      nudge(i, d[0], d[1])
    }
  }

  const scale = Math.max(width, height) / 800
  const hit = 24 * scale / zoom
  const loupe = drag?.active ? loupeStyle(drag.client, drag.pos, svgRef.current, imageUrl) : null

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="拡大表示" className="inline-flex rounded-[var(--radius-control)] border border-line bg-surface p-1">
          {([1, 2, 3] as const).map((z) => (
            <button
              key={z}
              type="button"
              aria-pressed={zoom === z}
              onClick={() => setZoom(z)}
              className={cx('min-h-10 min-w-12 rounded-[9px] px-2 text-[15px] num', zoom === z ? 'bg-ink text-paper font-medium' : 'text-ink hover:bg-sunken')}
            >
              {z}×
            </button>
          ))}
        </div>
        {record.plane === 'side' && (
          <label className="flex min-h-11 items-center gap-2 text-[15px]">
            <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={showFar} onChange={(e) => setShowFar(e.target.checked)} />
            奥側の点も表示
          </label>
        )}
      </div>

      <div
        className={cx('relative mx-auto overflow-auto rounded-[var(--radius-panel)] bg-ink', zoom > 1 && 'max-h-[70dvh]')}
        style={{ width: `min(100%, calc(70dvh * ${width / height}))`, touchAction: 'pan-x pan-y' }}
      >
        <div className="relative" style={{ width: `${zoom * 100}%`, aspectRatio: `${width} / ${height}` }}>
          <img src={imageUrl} alt={`${record.plane === 'front' ? '正面' : '側面'}の写真`} className="absolute inset-0 size-full select-none" draggable={false} />
          <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="absolute inset-0 size-full"
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => setDrag(null)}
          >
            <SkeletonLayer landmarks={shown} width={width} height={height} corrected={corrected} showPoints={false} />
            {/* ドラッグ中は元の検出位置を輪で示す（ここに戻すと吸着） */}
            {drag?.active && (
              <circle cx={record.landmarksRaw[drag.index].x * width} cy={record.landmarksRaw[drag.index].y * height} r={9 * scale / zoom} fill="none" stroke="#FFFFFF" strokeWidth={2 * scale / zoom} strokeDasharray={`${3 * scale} ${3 * scale}`} />
            )}
            {editable.map((i) => {
              const p = pos(i)
              const isCorr = corrected.has(i)
              const isSel = selected === i
              const low = !isCorr && visibilityOf(lms[i]) < 0.5
              const r = (isSel ? 8 : 6.5) * scale / zoom
              return (
                <g
                  key={i}
                  role="button"
                  tabIndex={0}
                  aria-label={`${landmarkName(i)}${isCorr ? '（補正済み）' : ''}${low ? '（検出の信頼度が低い）' : ''}。矢印キーで移動`}
                  aria-pressed={isSel}
                  onPointerDown={onPointerDown(i)}
                  onKeyDown={onKey(i)}
                  onFocus={() => setSelected(i)}
                  style={{ touchAction: 'none', cursor: 'grab' }}
                >
                  <circle cx={p.x * width} cy={p.y * height} r={hit} fill="transparent" />
                  {isCorr ? (
                    <rect x={p.x * width - r} y={p.y * height - r} width={r * 2} height={r * 2} fill="#CDE14B" stroke={isSel ? '#FFFFFF' : '#10282F'} strokeWidth={(isSel ? 3 : 2) * scale / zoom} />
                  ) : (
                    <circle cx={p.x * width} cy={p.y * height} r={r} fill={low ? '#FBF0E3' : '#CDE14B'} stroke={isSel ? '#FFFFFF' : '#10282F'} strokeWidth={(isSel ? 3 : 2) * scale / zoom} />
                  )}
                </g>
              )
            })}
          </svg>
        </div>
      </div>

      {loupe && (
        <div aria-hidden className="pointer-events-none fixed z-50 overflow-hidden rounded-full border-2 border-paper shadow-lift" style={loupe}>
          <svg viewBox={`0 0 ${LOUPE} ${LOUPE}`} className="absolute inset-0 size-full">
            <line x1={LOUPE / 2} y1={8} x2={LOUPE / 2} y2={LOUPE - 8} stroke="#CDE14B" strokeWidth={1.5} />
            <line x1={8} y1={LOUPE / 2} x2={LOUPE - 8} y2={LOUPE / 2} stroke="#CDE14B" strokeWidth={1.5} />
            <circle cx={LOUPE / 2} cy={LOUPE / 2} r={4} fill="none" stroke="#10282F" strokeWidth={1.5} />
          </svg>
        </div>
      )}

      {/* 選択中の点の操作（ドラッグの代わりにボタンでも動かせる） */}
      <div className="mt-4 rounded-[var(--radius-panel)] bg-surface p-3 shadow-lift">
        {selected === null ? (
          <p className="text-[15px] text-ink-2">点をタップして選ぶと、ボタンで 1 画素ずつ動かせます。ドラッグでも動かせます。</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-bold">{landmarkName(selected)}</p>
              <p className="text-sm text-ink-3">{corrected.has(selected) ? '補正済み' : '検出したままの位置'}</p>
            </div>
            <div className="grid grid-cols-3 gap-1" role="group" aria-label={`${landmarkName(selected)}を動かす`}>
              <span />
              <NudgeBtn label="上へ" onClick={() => nudge(selected, 0, -1)}><ArrowUp className="size-5" aria-hidden /></NudgeBtn>
              <span />
              <NudgeBtn label="左へ" onClick={() => nudge(selected, -1, 0)}><ArrowLeft className="size-5" aria-hidden /></NudgeBtn>
              <NudgeBtn label="下へ" onClick={() => nudge(selected, 0, 1)}><ArrowDown className="size-5" aria-hidden /></NudgeBtn>
              <NudgeBtn label="右へ" onClick={() => nudge(selected, 1, 0)}><ArrowRight className="size-5" aria-hidden /></NudgeBtn>
            </div>
            <Button size="sm" variant="quiet" icon={<Undo2 aria-hidden className="size-4" />} disabled={!corrected.has(selected)} onClick={() => onReset(selected)}>
              この点を戻す
            </Button>
          </div>
        )}
      </div>

      <ul className="mt-4 grid grid-cols-2 gap-x-3 gap-y-1 text-[15px]" aria-label="補正対象の点">
        {editable.map((i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => setSelected(i)}
              className={cx('flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-sunken', selected === i && 'bg-sunken')}
            >
              {corrected.has(i) ? (
                <span aria-hidden className="size-3 border-[1.5px] border-ink bg-level" />
              ) : (
                <span aria-hidden className="size-3 rounded-full border-[1.5px] border-ink bg-level" />
              )}
              <span className="flex-1">{landmarkName(i)}</span>
              {corrected.has(i) && <Badge tone="level">補正済み</Badge>}
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={<RotateCcw aria-hidden className="size-4" />} disabled={corrected.size === 0} onClick={() => onReset()}>
          すべて元に戻す
        </Button>
        {onRedetect && (
          <Button size="sm" variant="secondary" icon={<ScanSearch aria-hidden className="size-4" />} loading={redetecting} onClick={onRedetect}>
            高精度モデルで再検出
          </Button>
        )}
      </div>
      <p className="mt-2 text-sm text-ink-3">ドラッグで元の位置の近くに戻すと、元の位置に吸着します（ボタンや矢印キーでの微調整は吸着しません）。四角の点が補正済みです。</p>
    </div>
  )
}

function NudgeBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="inline-flex size-11 items-center justify-center rounded-[10px] border border-line bg-paper hover:bg-sunken active:bg-sunken">
      {children}
    </button>
  )
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v))
}

function loupeStyle(client: Point, pos: Point, svg: SVGSVGElement | null, imageUrl: string): CSSProperties | null {
  if (!svg) return null
  const r = svg.getBoundingClientRect()
  const bw = r.width * LOUPE_ZOOM
  const bh = r.height * LOUPE_ZOOM
  const top = client.y < LOUPE + 60 ? client.y + 48 : client.y - LOUPE - 48
  return {
    width: LOUPE,
    height: LOUPE,
    left: Math.max(4, Math.min(window.innerWidth - LOUPE - 4, client.x - LOUPE / 2)),
    top,
    backgroundImage: `url(${imageUrl})`,
    backgroundSize: `${bw}px ${bh}px`,
    backgroundPosition: `${-(pos.x * bw - LOUPE / 2)}px ${-(pos.y * bh - LOUPE / 2)}px`,
    backgroundRepeat: 'no-repeat',
    backgroundColor: '#10282F',
  }
}
