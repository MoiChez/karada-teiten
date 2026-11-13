// 結果の画面に置く、立ち姿勢の 3D（遅延読み込み）。指で回せる。前回との重ね表示や骨格の表示は 3D ビューで行う
import { Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { ContactShadows, Line, OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { AssessmentSession, BodyArea, UserProfile } from '../domain/types'
import { fuse3D } from '../domain/fusion3d'
import { mannequinKindOf } from './mannequin'
import { BodyLights, LoadBoundary, LoadingNote, hasWebGL } from './common'
import { BodyModel, HIGHLIGHT_COLOR } from './StandingBody'
import { Notice, cx } from '../components/ui'

const VIEWS = {
  oblique: [1.5, 1.1, 1.7],
  front: [0, 0.55, 2.3],
  side: [-2.3, 0.55, 0],
} as const

function ViewSetter({ view, controls }: { view: keyof typeof VIEWS; controls: RefObject<OrbitControlsImpl | null> }) {
  const { camera } = useThree()
  const last = useRef('')
  useEffect(() => {
    if (last.current === view) return
    last.current = view
    const [x, y, z] = VIEWS[view]
    camera.position.set(x, y, z)
    camera.lookAt(0, 0.5, 0)
    controls.current?.target.set(0, 0.5, 0)
    controls.current?.update()
  }, [view, camera, controls])
  return null
}

export default function StandingPreview({ session, sex }: { session: AssessmentSession; sex?: UserProfile['sex'] }) {
  const pose = useMemo(() => fuse3D(session.front, session.side), [session])
  const [view, setView] = useState<keyof typeof VIEWS>('oblique')
  const [failed, setFailed] = useState(false)
  const controls = useRef<OrbitControlsImpl | null>(null)
  const webgl = useMemo(hasWebGL, [])
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // 差の大きい特徴 2 つの主な部位だけを色で示す（3D ビューと同じ）
  const traits = useMemo(
    () => session.postureTraits.filter((t) => t.status === 'noticeable').sort((a, b) => b.magnitude - a.magnitude).slice(0, 2),
    [session],
  )
  const highlight = useMemo(() => new Set<BodyArea>(traits.flatMap((t) => t.relatedAreas.slice(0, 2)).filter((a) => a !== 'whole_body')), [traits])
  if (!pose) return null
  if (!webgl) return <Notice tone="info">この端末では 3D を表示できません。</Notice>
  if (failed) return <Notice tone="info">体のモデルを読み込めませんでした。通信できる状態で開き直すと表示されます。</Notice>
  const floorY = Math.min(...[29, 30, 31, 32].map((i) => pose.points[i]?.y ?? 0)) - 0.01
  const kind = mannequinKindOf(sex)

  return (
    <div className="overflow-hidden rounded-[var(--radius-panel)] bg-surface shadow-lift">
      <div className="relative h-[min(46dvh,360px)]" style={{ touchAction: 'none' }}>
        <Canvas camera={{ position: [...VIEWS.oblique], fov: 35, near: 0.05, far: 50 }} dpr={[1, 2]} aria-label="立ち姿勢の 3D。ドラッグで回転、ピンチで拡大縮小できます">
          <BodyLights />
          <gridHelper args={[2, 20, '#cfd9d8', '#dfe7e6']} position={[0, floorY, 0]} />
          <Line points={[[0, floorY, 0], [0, 1.15, 0]]} color="#1c6e8c" lineWidth={1.5} dashed dashSize={0.03} gapSize={0.02} />
          <LoadBoundary onError={() => setFailed(true)}>
            <Suspense fallback={null}>
              <BodyModel kind={kind} pose={pose} highlight={highlight} tone="current" />
              <ContactShadows position={[0, floorY + 0.002, 0]} opacity={0.4} scale={2} blur={2.2} far={1.2} resolution={256} />
            </Suspense>
          </LoadBoundary>
          <OrbitControls ref={controls} makeDefault target={[0, 0.5, 0]} enableDamping={!reduced} minDistance={0.8} maxDistance={6} />
          <ViewSetter view={view} controls={controls} />
        </Canvas>
        <LoadingNote />
        {highlight.size > 0 && (
          <span className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 rounded-full bg-paper/90 px-2.5 py-0.5 text-sm text-ink-2">
            <span aria-hidden className="size-2.5 rounded-full" style={{ background: HIGHLIGHT_COLOR }} />
            関連が考えられる部位（参考）
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-1 p-1.5" role="group" aria-label="3D の視点">
        {(
          [
            ['oblique', '斜め'],
            ['front', '正面'],
            ['side', '横'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            aria-pressed={view === k}
            onClick={() => setView(k)}
            className={cx('min-h-10 rounded-[var(--radius-control)] border text-sm', view === k ? 'border-ink bg-ink text-paper' : 'border-line bg-surface hover:bg-sunken')}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
