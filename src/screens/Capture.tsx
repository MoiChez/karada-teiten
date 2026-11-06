import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { ChevronLeft, History, ImageUp, Loader2, RefreshCcw, SwitchCamera, Timer } from 'lucide-react'
import type { DeviceTilt, Landmark, Plane, PlaneRecord, ShootStyle } from '../domain/types'
import { MIN_VISIBILITY } from '../domain/constants'
import { visibilityOf } from '../domain/metrics'
import { SKELETON_EDGES } from '../domain/landmarks'
import { sideEdges } from '../domain/figure'
import { framingAdvice, framingOf } from '../domain/framing'
import { analyzePlane } from '../pose/analyzePlane'
import { flipCanvas, grabVideoFrame, prepareFromCanvas, prepareFromFile, type PreparedImage } from '../pose/image'
import { POSE_MODEL, detectImage, getLandmarker } from '../pose/landmarker'
import { beep, useDeviceTilt, vibrate } from '../pose/device'
import { useSessions } from '../data/hooks'
import { useDraft, useSettings, type PlaneDraft, type Pose } from '../state/stores'
import { Button, cx } from '../components/ui'

type CamState = 'starting' | 'live' | 'denied' | 'unavailable' | 'insecure' | 'error'
type LiveCheck = 'none' | 'partial' | 'ok' | 'loading'

/**
 * カメラに頼む映像の大きさ（順に試す）。スマホのカメラはもともと横長で、縦に持つとブラウザが回して縦長にする。
 * 縦長の大きさを頼むと、機種によっては横長の帯を切り出してしまい、頭や足が入らない。
 * 縦に持っているのに横長の映像が来たら、次の頼み方を試す
 */
const CAMERA_SIZES: MediaTrackConstraints[] = [
  { width: { ideal: 1920 }, height: { ideal: 1440 } },
  { width: { ideal: 1440 }, height: { ideal: 1920 } },
  { aspectRatio: { ideal: 3 / 4 }, height: { ideal: 1920 } },
]

export function Capture({ pose = 'habitual' }: { pose?: Pose }) {
  const { plane } = useParams()
  const sessionId = useDraft((s) => s.conscious.sessionId)
  if (plane !== 'front' && plane !== 'side') return <Navigate to="/measure" replace />
  if (pose === 'conscious' && !sessionId) return <Navigate to="/history" replace />
  return <CaptureInner key={`${pose}-${plane}`} plane={plane} pose={pose} sessionId={sessionId} />
}

function CaptureInner({ plane, pose, sessionId }: { plane: Plane; pose: Pose; sessionId?: string }) {
  const navigate = useNavigate()
  const settings = useSettings((s) => s.settings)
  const updateSetting = useSettings((s) => s.update)
  const setPlane = useDraft((s) => s.setPlane)
  const sessions = useSessions()
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [cam, setCam] = useState<CamState>('starting')
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment')
  // 何番目の頼み方で開いているか。どれでも横長だったら、いちばん高解像度の頼み方に戻して知らせる
  const [camTry, setCamTry] = useState(0)
  const [landscapeOnly, setLandscapeOnly] = useState(false)
  const [timer, setTimer] = useState<number>(settings.timerSec)
  const [phase, setPhase] = useState<{ n: number } | null>(null)
  const [running, setRunning] = useState(false)
  const runningRef = useRef(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveCheck>('loading')
  const [liveLms, setLiveLms] = useState<Landmark[] | null>(null)
  const [vdims, setVdims] = useState<{ w: number; h: number } | null>(null)
  const [showGuide, setShowGuide] = useState(true)
  const { tilt, latest, needsPermission, request } = useDeviceTilt()
  const cancelRef = useRef(false)

  const conscious = pose === 'conscious'
  const draftStyle = useDraft((s) => s.style)
  // 意識した姿勢は、いつもの姿勢と同じ撮り方で撮る
  const style: ShootStyle = conscious ? (sessions?.find((s) => s.id === sessionId)?.shootStyle ?? 'placed') : draftStyle
  // 鏡の前で自撮り: 画面には鏡に映った姿がそのまま出る。撮った写真は左右を戻してから分析・保存する
  const mirrorSelfie = style === 'mirror'
  const mirrored = facingMode === 'user'
  const title = conscious ? `意識した姿勢（${plane === 'front' ? '正面' : '横向き'}）` : plane === 'front' ? '正面を撮る' : '横向きを撮る'
  const base = conscious ? '/measure/conscious' : '/measure'
  const consciousFront = useDraft((s) => s.conscious.front)
  const back = plane === 'side' && (!conscious || consciousFront) ? `${base}/review/front` : conscious ? `/session/${sessionId}` : '/measure'

  // 前回の骨格（意識した姿勢では、同じセッションのいつもの姿勢）
  const guideRec: PlaneRecord | undefined = useMemo(() => {
    if (!sessions) return undefined
    const list = conscious ? sessions.filter((s) => s.id === sessionId) : sessions
    return list.find((s) => (s[plane]?.landmarksRaw.length ?? 0) >= 33)?.[plane]
  }, [sessions, conscious, sessionId, plane])
  // 前回の骨格は左右を戻して保存してあるので、鏡の前では画面（鏡に映った姿）に合わせて左右を反転して重ねる
  const guideLms = useMemo(
    () => (guideRec ? (mirrorSelfie ? guideRec.landmarksCorrected.map((l) => ({ ...l, x: 1 - l.x })) : guideRec.landmarksCorrected) : undefined),
    [guideRec, mirrorSelfie],
  )
  const aspectOk =
    !!guideRec && !!vdims && Math.abs(guideRec.imageMetadata.width / guideRec.imageMetadata.height / (vdims.w / vdims.h) - 1) < 0.03
  const guideOn = showGuide && !!guideRec && aspectOk

  // カメラの開始・停止
  useEffect(() => {
    let stopped = false
    async function start() {
      if (!window.isSecureContext) return setCam('insecure')
      if (!navigator.mediaDevices?.getUserMedia) return setCam('unavailable')
      setCam('starting')
      setVdims(null)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode, ...CAMERA_SIZES[camTry] },
        })
        if (stopped) return stream.getTracks().forEach((t) => t.stop())
        streamRef.current = stream
        const v = videoRef.current
        if (v) {
          v.srcObject = stream
          await v.play().catch(() => undefined)
        }
        setCam('live')
      } catch (e) {
        const name = e instanceof DOMException ? e.name : ''
        setCam(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'unavailable' : 'error')
      }
    }
    start()
    return () => {
      stopped = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [facingMode, camTry])

  // 縦に持っているのに横長の映像なら、次の頼み方で開き直す
  useEffect(() => {
    if (cam !== 'live' || !vdims || landscapeOnly) return
    if (!window.matchMedia('(orientation: portrait)').matches || vdims.h >= vdims.w) return
    if (camTry < CAMERA_SIZES.length - 1) {
      setCamTry(camTry + 1)
    } else {
      setLandscapeOnly(true)
      setCamTry(0)
    }
  }, [cam, vdims, camTry, landscapeOnly])

  // 映像の縦横の大きさ（前回の骨格を重ねる座標に使う）
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const update = () => v.videoWidth && setVdims({ w: v.videoWidth, h: v.videoHeight })
    update()
    v.addEventListener('loadedmetadata', update)
    v.addEventListener('resize', update)
    return () => {
      v.removeEventListener('loadedmetadata', update)
      v.removeEventListener('resize', update)
    }
  }, [cam])

  // 全身が入っているかの確認（低頻度）
  useEffect(() => {
    if (cam !== 'live') return
    let alive = true
    let timerId: ReturnType<typeof setTimeout>
    const near = plane === 'front' ? [7, 8, 29, 30, 31, 32] : null
    const tick = async () => {
      const v = videoRef.current
      // 撮影中・推定中は止める（推定は同じモデルを使うため）
      if (!alive || !v || v.readyState < 2 || busy || runningRef.current) {
        timerId = setTimeout(tick, 500)
        return
      }
      try {
        const r = await detectImage(v, POSE_MODEL)
        if (!alive) return
        setLiveLms(r.landmarks)
        if (!r.landmarks) setLive('none')
        else {
          const lms = r.landmarks
          const ok = (i: number) => lms[i].x >= 0 && lms[i].x <= 1 && lms[i].y >= 0.01 && lms[i].y <= 0.99 && visibilityOf(lms[i]) >= MIN_VISIBILITY
          const required = near ?? (visibilityOf(lms[7]) >= visibilityOf(lms[8]) ? [7, 29, 31] : [8, 30, 32])
          setLive(required.every(ok) ? 'ok' : 'partial')
        }
      } catch {
        if (alive) setLive('none')
      }
      timerId = setTimeout(tick, 600)
    }
    tick()
    return () => {
      alive = false
      clearTimeout(timerId)
    }
  }, [cam, plane, busy])

  // 推定モデルを先に読み込んでおく
  useEffect(() => {
    getLandmarker(POSE_MODEL, 'IMAGE').catch(() => undefined)
  }, [])

  const advice = useMemo(() => {
    if (!guideOn || !vdims || !liveLms) return null
    const prev = framingOf(plane, guideLms!, vdims.w, vdims.h, guideRec!.imageMetadata.nearSide)
    const cur = framingOf(plane, liveLms, vdims.w, vdims.h)
    return prev && cur ? framingAdvice(prev, cur, mirrored) : null
  }, [guideOn, guideRec, guideLms, vdims, liveLms, plane, mirrored])

  const processImage = useCallback(
    async (image: PreparedImage, source: 'camera' | 'upload', tilt?: DeviceTilt, notice?: string) => {
      setBusy('骨格を推定しています')
      setError(null)
      try {
        const record = await analyzePlane({ plane, image, source, model: POSE_MODEL, deviceTilt: tilt, mirrorSelfie })
        const draft: PlaneDraft = { record, imageBlob: image.blob, imageUrl: URL.createObjectURL(image.blob), notice }
        setPlane(plane, draft, pose)
        navigate(`${base}/review/${plane}`)
      } catch (e) {
        setBusy(null)
        setError(
          e instanceof Error && /fetch|load|network|wasm/i.test(e.message)
            ? '骨格推定の準備に失敗しました。通信状態を確認して、もう一度お試しください。'
            : '骨格を推定できませんでした。もう一度お試しください。',
        )
      }
    },
    [plane, pose, base, setPlane, navigate, mirrorSelfie],
  )

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  const shoot = async () => {
    const v = videoRef.current
    if (!v || cam !== 'live') return
    if (needsPermission) request()
    cancelRef.current = false
    runningRef.current = true
    setRunning(true)
    let frame: HTMLCanvasElement
    let tilt: DeviceTilt | undefined
    try {
      for (let n = timer; n > 0; n--) {
        if (cancelRef.current) return
        setPhase({ n })
        beep(880)
        await sleep(1000)
      }
      if (cancelRef.current) return
      frame = grabVideoFrame(v)
      tilt = latest.current ?? undefined
      beep(1320, 140)
      vibrate(60)
    } catch {
      setError('写真を撮れませんでした。もう一度お試しください。')
      return
    } finally {
      setPhase(null)
      runningRef.current = false
      setRunning(false)
    }
    let image: PreparedImage
    try {
      setBusy('写真を準備しています')
      image = await prepareFromCanvas(mirrorSelfie ? flipCanvas(frame) : frame)
    } catch {
      setBusy(null)
      setError('写真を撮れませんでした。もう一度お試しください。')
      return
    }
    await processImage(image, 'camera', tilt)
  }

  const onFiles = async (list: FileList | null) => {
    const file = list?.[0]
    if (!file) return
    try {
      setBusy('写真を読み込んでいます')
      // 鏡の前で撮った写真は、左右を戻してから使う
      await processImage(await prepareFromFile(file, { flip: mirrorSelfie }), 'upload')
    } catch (e) {
      setBusy(null)
      setError(e instanceof Error ? e.message : '写真を読み込めませんでした')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const roll = tilt?.rollDeg ?? null
  const level = roll === null ? null : Math.abs(roll) <= 3
  const prevFacing = plane === 'side' ? guideRec?.imageMetadata.facing : undefined
  // 画面が鏡像（内カメラ）か、鏡に映った姿を撮っているときは、前回の向きを左右反転して案内する
  const shownFacing = prevFacing && (mirrored !== mirrorSelfie ? (prevFacing === 'left' ? 'right' : 'left') : prevFacing)
  const bottomText = [
    conscious ? '自分が良いと思う姿勢で立ちます。' : '',
    plane === 'side'
      ? shownFacing
        ? `${conscious ? 'いつもの姿勢' : '前回'}と同じく、顔を画面の${shownFacing === 'left' ? '左' : '右'}に向けて真横に立ちます`
        : '体の右側か左側をカメラに向け、真横を向いて立ちます'
      : '',
  ]
    .filter(Boolean)
    .join('')

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-ink text-paper">
      <header className="safe-top flex items-center gap-1 px-2">
        <button type="button" aria-label="戻る" onClick={() => navigate(back)} className="inline-flex size-11 items-center justify-center rounded-full hover:bg-white/10">
          <ChevronLeft aria-hidden className="size-6" />
        </button>
        <h1 className="flex-1 text-[17px] font-bold">{title}</h1>
        <span className="pr-3 text-sm text-paper/75 num">{plane === 'front' ? '1 / 2' : '2 / 2'}</span>
        {conscious && (
          <button type="button" onClick={() => navigate(`/session/${sessionId}`)} disabled={running} className="mr-1 min-h-11 rounded-full px-3 text-sm text-paper/90 underline hover:bg-white/10 disabled:opacity-40">
            あとで
          </button>
        )}
      </header>
      {conscious && plane === 'front' && (
        <p className="px-4 pb-2 text-sm text-paper/80">続けて、自分が良いと思う姿勢で撮ります。いつもの姿勢との違いから、意識で変えられる差かどうかが分かります。</p>
      )}

      <div className="relative min-h-0 flex-1">
        {cam === 'live' || cam === 'starting' ? (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              aria-label="カメラの映像"
              className={cx('absolute inset-0 size-full object-contain', mirrored && '-scale-x-100')}
            />
            {guideOn && vdims ? (
              <svg
                aria-hidden
                viewBox={`0 0 ${vdims.w} ${vdims.h}`}
                preserveAspectRatio="xMidYMid meet"
                className={cx('pointer-events-none absolute inset-0 size-full', mirrored && '-scale-x-100')}
              >
                <PoseLines lms={guideLms!} plane={plane} nearSide={guideRec!.imageMetadata.nearSide} w={vdims.w} h={vdims.h} tone="prev" />
                {liveLms && <PoseLines lms={liveLms} plane={plane} w={vdims.w} h={vdims.h} tone="live" />}
              </svg>
            ) : (
              <GuideOverlay plane={plane} />
            )}
            {cam === 'starting' && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 aria-hidden className="size-8 animate-spin text-paper/70" />
                <span className="sr-only">カメラを起動しています</span>
              </div>
            )}
          </>
        ) : (
          <CameraProblem state={cam} onUpload={() => fileRef.current?.click()} />
        )}

        {/* 上部の状態表示 */}
        {cam === 'live' && (
          <div className="pointer-events-none absolute inset-x-0 top-2 flex flex-wrap justify-center gap-2 px-3" aria-live="polite">
            <StatusChip ok={live === 'ok'} warn={live === 'partial'}>
              {live === 'ok' ? '全身が入っています' : live === 'partial' ? '頭からつま先まで入るように' : live === 'none' ? '人が見つかりません' : '確認の準備中'}
            </StatusChip>
            {level !== null && (
              <StatusChip ok={level} warn={!level}>
                {level ? '端末はまっすぐです' : `端末が ${Math.abs(roll!).toFixed(0)}° 傾いています`}
              </StatusChip>
            )}
            {guideOn && advice && (
              <StatusChip ok={advice.ok} warn={!advice.ok}>
                {advice.ok ? `${conscious ? 'いつもの姿勢' : '前回'}と同じ位置です` : advice.messages[0]}
              </StatusChip>
            )}
            {landscapeOnly && (
              <StatusChip warn>このスマホでは映像が横長になります。全身が入るまで離れるか、「写真を選ぶ」から縦に撮った写真を使ってください</StatusChip>
            )}
          </div>
        )}
        {cam === 'live' && bottomText && !phase && (
          <p className="pointer-events-none absolute inset-x-0 bottom-3 px-6 text-center text-sm text-paper/85">{bottomText}</p>
        )}
        {guideOn && !phase && (
          <p className="pointer-events-none absolute right-3 bottom-10 flex items-center gap-1.5 rounded-full bg-ink/60 px-2.5 py-1 text-xs text-paper/90 backdrop-blur">
            <span aria-hidden className="inline-block h-0 w-5 border-t-2 border-dashed border-level" />
            {conscious ? 'いつもの姿勢' : '前回'}の位置
          </p>
        )}

        {phase && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink/40 px-6 text-center" aria-live="assertive">
            <span className="text-[120px] leading-none font-bold text-level num">{phase.n}</span>
            {mirrorSelfie && <p className="max-w-[24ch] text-[17px]">{plane === 'front' ? '鏡の中の自分の目を見てください' : 'まっすぐ前を見てください'}</p>}
          </div>
        )}
        {busy && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink/80" role="status">
            <Loader2 aria-hidden className="size-9 animate-spin text-level" />
            <p className="text-[17px]">{busy}…</p>
            <p className="max-w-[28ch] text-center text-sm text-paper/75">はじめての時はモデルの読み込みに少し時間がかかります</p>
          </div>
        )}
      </div>

      {error && (
        <div role="alert" className="mx-3 mb-2 rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-[15px] text-ink">
          {error}
        </div>
      )}

      {/* 操作 */}
      <div className="safe-bottom px-4 pt-3 pb-4">
        {needsPermission && cam === 'live' && (
          <button type="button" onClick={request} className="mb-2 w-full text-center text-sm text-level underline">
            水準器を使う（傾きセンサーを許可）
          </button>
        )}
        <div className="mb-1 flex items-center justify-center gap-1" role="group" aria-label="セルフタイマー">
          <Timer aria-hidden className="mr-1 size-4 text-paper/75" />
          {[0, 3, 5, 10].map((t) => (
            <Pill
              key={t}
              pressed={timer === t}
              disabled={running}
              onClick={() => {
                setTimer(t)
                updateSetting('timerSec', t as 0 | 3 | 5 | 10)
              }}
            >
              {t === 0 ? 'オフ' : `${t}秒`}
            </Pill>
          ))}
        </div>
        <div className="mb-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <span className="text-sm text-paper/80">{mirrorSelfie ? '鏡の前で自撮り' : 'スマホを置いて撮影'}</span>
          {vdims && cam === 'live' && <span className="text-xs text-paper/55 num">映像 {vdims.w}×{vdims.h}</span>}
          {guideRec && (
            <Pill pressed={showGuide} onClick={() => setShowGuide(!showGuide)}>
              <History aria-hidden className="mr-1 inline size-4 align-[-3px]" />
              {conscious ? 'いつもの位置' : '前回の位置'}
            </Pill>
          )}
        </div>
        {showGuide && guideRec && vdims && !aspectOk && (
          <p className="-mt-2 mb-2 text-center text-xs text-paper/70">前回と写真の縦横比が違うため、前回の位置は重ねられません</p>
        )}
        {mirrorSelfie && !running && (
          <p className="-mt-2 mb-3 text-center text-xs text-paper/70">スマホは胸の前で縦にまっすぐ持ち、撮る瞬間は画面ではなく前を見ます</p>
        )}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={running}
            className="flex min-h-14 min-w-16 flex-col items-center justify-center gap-0.5 rounded-xl text-xs text-paper/90 hover:bg-white/10 disabled:opacity-40"
          >
            <ImageUp aria-hidden className="size-6" />
            写真を選ぶ
          </button>
          {running ? (
            <button type="button" onClick={() => (cancelRef.current = true)} className="flex size-20 items-center justify-center rounded-full border-4 border-paper text-[15px] font-bold">
              中止
            </button>
          ) : (
            <button
              type="button"
              aria-label={`${timer ? `${timer}秒後に` : ''}撮影`}
              disabled={cam !== 'live' || !!busy}
              onClick={shoot}
              className="flex size-20 items-center justify-center rounded-full border-4 border-paper disabled:opacity-40"
            >
              <span className="size-15 rounded-full bg-level" />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setFacingMode(facingMode === 'environment' ? 'user' : 'environment')
              setCamTry(0)
              setLandscapeOnly(false)
            }}
            disabled={running || (cam !== 'live' && cam !== 'starting')}
            className="flex min-h-14 min-w-16 flex-col items-center justify-center gap-0.5 rounded-xl text-xs text-paper/90 hover:bg-white/10 disabled:opacity-40"
          >
            <SwitchCamera aria-hidden className="size-6" />
            {facingMode === 'environment' ? '内カメラ' : '外カメラ'}
          </button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => onFiles(e.target.files)} />
      </div>
    </div>
  )
}

function Pill({ pressed, disabled, onClick, children }: { pressed: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cx('min-h-10 min-w-12 rounded-full px-3 text-sm num disabled:opacity-40', pressed ? 'bg-paper font-bold text-ink' : 'text-paper/85 hover:bg-white/10')}
    >
      {children}
    </button>
  )
}

function StatusChip({ ok, warn, children }: { ok?: boolean; warn?: boolean; children: ReactNode }) {
  return (
    <span className={cx('rounded-full px-3 py-1 text-[13px] font-medium backdrop-blur', ok ? 'bg-level text-ink' : warn ? 'bg-attention-soft text-attention' : 'bg-ink/70 text-paper')}>
      {children}
    </span>
  )
}

/** カメラの映像に重ねる骨格。prev = 前回（破線）、live = 今の推定（細い実線） */
function PoseLines({
  lms,
  plane,
  nearSide,
  w,
  h,
  tone,
}: {
  lms: Landmark[]
  plane: Plane
  nearSide?: 'left' | 'right'
  w: number
  h: number
  tone: 'prev' | 'live'
}) {
  if (lms.length < 33) return null
  const side = nearSide ?? (visibilityOf(lms[11]) >= visibilityOf(lms[12]) ? 'left' : 'right')
  const edges = plane === 'front' ? SKELETON_EDGES : sideEdges(side)
  const ok = (i: number) => visibilityOf(lms[i]) >= 0.3
  const P = (i: number) => ({ x: lms[i].x * w, y: lms[i].y * h })
  const k = Math.max(w, h) / 800
  const es = edges.filter(([a, b]) => ok(a) && ok(b))
  return (
    <g>
      {tone === 'prev' &&
        es.map(([a, b]) => (
          <line key={`h${a}-${b}`} x1={P(a).x} y1={P(a).y} x2={P(b).x} y2={P(b).y} stroke="#10282F" strokeOpacity={0.5} strokeWidth={7 * k} strokeLinecap="round" />
        ))}
      {es.map(([a, b]) => (
        <line
          key={`${a}-${b}`}
          x1={P(a).x}
          y1={P(a).y}
          x2={P(b).x}
          y2={P(b).y}
          stroke={tone === 'prev' ? '#CDE14B' : '#FFFFFF'}
          strokeOpacity={tone === 'prev' ? 1 : 0.8}
          strokeWidth={(tone === 'prev' ? 3 : 2) * k}
          strokeDasharray={tone === 'prev' ? `${9 * k} ${7 * k}` : undefined}
          strokeLinecap="round"
        />
      ))}
    </g>
  )
}

/** ガイド枠: 頭とつま先の帯、中心線、体の輪郭 */
function GuideOverlay({ plane }: { plane: Plane }) {
  return (
    <svg aria-hidden viewBox="0 0 300 533" preserveAspectRatio="xMidYMid meet" className="pointer-events-none absolute inset-0 size-full">
      <rect x="0" y="22" width="300" height="34" fill="#CDE14B" opacity="0.10" />
      <rect x="0" y="480" width="300" height="30" fill="#CDE14B" opacity="0.10" />
      <line x1="0" x2="300" y1="40" y2="40" stroke="#CDE14B" strokeOpacity="0.7" strokeDasharray="6 6" />
      <line x1="0" x2="300" y1="500" y2="500" stroke="#CDE14B" strokeOpacity="0.7" strokeDasharray="6 6" />
      <line x1="150" x2="150" y1="20" y2="515" stroke="#FFFFFF" strokeOpacity="0.45" strokeDasharray="2 6" />
      {plane === 'front' ? (
        <path
          d="M150 44c-17 0-28 13-28 29s11 29 28 29 28-13 28-29-11-29-28-29zM112 112c-20 6-30 20-32 40l-8 110c0 8 10 9 12 1l12-90 6 2-2 120 8 166c1 10 16 10 17 0l10-150h10l10 150c1 10 16 10 17 0l8-166-2-120 6-2 12 90c2 8 12 7 12-1l-8-110c-2-20-12-34-32-40z"
          fill="none"
          stroke="#FFFFFF"
          strokeOpacity="0.55"
          strokeWidth="1.5"
        />
      ) : (
        <path
          d="M152 44c-16 0-26 13-26 29s10 29 26 29 24-13 24-29-8-29-24-29zM140 110c-14 6-20 24-18 44l6 110c2 30 4 60 2 90l-4 140c0 8 8 12 16 10h22c6 0 6-8 0-10l-14-4 2-130c4-40 4-80 2-110l4-90c0-30-6-46-18-50z"
          fill="none"
          stroke="#FFFFFF"
          strokeOpacity="0.55"
          strokeWidth="1.5"
        />
      )}
      <text x="150" y="16" textAnchor="middle" fill="#FFFFFF" fillOpacity="0.8" fontSize="11">頭をこの帯に</text>
      <text x="150" y="526" textAnchor="middle" fill="#FFFFFF" fillOpacity="0.8" fontSize="11">つま先をこの帯に</text>
    </svg>
  )
}

function CameraProblem({ state, onUpload }: { state: CamState; onUpload: () => void }) {
  const msg: Record<string, { title: string; text: string }> = {
    denied: { title: 'カメラの使用が許可されていません', text: 'ブラウザのアドレスバー横の鍵アイコン、または端末の設定から、このサイトのカメラを許可してください。写真を選んで分析することもできます。' },
    unavailable: { title: 'カメラが見つかりません', text: '端末のカメラアプリで撮った写真を選んで分析できます。' },
    insecure: { title: 'このページではカメラを使えません', text: 'カメラは HTTPS で開いたページでのみ使えます。写真を選んで分析することはできます。' },
    error: { title: 'カメラを起動できませんでした', text: '他のアプリがカメラを使っていないか確認してください。写真を選んで分析することもできます。' },
  }
  const m = msg[state] ?? msg.error
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <p className="text-[17px] font-bold">{m.title}</p>
      <p className="text-[15px] text-paper/80">{m.text}</p>
      <p className="text-sm text-paper/70">同じ姿勢で続けて撮った写真を 2〜3 枚選ぶと、平均して測ります。</p>
      <div className="mt-2 flex gap-2">
        <Button variant="primary" onClick={onUpload} icon={<ImageUp aria-hidden className="size-5" />}>
          写真を選ぶ
        </Button>
        {state !== 'insecure' && (
          <Button variant="secondary" onClick={() => window.location.reload()} icon={<RefreshCcw aria-hidden className="size-5" />}>
            再試行
          </Button>
        )}
      </div>
    </div>
  )
}
