// 骨格の表示: 写真への重ね描きと、定点グリッド上の図
import { useEffect, useId, useMemo, useState } from 'react'
import type { Landmark, PlaneRecord, Point } from '../domain/types'
import { DISPLAY_POINTS, LM, SKELETON_EDGES, sidePoints } from '../domain/landmarks'
import { figurePose, sideEdges, sideFigureTransform, type FigurePose } from '../domain/figure'
import { correctedSet } from '../domain/session'
import { backShapeFor, visibilityOf, type BackShapeView } from '../domain/metrics'
import { MIN_VISIBILITY } from '../domain/constants'
import { data } from '../data/repo'
import { cx } from './ui'

// ---------- 写真 + 骨格 ----------

export function SkeletonLayer({
  landmarks,
  width,
  height,
  corrected,
  showPoints = true,
  tone = 'photo',
  only,
}: {
  landmarks: Landmark[]
  width: number
  height: number
  corrected?: Set<number>
  showPoints?: boolean
  tone?: 'photo' | 'ghost' | 'figure'
  only?: number[]
}) {
  if (landmarks.length < 33) return null
  const scale = Math.max(width, height) / 800
  const ok = (i: number) => (corrected?.has(i) ?? false) || visibilityOf(landmarks[i]) >= MIN_VISIBILITY * 0.6
  const P = (i: number) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height })
  const pointSet = only ?? DISPLAY_POINTS
  const edges = SKELETON_EDGES.filter(([a, b]) => pointSet.includes(a) && pointSet.includes(b) && ok(a) && ok(b))
  return (
    <g aria-hidden>
      {tone === 'photo' &&
        edges.map(([a, b]) => (
          <line key={`h${a}-${b}`} x1={P(a).x} y1={P(a).y} x2={P(b).x} y2={P(b).y} stroke="#10282F" strokeOpacity={0.55} strokeWidth={6 * scale} strokeLinecap="round" />
        ))}
      {edges.map(([a, b]) => (
        <line
          key={`${a}-${b}`}
          x1={P(a).x}
          y1={P(a).y}
          x2={P(b).x}
          y2={P(b).y}
          stroke={tone === 'photo' ? '#FFFFFF' : tone === 'figure' ? '#10282F' : '#7C8D93'}
          strokeWidth={(tone === 'ghost' ? 2 : 2.5) * scale}
          strokeDasharray={tone === 'ghost' ? `${6 * scale} ${5 * scale}` : undefined}
          strokeLinecap="round"
        />
      ))}
      {showPoints &&
        pointSet.filter(ok).map((i) => {
          const p = P(i)
          const isCorr = corrected?.has(i)
          const r = (isCorr ? 6 : 5) * scale
          return isCorr ? (
            <rect key={i} x={p.x - r} y={p.y - r} width={r * 2} height={r * 2} fill="#CDE14B" stroke="#10282F" strokeWidth={2 * scale} />
          ) : (
            <circle key={i} cx={p.x} cy={p.y} r={r} fill={tone === 'ghost' ? '#FFFFFF' : '#CDE14B'} stroke="#10282F" strokeWidth={2 * scale} />
          )
        })}
    </g>
  )
}

/**
 * 写真の上の基準線。正面: 足首の中点を通る鉛直線と、肩・股関節の中点を通る水平線。
 * 側面: カメラ側の足首を通る鉛直線。線と骨格のずれで、傾きや左右差が見て分かる
 */
export function GuideLines({ record, landmarks, width, height }: { record: PlaneRecord; landmarks: Landmark[]; width: number; height: number }) {
  if (landmarks.length < 33) return null
  const corrected = correctedSet(record)
  const ok = (i: number) => corrected.has(i) || visibilityOf(landmarks[i]) >= MIN_VISIBILITY
  const P = (i: number) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height })
  const lines: { x1: number; y1: number; x2: number; y2: number; key: string }[] = []
  if (record.plane === 'front') {
    if (ok(LM.leftAnkle) && ok(LM.rightAnkle)) {
      const x = (P(LM.leftAnkle).x + P(LM.rightAnkle).x) / 2
      lines.push({ key: 'v', x1: x, y1: 0, x2: x, y2: height })
    }
    if (ok(LM.leftShoulder) && ok(LM.rightShoulder)) {
      const y = (P(LM.leftShoulder).y + P(LM.rightShoulder).y) / 2
      lines.push({ key: 'sh', x1: 0, y1: y, x2: width, y2: y })
    }
    if (ok(LM.leftHip) && ok(LM.rightHip)) {
      const y = (P(LM.leftHip).y + P(LM.rightHip).y) / 2
      lines.push({ key: 'hp', x1: 0, y1: y, x2: width, y2: y })
    }
  } else {
    const ankle = sidePoints(record.imageMetadata.nearSide ?? 'left').ankle
    if (ok(ankle)) {
      const x = P(ankle).x
      lines.push({ key: 'v', x1: x, y1: 0, x2: x, y2: height })
    }
  }
  return (
    <g aria-hidden>
      {lines.map((l) => (
        <line key={`h${l.key}`} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#10282F" strokeOpacity={0.4} strokeWidth={3.5} vectorEffect="non-scaling-stroke" />
      ))}
      {lines.map((l) => (
        <line key={l.key} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#A8DDEE" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      ))}
    </g>
  )
}

/**
 * 背中側の輪郭と、丸み・すき間を測った線。map で座標を移す（写真ならそのまま、方眼なら図の座標へ）。
 * 輪郭は服や髪を含む外形。線の太さは表示の大きさによらず画面上で一定
 */
function BackShapeLines({ view, map, tone }: { view: BackShapeView; map: (p: Point) => Point; tone: 'photo' | 'figure' | 'past' }) {
  const line = view.contour.map(map)
  const d = line.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const main = tone === 'photo' ? '#F4B183' : tone === 'figure' ? 'var(--color-measure)' : 'var(--color-past)'
  const sub = tone === 'photo' ? '#A8DDEE' : 'var(--color-measure)'
  const seg = (a: Point, b: Point, key: string, dashed: boolean) => {
    const p = map(a)
    const q = map(b)
    return (
      <g key={key}>
        {tone === 'photo' && (
          <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="#10282F" strokeOpacity={0.45} strokeWidth={3.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        )}
        <line
          x1={p.x}
          y1={p.y}
          x2={q.x}
          y2={q.y}
          stroke={sub}
          strokeWidth={dashed ? 1.25 : 2}
          strokeDasharray={dashed ? '4 3' : undefined}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </g>
    )
  }
  return (
    <g aria-hidden>
      {tone === 'photo' && <path d={d} fill="none" stroke="#10282F" strokeOpacity={0.45} strokeWidth={4.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
      <path
        d={d}
        fill="none"
        stroke={main}
        strokeWidth={tone === 'past' ? 1.5 : 2.25}
        strokeDasharray={tone === 'past' ? '5 4' : undefined}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {tone !== 'past' && view.upper && [seg(view.upper.top, view.upper.bottom, 'uc', true), seg(view.upper.apex, view.upper.foot, 'ud', false)]}
      {tone !== 'past' && view.lower && [seg(view.lower.upperTouch, view.lower.lowerTouch, 'lc', true), seg(view.lower.deepest, view.lower.foot, 'ld', false)]}
    </g>
  )
}

/** 保存済み画像の URL を読み込む（なければ null） */
export function useStoredImageUrl(imageId: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!imageId) {
      setUrl(null)
      return
    }
    let revoked = false
    let u: string | null = null
    data.getImage(imageId).then((img) => {
      if (revoked || !img) return
      u = URL.createObjectURL(img.blob)
      setUrl(u)
    })
    return () => {
      revoked = true
      if (u) URL.revokeObjectURL(u)
    }
  }, [imageId])
  return url
}

export function PhotoWithPose({
  record,
  imageUrl,
  useCorrected = true,
  showSkeleton = true,
  showGuides = showSkeleton,
  alt,
  className,
}: {
  record: PlaneRecord
  imageUrl: string | null
  useCorrected?: boolean
  showSkeleton?: boolean
  /** 基準線（鉛直線・肩と股関節の水平線）を重ねる */
  showGuides?: boolean
  alt: string
  className?: string
}) {
  const { width, height } = record.imageMetadata
  const lms = useCorrected ? record.landmarksCorrected : record.landmarksRaw
  const corrected = useMemo(() => (useCorrected ? correctedSet(record) : new Set<number>()), [record, useCorrected])
  const back = useMemo(() => backShapeFor(record, useCorrected), [record, useCorrected])
  return (
    <div className={cx('relative overflow-hidden rounded-[var(--radius-panel)] bg-ink', className)} style={{ aspectRatio: `${width} / ${height}` }}>
      {imageUrl ? (
        <img src={imageUrl} alt={alt} className="absolute inset-0 size-full object-cover" />
      ) : (
        <div className="grid-paper absolute inset-0" role="img" aria-label={`${alt}（写真は保存されていないため、骨格のみ表示しています）`} />
      )}
      {(showSkeleton || showGuides) && (
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="absolute inset-0 size-full">
          {showGuides && <GuideLines record={record} landmarks={lms} width={width} height={height} />}
          {showGuides && back && <BackShapeLines view={back} map={(p) => p} tone={imageUrl ? 'photo' : 'figure'} />}
          {showSkeleton && <SkeletonLayer landmarks={lms} width={width} height={height} corrected={corrected} tone={imageUrl ? 'photo' : 'figure'} />}
        </svg>
      )}
    </div>
  )
}

// ---------- 定点グリッド ----------

function figureEdges(f: FigurePose, nearSide: 'left' | 'right' | undefined): [number, number][] {
  return f.plane === 'front' ? SKELETON_EDGES : sideEdges(nearSide ?? 'left')
}

/**
 * 体の高さで大きさをそろえた骨格を、方眼と下げ振り線の上に描く。
 * past を渡すと、前回を灰色の破線で重ねる
 */
export function PostureGrid({
  current,
  past,
  useCorrected = true,
  label,
  className,
  compact,
  hideCaption,
}: {
  current?: PlaneRecord
  past?: PlaneRecord
  useCorrected?: boolean
  label: string
  className?: string
  compact?: boolean
  hideCaption?: boolean
}) {
  const uid = useId().replace(/:/g, '')
  const cur = figurePose(current, useCorrected)
  const prev = figurePose(past, useCorrected)
  // 側面: 背中の輪郭（今回は測った線も、前回は輪郭だけ）
  const backs = useMemo(() => {
    const one = (rec: PlaneRecord | undefined) => {
      const view = rec ? backShapeFor(rec, useCorrected) : null
      const t = sideFigureTransform(rec, useCorrected)
      return view && t ? { view, t } : null
    }
    return { cur: one(current), prev: one(past) }
  }, [current, past, useCorrected])
  const plane = current?.plane ?? past?.plane ?? 'front'
  // 表示範囲（体の高さ = 1）
  const xMin = plane === 'front' ? -0.42 : -0.3
  const xMax = plane === 'front' ? 0.42 : 0.42
  const yMin = -0.08
  const yMax = 1.12
  const W = 300
  const scale = W / (xMax - xMin)
  const Hpx = (yMax - yMin) * scale
  const X = (x: number) => (x - xMin) * scale
  const Y = (y: number) => (yMax - y) * scale
  const step = 0.05 * scale

  const draw = (f: FigurePose, rec: PlaneRecord, tone: 'current' | 'past') => {
    const edges = figureEdges(f, rec.imageMetadata.nearSide)
    const corr = correctedSet(rec)
    const pts = f.plane === 'front' ? DISPLAY_POINTS : f.visible
    return (
      <g>
        {edges.map(([a, b]) => {
          const p = f.points[a]
          const q = f.points[b]
          if (!p || !q) return null
          return (
            <line
              key={`${a}-${b}`}
              x1={X(p.x)}
              y1={Y(p.y)}
              x2={X(q.x)}
              y2={Y(q.y)}
              stroke={tone === 'current' ? 'var(--color-ink)' : 'var(--color-past)'}
              strokeWidth={tone === 'current' ? 2.5 : 2}
              strokeDasharray={tone === 'past' ? '5 4' : undefined}
              strokeLinecap="round"
            />
          )
        })}
        {pts.map((i) => {
          const p = f.points[i]
          if (!p) return null
          if (tone === 'past') return <circle key={i} cx={X(p.x)} cy={Y(p.y)} r={2.5} fill="var(--color-past)" />
          return corr.has(i) && useCorrected ? (
            <rect key={i} x={X(p.x) - 4.5} y={Y(p.y) - 4.5} width={9} height={9} fill="var(--color-level)" stroke="var(--color-ink)" strokeWidth={1.5} />
          ) : (
            <circle key={i} cx={X(p.x)} cy={Y(p.y)} r={4} fill="var(--color-level)" stroke="var(--color-ink)" strokeWidth={1.5} />
          )
        })}
      </g>
    )
  }

  return (
    <figure className={cx('relative mx-auto w-full', className)} style={{ maxWidth: ((compact ? 260 : 440) * W) / Hpx }}>
      <svg
        viewBox={`0 0 ${W} ${Hpx}`}
        role="img"
        aria-label={label}
        className="block w-full rounded-[var(--radius-panel)] bg-surface"
      >
        <defs>
          <pattern id={`grid-${uid}`} width={step} height={step} patternUnits="userSpaceOnUse" x={X(0) % step} y={Y(0) % step}>
            <path d={`M ${step} 0 L 0 0 0 ${step}`} fill="none" stroke="var(--color-grid)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={W} height={Hpx} fill={`url(#grid-${uid})`} />
        {/* 床 */}
        <line x1={0} x2={W} y1={Y(-0.03)} y2={Y(-0.03)} stroke="var(--color-line)" strokeWidth={2} />
        {/* 下げ振り線（足首の中点を通る鉛直線） */}
        <line x1={X(0)} x2={X(0)} y1={Y(yMax)} y2={Y(-0.03)} stroke="var(--color-measure)" strokeWidth={1.25} strokeDasharray="2 3" />
        <path d={`M ${X(0) - 5} ${Y(-0.01)} h 10 l -5 8 z`} fill="var(--color-measure)" opacity={0.8} />
        {/* 肩・股関節の中点を通る水平線（正面の今回の姿勢） */}
        {cur && cur.plane === 'front' &&
          ([
            [LM.leftShoulder, LM.rightShoulder],
            [LM.leftHip, LM.rightHip],
          ] as const).map(([a, b]) => {
            const p = cur.points[a]
            const q = cur.points[b]
            if (!p || !q) return null
            const y = Y((p.y + q.y) / 2)
            return <line key={a} x1={0} x2={W} y1={y} y2={y} stroke="var(--color-measure)" strokeOpacity={0.6} strokeWidth={1} strokeDasharray="2 3" />
          })}
        {backs.prev && <BackShapeLines view={backs.prev.view} map={(p) => { const q = backs.prev!.t(p); return { x: X(q.x), y: Y(q.y) } }} tone="past" />}
        {backs.cur && <BackShapeLines view={backs.cur.view} map={(p) => { const q = backs.cur!.t(p); return { x: X(q.x), y: Y(q.y) } }} tone="figure" />}
        {prev && past && draw(prev, past, 'past')}
        {cur && current && draw(cur, current, 'current')}
        {!cur && !prev && (
          <text x={W / 2} y={Hpx / 2} textAnchor="middle" fill="var(--color-ink-3)" fontSize="13">
            骨格を表示できません
          </text>
        )}
      </svg>
      {plane === 'side' && !hideCaption && (
        <figcaption className="pointer-events-none absolute top-2 right-3 text-xs text-ink-3">前 →</figcaption>
      )}
      {plane === 'front' && !hideCaption && (
        <figcaption className="pointer-events-none absolute top-2 right-3 left-3 flex justify-between text-xs text-ink-3">
          <span>右</span>
          <span>左</span>
        </figcaption>
      )}
    </figure>
  )
}
