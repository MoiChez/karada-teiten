// 動きの 3D 再生（遅延読み込み）。撮った動きの関節の向きを、標準の人体（マネキン）にのせて、時計に合わせて動かす。
// エルゴと自転車では、体の点の動きから決めた器具の形（シートとレール、クランクとサドル）を添える
import { Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { ContactShadows, GizmoHelper, GizmoViewport, Grid, OrbitControls } from '@react-three/drei'
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
import { BODY_COLOR, BodyLights, LoadBoundary, LoadingNote, MUSCLE_SKIN, hasWebGL, loadBodySkin, mannequinUrl, saveBodySkin, type BodySkin } from './common'
import { HIGHLIGHT_COLOR } from './StandingBody'
import { Notice, cx } from '../components/ui'

// 縦長の枠でも、前に伸ばした腕やしゃがんだ体が入る距離
const VIEWS = {
  side: [-3.0, 0.6, 0],
  oblique: [-2.0, 1.1, 2.1],
  front: [0, 0.6, 3.0],
  back: [0, 0.6, -3.0],
  // 真上から（カメラの上の向きが決まるように、少しだけ後ろへずらす）
  top: [0, 3.6, -0.01],
} as const
type ViewKey = keyof typeof VIEWS
const VIEW_LABELS: Record<ViewKey, string> = { side: '横', oblique: '斜め', front: '正面', back: '後ろ', top: '上' }

/** 3D の舞台の色（動画の枠と同じ濃い色。体と器具が明るく浮かぶように） */
const STAGE = '#10282f'
const GEAR = '#7f979d'

/** 筋肉の見える体に重ねる色（絵に掛け算する）。色づけなしは白、色づける場所があるときは、ほかを少し暗くして場所を明るく残す */
const SKIN_BASE = '#ffffff'
const SKIN_DIM = '#7d8588'
const SKIN_ACCENT = '#fff4e0'

/** 筋肉の見える体の絵を読み込む（読み込めなければ null のまま。無地の人形で表示を続ける） */
function useMuscleSkin(on: boolean) {
  const [maps, setMaps] = useState<{ color: THREE.Texture; normal: THREE.Texture } | null>(null)
  useEffect(() => {
    if (!on || maps) return
    let live = true
    const loader = new THREE.TextureLoader()
    const load = (url: string, srgb: boolean) =>
      new Promise<THREE.Texture>((res, rej) =>
        loader.load(
          url,
          (t) => {
            // GLB の UV は上下が逆（glTF の決まり）
            t.flipY = false
            if (srgb) t.colorSpace = THREE.SRGBColorSpace
            t.anisotropy = 4
            res(t)
          },
          undefined,
          rej,
        ),
      )
    Promise.all([load(MUSCLE_SKIN.color, true), load(MUSCLE_SKIN.normal, false)])
      .then(([color, normal]) => live && setMaps({ color, normal }))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [on, maps])
  return on ? maps : null
}

/** 筋肉ごとの、コマごとの濃さ（0〜1。推定の要求度） */
export interface MuscleLevels {
  ts: number[]
  values: Partial<Record<MuscleKey, number[]>>
}

export function MovingBody({
  kind,
  sport,
  poses,
  clock,
  muscles,
  levels,
  floorY,
  bare,
  skin = 'plain',
}: {
  kind: MannequinKind
  sport: MotionKind
  poses: { t: number; pose: Pose3D }[]
  clock: Clock
  muscles: boolean
  levels?: MuscleLevels
  floorY: number
  /** 床と影を描かない（動画に重ねるとき） */
  bare?: boolean
  /** 体の見た目（筋肉の見える体か、無地の人形か） */
  skin?: BodySkin
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
  const maps = useMuscleSkin(skin === 'muscle')
  useEffect(() => {
    root.traverse((o) => {
      const m = o as THREE.SkinnedMesh
      if (!m.isSkinnedMesh) return
      const mat = m.material as THREE.MeshStandardMaterial
      mat.map = maps?.color ?? null
      mat.normalMap = maps?.normal ?? null
      // 接線を持たない体なので、凹凸の絵の上下を glTF の決まりに合わせる
      mat.normalScale.set(1, -1)
      mat.roughness = maps ? 0.5 : 0.62
      mat.needsUpdate = true
    })
  }, [root, maps])
  // 筋肉の見える体では、色は絵に掛け算する。場所を色づけるときは、ほかを暗くして場所を明るく残す
  const marking = !!levels || muscles
  const base = maps ? (marking ? SKIN_DIM : SKIN_BASE) : BODY_COLOR
  const accent = maps ? SKIN_ACCENT : HIGHLIGHT_COLOR
  const shade = useMemo(() => (levels ? muscleShader(root, base, accent) : null), [root, levels, base, accent])
  const shown = useRef('')
  useEffect(() => {
    shown.current = ''
    if (!levels) paintMuscles(root, base, accent, muscles ? PROFILES[sport].muscles : [])
  }, [root, muscles, sport, levels, base, accent])
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
    // 腰を測った位置に置き、骨の長さを保ったまま足首・手首を測った位置に届かせる（動画に重ねたときに関節が重なるように）。
    // 横から撮った種目は、膝を前後・上下の面の中で曲げる。エルゴ・自転車は座った姿勢の腰にし、手を順手で握る形にする
    const seated = sport === 'erg' || sport === 'bike'
    poseMannequin(root, pose, { anchor: 'hips', planarLegs: sport !== 'squat_front', seated: sport === 'erg' ? 'round' : seated, grip: seated })
  })

  return (
    <>
      <primitive object={root} />
      {!bare && (
        <>
          {/* 床の格子: 細い線が体の高さの 1/10、太い線が半分。遠くは霧に消える */}
          <Grid
            position={[0, floorY, 0]}
            args={[20, 20]}
            cellSize={0.1}
            cellThickness={0.6}
            cellColor="#3d555c"
            sectionSize={0.5}
            sectionThickness={1.1}
            sectionColor="#6f8f99"
            fadeDistance={9}
            fadeStrength={1.6}
            infiniteGrid
          />
          <ContactShadows position={[0, floorY + 0.002, 0]} opacity={0.65} scale={3.2} blur={2.4} far={1.6} resolution={512} color="#000000" />
        </>
      )}
    </>
  )
}

/** 器具の形（体の点の動きから決めた目安。器具そのものを検出したものではない） */
function Gear({ eq, poses, clock, hip, ankle, side }: { eq: MotionEquipment; poses: { t: number; pose: Pose3D }[]; clock: Clock; hip: number; ankle: number; side: 1 | -1 }) {
  const seat = useRef<THREE.Mesh>(null)
  const arm = useRef<THREE.Mesh>(null)
  const armFar = useRef<THREE.Mesh>(null)
  // クランクと歯車はカメラ側（side。体の左が +1）に、反対のクランクは奥側に置く
  const X = 0.11 * side
  useFrame(() => {
    const pose = poseAtTime(poses, clock.get())
    if (!pose) return
    const h = pose.points[hip]
    if (seat.current && h) seat.current.position.z = h.z
    const a = pose.points[ankle]
    if (a && eq.bike) {
      const { y, z, r } = eq.bike.crank
      const ang = Math.atan2(a.y - y, a.z - z)
      for (const [m, an, x] of [
        [arm.current, ang, X],
        [armFar.current, ang + Math.PI, -X],
      ] as const) {
        if (!m) continue
        m.position.set(x, y + (Math.sin(an) * r) / 2, z + (Math.cos(an) * r) / 2)
        m.rotation.x = -an
      }
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
        <mesh position={[X, crank.y, crank.z]} rotation={[0, Math.PI / 2, 0]}>
          <torusGeometry args={[crank.r, 0.006, 8, 48]} />
          <meshStandardMaterial color={GEAR} roughness={0.7} />
        </mesh>
        <mesh position={[0, crank.y, crank.z]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.012, 0.012, 2 * Math.abs(X), 12]} />
          <meshStandardMaterial color={GEAR} roughness={0.7} />
        </mesh>
        <mesh ref={arm}>
          <boxGeometry args={[0.015, 0.02, crank.r]} />
          <meshStandardMaterial color={GEAR} roughness={0.7} />
        </mesh>
        <mesh ref={armFar}>
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
    camera.up.set(0, 1, 0)
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
  camera,
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
  /** 正面・後ろから撮ったときの向き（最初の視点を、撮った動画と同じ向きにする） */
  camera?: 'front' | 'rear'
}) {
  const body = mannequinKindOf(sex)
  const facingView = camera === 'rear' ? 'back' : 'front'
  const [view, setView] = useState<ViewKey>(camera ? facingView : 'side')
  // 同じ視点のボタンをもう一度押したときも、指で回した視点を元へ戻す
  const [resets, setResets] = useState(0)
  const [failed, setFailed] = useState(false)
  const [skin, setSkin] = useState<BodySkin>(loadBodySkin)
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
    <div className={cx('relative flex h-full flex-col overflow-hidden rounded-[var(--radius-panel)]', className)} style={{ background: STAGE }}>
      <div className="relative min-h-0 flex-1" style={{ touchAction: 'none' }}>
        <Canvas
          camera={{ position: [...pos], fov: 35, near: 0.05, far: 50 }}
          dpr={[1, 2]}
          gl={{ preserveDrawingBuffer: true }}
          onCreated={({ gl }) => onCanvas?.(gl.domElement)}
          aria-label="動きの 3D 再生。ドラッグで回転できます"
        >
          <color attach="background" args={[STAGE]} />
          <fog attach="fog" args={[STAGE, 7, 16]} />
          <BodyLights />
          <LoadBoundary onError={() => setFailed(true)}>
            <Suspense fallback={null}>
              <MovingBody kind={body} sport={kind} poses={poses} clock={clock} muscles={muscles} levels={levels} floorY={floorY} skin={skin} />
            </Suspense>
          </LoadBoundary>
          <Gear eq={equipment} poses={poses} clock={clock} hip={nearSide === 'left' ? 23 : 24} ankle={nearSide === 'left' ? 27 : 28} side={nearSide === 'left' ? 1 : -1} />
          <OrbitControls ref={controls} makeDefault target={[0, 0.45, 0]} enableDamping={!reduced} minDistance={0.8} maxDistance={8} />
          <ViewSetter view={`${view}:${resets}`} pos={pos} controls={controls} />
          {/* 軸の向き（X: 体の左、Y: 上、Z: 体の前）。軸の先を押すと、その向きから見る */}
          <GizmoHelper alignment="top-left" margin={[44, 44]}>
            <GizmoViewport axisColors={['#e0707a', '#9fc54a', '#5aa9d6']} labelColor="#10282f" axisHeadScale={0.9} />
          </GizmoHelper>
        </Canvas>
        <LoadingNote />
        <button
          type="button"
          aria-pressed={skin === 'muscle'}
          onClick={() => {
            const next = skin === 'muscle' ? 'plain' : 'muscle'
            setSkin(next)
            saveBodySkin(next)
          }}
          className={cx('absolute bottom-2 left-2 min-h-10 rounded-[var(--radius-control)] border px-3 text-sm', skin === 'muscle' ? 'border-paper bg-paper text-ink' : 'border-white/25 bg-black/30 text-paper hover:bg-white/10')}
        >
          筋肉の体
        </button>
      </div>
      <div className="grid grid-cols-5 gap-1 p-1.5" role="group" aria-label="3D の視点">
        {(camera ? ([facingView, 'oblique', 'side', facingView === 'front' ? 'back' : 'front', 'top'] as const) : (['side', 'oblique', 'front', 'back', 'top'] as const)).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={view === k}
            onClick={() => {
              setView(k)
              setResets((n) => n + 1)
            }}
            className={cx('min-h-10 rounded-[var(--radius-control)] border text-sm', view === k ? 'border-paper bg-paper text-ink' : 'border-white/25 text-paper hover:bg-white/10')}
          >
            {VIEW_LABELS[k]}
          </button>
        ))}
      </div>
    </div>
  )
}
