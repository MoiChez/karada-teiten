// 動きの 3D 再生（遅延読み込み）。撮った動きの関節の向きを、標準の人体（マネキン）にのせて、時計に合わせて動かす
import { Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { ContactShadows, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { Pose3D } from '../domain/fusion3d'
import type { UserProfile } from '../domain/types'
import { poseAtTime } from '../domain/motionPose'
import type { Clock } from '../components/motionClock'
import { mannequinKindOf, paintMannequin, poseMannequin, type MannequinKind } from './mannequin'
import { BODY_COLOR, BodyLights, LoadBoundary, LoadingNote, hasWebGL, mannequinUrl } from './common'
import { Notice, cx } from '../components/ui'

// 縦長の枠でも、前に伸ばした腕やしゃがんだ体が入る距離
const VIEWS = {
  side: [-3.0, 0.6, 0],
  oblique: [-2.0, 1.1, 2.1],
  front: [0, 0.6, 3.0],
} as const

function MovingBody({ kind, poses, clock }: { kind: MannequinKind; poses: { t: number; pose: Pose3D }[]; clock: Clock }) {
  const gltf = useLoader(GLTFLoader, mannequinUrl(kind))
  const root = useMemo(() => {
    const r = cloneSkinned(gltf.scene)
    r.traverse((o) => {
      const m = o as THREE.SkinnedMesh
      if (!m.isSkinnedMesh) return
      m.frustumCulled = false
      m.geometry = m.geometry.clone()
      m.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 })
    })
    paintMannequin(r, BODY_COLOR, BODY_COLOR, new Set())
    return r
  }, [gltf])
  const feet = useMemo(() => {
    const out: THREE.Object3D[] = []
    root.traverse((o) => {
      if (['lm_29', 'lm_30', 'lm_31', 'lm_32'].includes(o.name)) out.push(o)
    })
    return out
  }, [root])
  const tmp = useMemo(() => new THREE.Vector3(), [])
  const last = useRef(NaN)

  useFrame(() => {
    const t = clock.get()
    if (t === last.current) return
    last.current = t
    const pose = poseAtTime(poses, t)
    if (!pose) return
    poseMannequin(root, pose)
    // いちばん低い足を床（y = 0）に置く
    let minY = Infinity
    for (const f of feet) minY = Math.min(minY, f.getWorldPosition(tmp).y)
    if (Number.isFinite(minY)) {
      root.position.y -= minY
      root.updateMatrixWorld(true)
    }
  })

  return (
    <>
      <primitive object={root} />
      <gridHelper args={[2, 20, '#cfd9d8', '#dfe7e6']} />
      <ContactShadows position={[0, 0.002, 0]} opacity={0.4} scale={2} blur={2.2} far={1.2} resolution={256} />
    </>
  )
}

function ViewSetter({ view, pos, controls }: { view: string; pos: readonly [number, number, number]; controls: RefObject<OrbitControlsImpl | null> }) {
  const { camera } = useThree()
  const last = useRef('')
  useEffect(() => {
    if (last.current === view) return
    last.current = view
    const [x, y, z] = pos
    camera.position.set(x, y, z)
    camera.lookAt(0, 0.45, 0)
    controls.current?.target.set(0, 0.45, 0)
    controls.current?.update()
  }, [view, pos, camera, controls])
  return null
}

export default function MotionBody3D({
  poses,
  clock,
  sex,
  facing,
  className,
}: {
  poses: { t: number; pose: Pose3D }[]
  clock: Clock
  sex?: UserProfile['sex']
  /** 撮った映像で顔が向いていた側。横からの視点を、撮った映像と同じ向きにする */
  facing: 'left' | 'right'
  className?: string
}) {
  const kind = mannequinKindOf(sex)
  const [view, setView] = useState<keyof typeof VIEWS>('side')
  const [failed, setFailed] = useState(false)
  const controls = useRef<OrbitControlsImpl | null>(null)
  const webgl = useMemo(hasWebGL, [])
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // 「横」は撮った映像と同じ側から見る（-X 側から見ると体の前 +Z が画面の右になる）
  const pos = view === 'side' && facing === 'left' ? ([3.0, 0.6, 0] as const) : VIEWS[view]

  if (!webgl) return <Notice tone="info">この端末では 3D を表示できません。</Notice>
  if (failed) return <Notice tone="info">体のモデルを読み込めませんでした。通信できる状態で開き直すと表示されます。</Notice>

  return (
    <div className={cx('relative flex h-full flex-col overflow-hidden rounded-[var(--radius-panel)] bg-surface', className)}>
      <div className="relative min-h-0 flex-1" style={{ touchAction: 'none' }}>
        <Canvas camera={{ position: [...pos], fov: 35, near: 0.05, far: 50 }} dpr={[1, 2]} aria-label="動きの 3D 再生。ドラッグで回転できます">
          <BodyLights />
          <LoadBoundary onError={() => setFailed(true)}>
            <Suspense fallback={null}>
              <MovingBody kind={kind} poses={poses} clock={clock} />
            </Suspense>
          </LoadBoundary>
          <OrbitControls ref={controls} makeDefault target={[0, 0.45, 0]} enableDamping={!reduced} minDistance={0.8} maxDistance={8} />
          <ViewSetter view={view} pos={pos} controls={controls} />
        </Canvas>
        <LoadingNote />
      </div>
      <div className="grid grid-cols-3 gap-1 p-1.5" role="group" aria-label="3D の視点">
        {(
          [
            ['side', '横'],
            ['oblique', '斜め'],
            ['front', '正面'],
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
