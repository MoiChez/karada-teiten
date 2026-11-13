// 動きの 3D 再生（遅延読み込み）。撮った動きの関節の向きを、標準の人体（マネキン）にのせて、時計に合わせて動かす。
// エルゴと自転車では、体の点の動きから決めた器具の形（シートとレール、クランクとサドル）を添える
import { Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { ContactShadows, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { Pose3D } from '../domain/fusion3d'
import type { UserProfile } from '../domain/types'
import { PROFILES, type MotionKind, type MuscleKey } from '../domain/motion'
import { poseAtTime, type MotionEquipment } from '../domain/motionPose'
import { indexAt, type Clock } from '../components/motionClock'
import { mannequinKindOf, muscleShader, paintMuscles, poseMannequin, type MannequinKind } from './mannequin'
import { BODY_COLOR, BodyLights, LoadBoundary, LoadingNote, hasWebGL, mannequinUrl } from './common'
import { HIGHLIGHT_COLOR } from './StandingBody'
import { Notice, cx } from '../components/ui'

// 縦長の枠でも、前に伸ばした腕やしゃがんだ体が入る距離
const VIEWS = {
  side: [-3.0, 0.6, 0],
  oblique: [-2.0, 1.1, 2.1],
  front: [0, 0.6, 3.0],
} as const

const GEAR = '#3d555c'

/** 筋肉ごとの、コマごとの濃さ（0〜1。推定の要求度） */
export interface MuscleLevels {
  ts: number[]
  values: Partial<Record<MuscleKey, number[]>>
}

function MovingBody({
  kind,
  sport,
  poses,
  clock,
  muscles,
  levels,
  floorY,
}: {
  kind: MannequinKind
  sport: MotionKind
  poses: { t: number; pose: Pose3D }[]
  clock: Clock
  muscles: boolean
  levels?: MuscleLevels
  floorY: number
}) {
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
    return r
  }, [gltf])
  const shade = useMemo(() => (levels ? muscleShader(root, BODY_COLOR, HIGHLIGHT_COLOR) : null), [root, levels])
  const shown = useRef('')
  useEffect(() => {
    shown.current = ''
    if (!levels) paintMuscles(root, BODY_COLOR, HIGHLIGHT_COLOR, muscles ? PROFILES[sport].muscles : [])
  }, [root, muscles, sport, levels])
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
    // 推定の要求度の濃さ（止まっていても、出したときに塗る。変わったときだけ塗り直す。0.05 刻み）
    if (levels && shade) {
      const k = indexAt(levels.ts, t)
      const now: Partial<Record<MuscleKey, number>> = {}
      for (const [m, v] of Object.entries(levels.values) as [MuscleKey, number[]][]) now[m] = Math.round((v[k] ?? 0) * 20) / 20
      const key = JSON.stringify(now)
      if (key !== shown.current) {
        shown.current = key
        shade(now)
      }
    }
    if (t === last.current) return
    last.current = t
    const pose = poseAtTime(poses, t)
    if (!pose) return
    poseMannequin(root, pose)
    // 立って行う種目は、いちばん低い足を床（y = 0）に置く。座って行う種目は、足が器具の上で動くのでそのまま
    if (sport === 'squat') {
      let minY = Infinity
      for (const f of feet) minY = Math.min(minY, f.getWorldPosition(tmp).y)
      if (Number.isFinite(minY)) {
        root.position.y -= minY
        root.updateMatrixWorld(true)
      }
    }
  })

  return (
    <>
      <primitive object={root} />
      <gridHelper args={[2.4, 24, '#cfd9d8', '#dfe7e6']} position={[0, floorY, 0]} />
      <ContactShadows position={[0, floorY + 0.002, 0]} opacity={0.4} scale={2.4} blur={2.2} far={1.4} resolution={256} />
    </>
  )
}

/** 器具の形（体の点の動きから決めた目安。器具そのものを検出したものではない） */
function Gear({ eq, poses, clock, hip, ankle }: { eq: MotionEquipment; poses: { t: number; pose: Pose3D }[]; clock: Clock; hip: number; ankle: number }) {
  const seat = useRef<THREE.Mesh>(null)
  const arm = useRef<THREE.Mesh>(null)
  useFrame(() => {
    const pose = poseAtTime(poses, clock.get())
    if (!pose) return
    const h = pose.points[hip]
    if (seat.current && h) seat.current.position.z = h.z
    const a = pose.points[ankle]
    if (arm.current && a && eq.bike) {
      const { y, z, r } = eq.bike.crank
      const ang = Math.atan2(a.y - y, a.z - z)
      arm.current.position.set(0.09, y + (Math.sin(ang) * r) / 2, z + (Math.cos(ang) * r) / 2)
      arm.current.rotation.x = -ang
    }
  })
  if (eq.erg) {
    const { seatY, railFrom, railTo, foot } = eq.erg
    return (
      <group>
        <mesh position={[0, seatY - 0.035, (railFrom + railTo) / 2]}>
          <boxGeometry args={[0.05, 0.03, railTo - railFrom]} />
          <meshStandardMaterial color={GEAR} roughness={0.7} />
        </mesh>
        <mesh ref={seat} position={[0, seatY - 0.008, 0]}>
          <boxGeometry args={[0.22, 0.025, 0.17]} />
          <meshStandardMaterial color={GEAR} roughness={0.7} />
        </mesh>
        <mesh position={[0, foot.y - 0.02, foot.z + 0.05]} rotation={[-Math.PI / 4, 0, 0]}>
          <boxGeometry args={[0.3, 0.02, 0.2]} />
          <meshStandardMaterial color={GEAR} roughness={0.7} />
        </mesh>
        {[railFrom + 0.05, railTo - 0.05].map((z) => (
          <mesh key={z} position={[0, seatY - 0.12, z]}>
            <boxGeometry args={[0.3, 0.14, 0.03]} />
            <meshStandardMaterial color={GEAR} roughness={0.7} />
          </mesh>
        ))}
      </group>
    )
  }
  if (eq.bike) {
    const { crank, saddle, bar } = eq.bike
    return (
      <group>
        <mesh position={[0.09, crank.y, crank.z]} rotation={[0, Math.PI / 2, 0]}>
          <torusGeometry args={[crank.r, 0.006, 8, 48]} />
          <meshStandardMaterial color={GEAR} roughness={0.7} />
        </mesh>
        <mesh ref={arm}>
          <boxGeometry args={[0.015, 0.02, crank.r]} />
          <meshStandardMaterial color={GEAR} roughness={0.7} />
        </mesh>
        <mesh position={[0, saddle.y, saddle.z - 0.02]}>
          <boxGeometry args={[0.13, 0.03, 0.24]} />
          <meshStandardMaterial color={GEAR} roughness={0.7} />
        </mesh>
        {bar && (
          <mesh position={[0, bar.y - 0.02, bar.z]}>
            <boxGeometry args={[0.42, 0.025, 0.025]} />
            <meshStandardMaterial color={GEAR} roughness={0.7} />
          </mesh>
        )}
      </group>
    )
  }
  return null
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
  kind,
  muscles,
  levels,
  equipment,
  nearSide,
  className,
  onCanvas,
}: {
  poses: { t: number; pose: Pose3D }[]
  clock: Clock
  sex?: UserProfile['sex']
  /** 撮った映像で顔が向いていた側。横からの視点を、撮った映像と同じ向きにする */
  facing: 'left' | 'right'
  kind: MotionKind
  /** 種目で一般に主に使われる筋肉の場所を色で示す */
  muscles: boolean
  /** あれば、筋肉の場所をこの濃さ（推定の要求度）で色づける */
  levels?: MuscleLevels
  equipment: MotionEquipment
  nearSide: 'left' | 'right'
  className?: string
  /** 3D を描いている canvas（動画の書き出しで写す） */
  onCanvas?: (c: HTMLCanvasElement) => void
}) {
  const body = mannequinKindOf(sex)
  const [view, setView] = useState<keyof typeof VIEWS>('side')
  const [failed, setFailed] = useState(false)
  const controls = useRef<OrbitControlsImpl | null>(null)
  const webgl = useMemo(hasWebGL, [])
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // 「横」は撮った映像と同じ側から見る（-X 側から見ると体の前 +Z が画面の右になる）
  const pos = view === 'side' && facing === 'left' ? ([3.0, 0.6, 0] as const) : VIEWS[view]
  // 床の高さ: 器具があれば、その下に置く
  const floorY = equipment.erg ? equipment.erg.seatY - 0.19 : equipment.bike ? equipment.bike.crank.y - equipment.bike.crank.r - 0.07 : 0

  if (!webgl) return <Notice tone="info">この端末では 3D を表示できません。</Notice>
  if (failed) return <Notice tone="info">体のモデルを読み込めませんでした。通信できる状態で開き直すと表示されます。</Notice>

  return (
    <div className={cx('relative flex h-full flex-col overflow-hidden rounded-[var(--radius-panel)] bg-surface', className)}>
      <div className="relative min-h-0 flex-1" style={{ touchAction: 'none' }}>
        <Canvas
          camera={{ position: [...pos], fov: 35, near: 0.05, far: 50 }}
          dpr={[1, 2]}
          gl={{ preserveDrawingBuffer: true }}
          onCreated={({ gl }) => onCanvas?.(gl.domElement)}
          aria-label="動きの 3D 再生。ドラッグで回転できます"
        >
          <BodyLights />
          <LoadBoundary onError={() => setFailed(true)}>
            <Suspense fallback={null}>
              <MovingBody kind={body} sport={kind} poses={poses} clock={clock} muscles={muscles} levels={levels} floorY={floorY} />
            </Suspense>
          </LoadBoundary>
          <Gear eq={equipment} poses={poses} clock={clock} hip={nearSide === 'left' ? 23 : 24} ankle={nearSide === 'left' ? 27 : 28} />
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
