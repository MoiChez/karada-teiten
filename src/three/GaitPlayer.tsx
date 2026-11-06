// 歩き方の 3D 再生（遅延読み込み）。横から撮った関節の動きを、標準の人体（マネキン）にのせてその場で歩かせる。
// 床を歩く速さで後ろへ流して、進んでいるように見せる
import { Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { ContactShadows, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { Pause, Play } from 'lucide-react'
import type { GaitClip } from '../domain/gaitPose'
import type { Pose3D } from '../domain/fusion3d'
import type { UserProfile } from '../domain/types'
import { MANNEQUIN_LABELS, mannequinKindOf, paintMannequin, poseMannequin, type MannequinKind } from './mannequin'
import { BODY_COLOR, BodyLights, LoadBoundary, LoadingNote, hasWebGL, mannequinUrl } from './common'
import { Button, Notice, Segmented, cx } from '../components/ui'

/** 通過と通過のあいだの間（秒） */
const GAP = 0.5
/** 床の格子の 1 マス（体の高さ = 1） */
const CELL = 0.1

const VIEWS = {
  side: [-2.6, 0.55, 0],
  oblique: [-1.8, 1.0, 1.9],
  front: [0, 0.55, 2.6],
} as const

interface Timeline {
  items: { clip: GaitClip; from: number; dur: number }[]
  total: number
}

function timeline(clips: GaitClip[]): Timeline {
  let from = 0
  const items = clips.map((clip) => {
    const dur = (clip.end - clip.start) / 1000
    const item = { clip, from, dur }
    from += dur + GAP
    return item
  })
  return { items, total: Math.max(from, 0.1) }
}

const lerpPose = (a: Pose3D, b: Pose3D, w: number): Pose3D => ({
  depthSource: a.depthSource,
  points: a.points.map((p, i) => {
    const q = b.points[i]
    if (!p || !q) return p
    return { x: p.x + (q.x - p.x) * w, y: p.y + (q.y - p.y) * w, z: p.z + (q.z - p.z) * w }
  }),
})

/** 時刻 t（秒）での姿勢。通過の中のコマの間は直線で補う */
function poseAt(tl: Timeline, t: number) {
  const idx = Math.max(
    0,
    tl.items.findIndex((it) => t < it.from + it.dur + GAP),
  )
  const it = tl.items[idx]
  const local = Math.min(Math.max(t - it.from, 0), it.dur)
  const ms = it.clip.start + local * 1000
  const fs = it.clip.frames
  let lo = 0
  let hi = fs.length - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (fs[m].t <= ms) lo = m
    else hi = m
  }
  const a = fs[lo]
  const b = fs[hi]
  const w = b.t > a.t ? Math.min(1, Math.max(0, (ms - a.t) / (b.t - a.t))) : 0
  return { pose: lerpPose(a.pose, b.pose, w), index: idx, local, speed: it.clip.speed }
}

function WalkingBody({
  kind,
  tl,
  playing,
  speed,
  onPass,
}: {
  kind: MannequinKind
  tl: Timeline
  playing: boolean
  speed: number
  onPass: (i: number) => void
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
  const floor = useRef<THREE.Group>(null)
  const time = useRef(0)
  const pass = useRef(-1)
  const tmp = useMemo(() => new THREE.Vector3(), [])

  useFrame((_, delta) => {
    if (playing) time.current = (time.current + Math.min(delta, 0.1) * speed) % tl.total
    const { pose, index, local, speed: walk } = poseAt(tl, time.current)
    poseMannequin(root, pose)
    // いちばん低い足を床（y = 0）に置く
    let minY = Infinity
    for (const f of feet) minY = Math.min(minY, f.getWorldPosition(tmp).y)
    if (Number.isFinite(minY)) {
      root.position.y -= minY
      root.updateMatrixWorld(true)
    }
    if (floor.current) floor.current.position.z = -((walk * local) % CELL)
    if (index !== pass.current) {
      pass.current = index
      onPass(index)
    }
  })

  return (
    <>
      <primitive object={root} />
      <group ref={floor}>
        <gridHelper args={[2.4, 24, '#cfd9d8', '#dfe7e6']} />
      </group>
      <ContactShadows position={[0, 0.002, 0]} opacity={0.4} scale={2} blur={2.2} far={1.2} resolution={256} />
    </>
  )
}

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

export default function GaitPlayer({ clips, sex }: { clips: GaitClip[]; sex?: UserProfile['sex'] }) {
  const kind = mannequinKindOf(sex)
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const [playing, setPlaying] = useState(!reduced)
  const [speed, setSpeed] = useState<1 | 0.5 | 0.25>(1)
  const [view, setView] = useState<keyof typeof VIEWS>('side')
  const [pass, setPass] = useState(0)
  const [failed, setFailed] = useState(false)
  const controls = useRef<OrbitControlsImpl | null>(null)
  const webgl = useMemo(hasWebGL, [])
  const tl = useMemo(() => timeline(clips), [clips])

  if (!clips.length) return null
  if (!webgl) return <Notice tone="info">この端末では 3D を表示できません。</Notice>
  if (failed) return <Notice tone="info">体のモデルを読み込めませんでした。通信できる状態で開き直すと表示されます。</Notice>

  return (
    <div>
      <div className="relative h-[min(56dvh,460px)] overflow-hidden rounded-[var(--radius-panel)] bg-surface" style={{ touchAction: 'none' }}>
        <Canvas camera={{ position: [...VIEWS.side], fov: 35, near: 0.05, far: 50 }} dpr={[1, 2]} aria-label="歩き方の 3D 再生。ドラッグで回転できます">
          <BodyLights />
          <LoadBoundary onError={() => setFailed(true)}>
            <Suspense fallback={null}>
              <WalkingBody kind={kind} tl={tl} playing={playing} speed={speed} onPass={setPass} />
            </Suspense>
          </LoadBoundary>
          <OrbitControls ref={controls} makeDefault target={[0, 0.5, 0]} enableDamping={!reduced} minDistance={0.8} maxDistance={6} />
          <ViewSetter view={view} controls={controls} />
        </Canvas>
        <LoadingNote />
        {clips.length > 1 && (
          <span className="pointer-events-none absolute top-2 left-2 rounded-full bg-paper/90 px-2.5 py-0.5 text-sm text-ink-2 num">
            {pass + 1} / {clips.length} 回目の通過
          </span>
        )}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="secondary"
          aria-label={playing ? '一時停止' : '再生'}
          onClick={() => setPlaying(!playing)}
          icon={playing ? <Pause aria-hidden className="size-5" /> : <Play aria-hidden className="size-5" />}
        >
          {playing ? '止める' : '再生'}
        </Button>
        <div className="grid flex-1 grid-cols-3 gap-1.5" role="group" aria-label="視点">
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
              className={cx('min-h-11 rounded-[var(--radius-control)] border text-[15px]', view === k ? 'border-ink bg-ink text-paper' : 'border-line bg-surface hover:bg-sunken')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2">
        <Segmented
          legend="速さ"
          value={speed}
          onChange={setSpeed}
          options={[
            { value: 1, label: '等速' },
            { value: 0.5, label: '1/2' },
            { value: 0.25, label: '1/4' },
          ]}
        />
      </div>
      <p className="mt-3 text-sm text-ink-3">
        体は{MANNEQUIN_LABELS[kind]}（全員に共通の形）で、横から撮った関節の前後・上下の動きだけを反映しています。左右の揺れや体のねじれは測っていないため動きません。その場で歩くように、腰の進みを差し引いて表示しています。
      </p>
    </div>
  )
}
