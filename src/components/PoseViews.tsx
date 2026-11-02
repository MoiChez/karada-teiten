// 骨格の表示: 写真への重ね描きと、定点グリッド上の図
import { useEffect, useId, useMemo, useState } from 'react'
import type { Landmark, PlaneRecord } from '../domain/types'
import { DISPLAY_POINTS, SKELETON_EDGES } from '../domain/landmarks'
import { figurePose, sideEdges, type FigurePose } from '../domain/figure'
import { correctedSet } from '../domain/session'
import { visibilityOf } from '../domain/metrics'
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
  alt,
  className,
}: {
  record: PlaneRecord
  imageUrl: string | null
  useCorrected?: boolean
  showSkeleton?: boolean
  alt: string
  className?: string
}) {
  const { width, height } = record.imageMetadata
  const lms = useCorrected ? record.landmarksCorrected : record.landmarksRaw
  const corrected = useMemo(() => (useCorrected ? correctedSet(record) : new Set<number>()), [record, useCorrected])
  return (
    <div className={cx('relative overflow-hidden rounded-[var(--radius-panel)] bg-ink', className)} style={{ aspectRatio: `${width} / ${height}` }}>
      {imageUrl ? (
        <img src={imageUrl} alt={alt} className="absolute inset-0 size-full object-cover" />
      ) : (
        <div className="grid-paper absolute inset-0" role="img" aria-label={`${alt}（写真は保存されていないため、骨格のみ表示しています）`} />
      )}
      {showSkeleton && (
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="absolute inset-0 size-full">
          <SkeletonLayer landmarks={lms} width={width} height={height} corrected={corrected} tone={imageUrl ? 'photo' : 'figure'} />
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
