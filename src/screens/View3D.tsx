// 3D ビュー（遅延読み込み）。正面と横向きの 2 枚から合成した関節の向きを、標準の人体（マネキン）にのせて表示する。
// 「骨格」に切り替えると、合成した関節の位置そのもの（棒と点）を表示する
import { Component, Suspense, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router'
import { Canvas, useLoader, useThree } from '@react-three/fiber'
import { ContactShadows, Environment, Lightformer, Line, OrbitControls, useProgress } from '@react-three/drei'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { AssessmentSession, BodyArea } from '../domain/types'
import { fuse3D, type Pose3D, type Vec3 } from '../domain/fusion3d'
import { fmtDate } from '../domain/format'
import { useProfile, useSession } from '../data/hooks'
import { MANNEQUIN_LABELS, mannequinKindOf, paintMannequin, poseMannequin, type MannequinKind } from '../three/mannequin'
import { PostureGrid } from '../components/PoseViews'
import { Notice, Screen, Segmented, cx } from '../components/ui'

type Bone = { a: number | 'neck' | 'headTop' | 'midShoulder' | 'midHip'; b: number | 'neck' | 'midShoulder' | 'midHip' | 'headTop'; r: number; areas: BodyArea[] }

const BONES: Bone[] = [
  { a: 'midShoulder', b: 'headTop', r: 0.022, areas: ['neck'] },
  { a: 11, b: 12, r: 0.03, areas: ['shoulders'] },
  { a: 11, b: 13, r: 0.026, areas: ['shoulders'] },
  { a: 13, b: 15, r: 0.022, areas: [] },
  { a: 12, b: 14, r: 0.026, areas: ['shoulders'] },
  { a: 14, b: 16, r: 0.022, areas: [] },
  { a: 'midShoulder', b: 'midHip', r: 0.05, areas: ['upper_back', 'lower_back'] },
  { a: 11, b: 23, r: 0.03, areas: ['upper_back'] },
  { a: 12, b: 24, r: 0.03, areas: ['upper_back'] },
  { a: 23, b: 24, r: 0.035, areas: ['hips', 'lower_back'] },
  { a: 23, b: 25, r: 0.036, areas: ['hips'] },
  { a: 25, b: 27, r: 0.03, areas: ['knees'] },
  { a: 24, b: 26, r: 0.036, areas: ['hips'] },
  { a: 26, b: 28, r: 0.03, areas: ['knees'] },
  { a: 27, b: 31, r: 0.02, areas: ['feet'] },
  { a: 28, b: 32, r: 0.02, areas: ['feet'] },
  { a: 27, b: 29, r: 0.02, areas: ['feet'] },
  { a: 28, b: 30, r: 0.02, areas: ['feet'] },
]
const JOINTS: { i: number; areas: BodyArea[] }[] = [
  { i: 11, areas: ['shoulders'] },
  { i: 12, areas: ['shoulders'] },
  { i: 23, areas: ['hips'] },
  { i: 24, areas: ['hips'] },
  { i: 25, areas: ['knees'] },
  { i: 26, areas: ['knees'] },
  { i: 27, areas: ['feet'] },
  { i: 28, areas: ['feet'] },
]

const INK = '#3d555c'
const HIGHLIGHT = '#e3a13b'
const PAST = '#7c8d93'
/** マネキンの色（明るいグレー） */
const BODY = '#c9d2d4'

function point(p: Pose3D, k: Bone['a']): Vec3 | null {
  if (typeof k === 'number') return p.points[k]
  const m = (i: number, j: number) => {
    const a = p.points[i]
    const b = p.points[j]
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 } : null
  }
  if (k === 'midShoulder') return m(11, 12)
  if (k === 'midHip') return m(23, 24)
  const ears = m(7, 8)
  if (k === 'headTop' || k === 'neck') return ears ? { ...ears, y: ears.y - 0.02 } : p.points[0]
  return null
}

const v3 = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z)

// ---------- 骨格（合成した関節の位置そのもの） ----------

function Capsule({ from, to, r, color, opacity = 1 }: { from: Vec3; to: Vec3; r: number; color: string; opacity?: number }) {
  const { position, quaternion, length } = useMemo(() => {
    const a = v3(from)
    const b = v3(to)
    const dir = b.clone().sub(a)
    const len = dir.length()
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
    return { position: a.add(b).multiplyScalar(0.5), quaternion: q, length: len }
  }, [from, to])
  if (length < 1e-4) return null
  return (
    <mesh position={position} quaternion={quaternion}>
      <capsuleGeometry args={[r, Math.max(0.001, length - r), 6, 12]} />
      <meshStandardMaterial color={color} roughness={0.6} transparent={opacity < 1} opacity={opacity} />
    </mesh>
  )
}

function SkeletonFigure({ pose, highlight }: { pose: Pose3D; highlight: Set<BodyArea> }) {
  const head = point(pose, 'headTop')
  return (
    <group>
      {BONES.map((b, i) => {
        const p = point(pose, b.a)
        const q = point(pose, b.b)
        if (!p || !q) return null
        const hot = b.areas.some((a) => highlight.has(a))
        return <Capsule key={i} from={p} to={q} r={b.r} color={hot ? HIGHLIGHT : INK} />
      })}
      {JOINTS.map(({ i, areas }) => {
        const p = pose.points[i]
        if (!p) return null
        const hot = areas.some((a) => highlight.has(a))
        return (
          <mesh key={i} position={v3(p)}>
            <sphereGeometry args={[0.035, 16, 12]} />
            <meshStandardMaterial color={hot ? HIGHLIGHT : '#cde14b'} roughness={0.5} />
          </mesh>
        )
      })}
      {head && (
        <mesh position={[head.x, head.y + 0.035, head.z]}>
          <sphereGeometry args={[0.065, 24, 18]} />
          <meshStandardMaterial color={INK} roughness={0.6} />
        </mesh>
      )}
    </group>
  )
}

function SkeletonGhost({ pose }: { pose: Pose3D }) {
  return (
    <group>
      {BONES.map((b, i) => {
        const p = point(pose, b.a)
        const q = point(pose, b.b)
        if (!p || !q) return null
        return <Line key={i} points={[v3(p), v3(q)]} color={PAST} lineWidth={2} dashed dashSize={0.02} gapSize={0.015} />
      })}
    </group>
  )
}

// ---------- 人体（標準の体を関節の向きに合わせて曲げたもの） ----------

const mannequinUrl = (k: MannequinKind) => `${import.meta.env.BASE_URL}models/mannequin-v1-${k}.glb`

function BodyModel({ kind, pose, highlight, tone }: { kind: MannequinKind; pose: Pose3D; highlight: Set<BodyArea>; tone: 'current' | 'past' }) {
  const gltf = useLoader(GLTFLoader, mannequinUrl(kind))
  const root = useMemo(() => {
    const r = cloneSkinned(gltf.scene)
    r.traverse((o) => {
      const m = o as THREE.SkinnedMesh
      if (!m.isSkinnedMesh) return
      // 曲げた後の形が元の範囲からはみ出しても消えないように
      m.frustumCulled = false
      m.geometry = m.geometry.clone()
      m.material =
        tone === 'current'
          ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 })
          : new THREE.MeshStandardMaterial({ color: PAST, roughness: 0.8, transparent: true, opacity: 0.28, depthWrite: false })
    })
    return r
  }, [gltf, tone])
  useMemo(() => poseMannequin(root, pose), [root, pose])
  useMemo(() => {
    if (tone === 'current') paintMannequin(root, BODY, HIGHLIGHT, highlight)
  }, [root, highlight, tone])
  return <primitive object={root} />
}

/** 体のモデルを読み込めなかったとき（初回にオフラインなど）、骨格の表示に切り替える */
class LoadBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.onError()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

function LoadingNote() {
  const { active } = useProgress()
  if (!active) return null
  return <p className="pointer-events-none absolute inset-x-0 top-3 text-center text-sm text-ink-3">体のモデルを読み込んでいます…</p>
}

const VIEWS = {
  front: [0, 0.55, 2.3],
  side: [-2.3, 0.55, 0],
  top: [0, 2.6, 0.01],
  oblique: [1.5, 1.1, 1.7],
} as const

function ViewSetter({ view, controls }: { view: keyof typeof VIEWS; controls: RefObject<OrbitControlsImpl | null> }) {
  const { camera } = useThree()
  const last = useRef<string>('')
  if (last.current !== view) {
    last.current = view
    const [x, y, z] = VIEWS[view]
    camera.position.set(x, y, z)
    camera.lookAt(0, 0.5, 0)
    controls.current?.target.set(0, 0.5, 0)
    controls.current?.update()
  }
  return null
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

export default function View3D() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const vs = params.get('vs') ?? undefined
  const session = useSession(id)
  const past = useSession(vs)
  const profile = useProfile()
  // 比較相手とプロフィールの読み込みが終わるまで待ってから描く（重ね表示と体のモデルを初期状態にするため）
  if (session === undefined || (vs && past === undefined) || profile === undefined) return <Screen title="3D ビュー" back={`/session/${id}`}>{null}</Screen>
  if (!session) return <Navigate to="/history" replace />
  return <View3DBody s={session} past={past ?? undefined} kind={mannequinKindOf(profile?.sex)} />
}

function View3DBody({ s, past, kind }: { s: AssessmentSession; past?: AssessmentSession; kind: MannequinKind }) {
  const pose = useMemo(() => fuse3D(s.front, s.side), [s])
  const pastPose = useMemo(() => (past ? fuse3D(past.front, past.side) : null), [past])
  const [show, setShow] = useState<'current' | 'past' | 'both'>(pastPose ? 'both' : 'current')
  const [view, setView] = useState<keyof typeof VIEWS>('oblique')
  const [mode, setMode] = useState<'body' | 'skeleton'>('body')
  const [loadFailed, setLoadFailed] = useState(false)
  const [highlightOn, setHighlightOn] = useState(true)
  const controls = useRef<OrbitControlsImpl | null>(null)
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const webgl = useMemo(hasWebGL, [])
  // 全身が色づくと意味がなくなるので、差の大きい特徴 2 つの主な部位だけを示す
  const topTraits = useMemo(
    () => s.postureTraits.filter((t) => t.status === 'noticeable').sort((a, b) => b.magnitude - a.magnitude).slice(0, 2),
    [s],
  )
  const highlight = useMemo(
    () => new Set<BodyArea>(highlightOn ? topTraits.flatMap((t) => t.relatedAreas.slice(0, 2)).filter((a) => a !== 'whole_body') : []),
    [topTraits, highlightOn],
  )
  const none = useMemo(() => new Set<BodyArea>(), [])
  const floorY = pose ? Math.min(...[29, 30, 31, 32].map((i) => pose.points[i]?.y ?? 0)) - 0.01 : 0
  const body = mode === 'body' && !loadFailed

  return (
    <Screen title="3D ビュー" back={`/session/${s.id}`}>
      <p className="text-sm text-ink-3 num">
        {fmtDate(s.createdAt)}
        {past ? `（前回 ${fmtDate(past.createdAt)} と比較）` : ''}
      </p>
      {!pose ? (
        <Notice tone="info" title="3D を作れません">
          正面の写真の骨格が必要です。正面の測定がある記録を選んでください。
        </Notice>
      ) : !webgl ? (
        <>
          <Notice tone="info" title="この端末では 3D を表示できません">
            代わりに、体の高さでそろえた骨格の図を表示します。
          </Notice>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <PostureGrid current={s.front} past={past?.front} label="正面の骨格" />
            <PostureGrid current={s.side} past={past?.side} label="横向きの骨格" />
          </div>
        </>
      ) : (
        <>
          {pose.depthSource === 'model_estimate' && (
            <div className="mt-2">
              <Notice tone="info">横向きの写真がないため、奥行きは推定モデルの値を使っています。</Notice>
            </div>
          )}
          {loadFailed && (
            <div className="mt-2">
              <Notice tone="info">体のモデルを読み込めなかったため、骨格で表示しています。通信できる状態で開き直すと表示されます。</Notice>
            </div>
          )}
          <div className="relative mt-3 h-[min(62dvh,520px)] overflow-hidden rounded-[var(--radius-panel)] bg-surface" style={{ touchAction: 'none' }}>
            <Canvas camera={{ position: [...VIEWS.oblique], fov: 35, near: 0.05, far: 50 }} dpr={[1, 2]} aria-label="姿勢の 3D 表示。ドラッグで回転、ピンチで拡大縮小できます">
              <ambientLight intensity={body ? 0.3 : 0.75} />
              <directionalLight position={[2, 3, 2]} intensity={body ? 1.5 : 1.2} />
              <directionalLight position={[-2, 1.5, -1.5]} intensity={body ? 0.55 : 0.4} />
              {body && (
                <Environment resolution={128}>
                  <Lightformer form="rect" intensity={1.6} position={[2.5, 3, 3]} scale={[4, 3, 1]} />
                  <Lightformer form="rect" intensity={0.7} position={[-3, 1.5, -2]} scale={[3, 2, 1]} />
                  <Lightformer form="rect" intensity={0.9} position={[0, 4, 0]} rotation-x={Math.PI / 2} scale={[3, 3, 1]} />
                </Environment>
              )}
              <gridHelper args={[2, 20, '#cfd9d8', '#dfe7e6']} position={[0, floorY, 0]} />
              <Line points={[[0, floorY, 0], [0, 1.15, 0]]} color="#1c6e8c" lineWidth={1.5} dashed dashSize={0.03} gapSize={0.02} />
              {body ? (
                <LoadBoundary onError={() => setLoadFailed(true)}>
                  <Suspense fallback={null}>
                    {(show === 'current' || show === 'both') && <BodyModel kind={kind} pose={pose} highlight={highlight} tone="current" />}
                    {pastPose && show === 'past' && <BodyModel kind={kind} pose={pastPose} highlight={none} tone="current" />}
                    {pastPose && show === 'both' && <BodyModel kind={kind} pose={pastPose} highlight={none} tone="past" />}
                    <ContactShadows position={[0, floorY + 0.002, 0]} opacity={0.4} scale={2} blur={2.2} far={1.2} resolution={512} />
                  </Suspense>
                </LoadBoundary>
              ) : (
                <>
                  {(show === 'current' || show === 'both') && <SkeletonFigure pose={pose} highlight={highlight} />}
                  {pastPose && (show === 'past' || show === 'both') && (show === 'past' ? <SkeletonFigure pose={pastPose} highlight={none} /> : <SkeletonGhost pose={pastPose} />)}
                </>
              )}
              <OrbitControls ref={controls} makeDefault target={[0, 0.5, 0]} enableDamping={!reduced} minDistance={0.8} maxDistance={6} />
              <ViewSetter view={view} controls={controls} />
            </Canvas>
            {body && <LoadingNote />}
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1.5" role="group" aria-label="視点">
            {(
              [
                ['front', '正面'],
                ['side', '横'],
                ['top', '上'],
                ['oblique', '斜め'],
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
          <div className="mt-4">
            <Segmented
              legend="表示"
              value={loadFailed ? 'skeleton' : mode}
              onChange={(m) => {
                setMode(m)
                if (m === 'body') setLoadFailed(false)
              }}
              options={[
                { value: 'body', label: '人体' },
                { value: 'skeleton', label: '骨格' },
              ]}
            />
          </div>
          {pastPose && (
            <div className="mt-2">
              <Segmented
                legend="表示する姿勢"
                value={show}
                onChange={setShow}
                options={[
                  { value: 'current', label: '今回' },
                  { value: 'past', label: '前回' },
                  { value: 'both', label: '重ねる' },
                ]}
              />
            </div>
          )}
          <label className="mt-1 flex min-h-11 items-center gap-2 text-[15px]">
            <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={highlightOn} onChange={(e) => setHighlightOn(e.target.checked)} />
            関連が考えられる部位を色で示す
          </label>
          <ul className="mt-2 space-y-1.5 text-sm text-ink-2">
            <li className="flex items-center gap-2">
              <span aria-hidden className="size-3 rounded-full" style={{ background: HIGHLIGHT }} />
              負担がかかりやすい可能性がある部位（参考）{topTraits.length ? `: ${topTraits.map((t) => t.label).join('・')}に関連` : ': 差が見られた特徴はありません'}
            </li>
            {pastPose && (
              <li className="flex items-center gap-2">
                {body ? (
                  <span aria-hidden className="size-3 rounded-full opacity-50" style={{ background: PAST }} />
                ) : (
                  <svg aria-hidden width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke={PAST} strokeWidth="2" strokeDasharray="4 3" /></svg>
                )}
                前回の姿勢{body ? '（半透明）' : ''}
              </li>
            )}
            <li className="flex items-center gap-2">
              <svg aria-hidden width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="#1c6e8c" strokeWidth="2" strokeDasharray="4 3" /></svg>
              足首の中央を通る鉛直線
            </li>
          </ul>
          {body ? (
            <p className="mt-3 text-sm text-ink-3">
              体は{MANNEQUIN_LABELS[kind]}（プロフィールの性別から選んだ、全員に共通の形）で、正面と横向きの写真から合成した関節の向きだけを反映しています。あなたの体型・筋肉・脂肪のつき方や、骨・背骨の形は表していません。骨盤の前後の傾きと背中の丸みも反映していません。関節の位置そのものは「骨格」で見られます。
            </p>
          ) : (
            <p className="mt-3 text-sm text-ink-3">
              正面と横向きの写真から合成した関節の位置です。実際の骨の位置ではありません。大きさは体の高さを 1 としてそろえています。
            </p>
          )}
        </>
      )}
    </Screen>
  )
}
