import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { ChevronLeft, ImageUp, Loader2, RefreshCcw, SwitchCamera, Timer } from 'lucide-react'
import type { Plane } from '../domain/types'
import { MIN_VISIBILITY } from '../domain/constants'
import { visibilityOf } from '../domain/metrics'
import { analyzePlane } from '../pose/analyzePlane'
import { prepareFromFile, prepareFromVideo, type PreparedImage } from '../pose/image'
import { detectVideoFrame, getLandmarker } from '../pose/landmarker'
import { beep, useDeviceTilt, vibrate } from '../pose/device'
import { useDraft, useSettings } from '../state/stores'
import { Button, cx } from '../components/ui'

type CamState = 'starting' | 'live' | 'denied' | 'unavailable' | 'insecure' | 'error'
type LiveCheck = 'none' | 'partial' | 'ok' | 'loading'

export function Capture() {
  const { plane } = useParams()
  if (plane !== 'front' && plane !== 'side') return <Navigate to="/measure" replace />
  return <CaptureInner key={plane} plane={plane} />
}

function CaptureInner({ plane }: { plane: Plane }) {
  const navigate = useNavigate()
  const settings = useSettings((s) => s.settings)
  const updateSetting = useSettings((s) => s.update)
  const setPlane = useDraft((s) => s.setPlane)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [cam, setCam] = useState<CamState>('starting')
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment')
  const [timer, setTimer] = useState<number>(settings.timerSec)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveCheck>('loading')
  const { tilt, latest, needsPermission, request } = useDeviceTilt()
  const cancelRef = useRef(false)

  const title = plane === 'front' ? '正面を撮る' : '横向きを撮る'

  // カメラの開始・停止
  useEffect(() => {
    let stopped = false
    async function start() {
      if (!window.isSecureContext) return setCam('insecure')
      if (!navigator.mediaDevices?.getUserMedia) return setCam('unavailable')
      setCam('starting')
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode, width: { ideal: 1440 }, height: { ideal: 1920 } },
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
  }, [facingMode])

  // 全身が入っているかの確認（低頻度）
  useEffect(() => {
    if (cam !== 'live') return
    let alive = true
    let timerId: ReturnType<typeof setTimeout>
    const near = plane === 'front' ? [7, 8, 29, 30, 31, 32] : null
    const tick = async () => {
      const v = videoRef.current
      if (!alive || !v || v.readyState < 2 || busy) {
        timerId = setTimeout(tick, 500)
        return
      }
      try {
        const r = await detectVideoFrame(v, settings.model, performance.now())
        if (!alive) return
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
      timerId = setTimeout(tick, 450)
    }
    tick()
    return () => {
      alive = false
      clearTimeout(timerId)
    }
  }, [cam, plane, settings.model, busy])

  // 推定モデルを先に読み込んでおく
  useEffect(() => {
    getLandmarker(settings.model, 'IMAGE').catch(() => undefined)
  }, [settings.model])

  const process = useCallback(
    async (img: PreparedImage, source: 'camera' | 'upload') => {
      setBusy('骨格を推定しています')
      setError(null)
      try {
        const record = await analyzePlane({ plane, image: img, source, model: settings.model, deviceTilt: source === 'camera' ? latest.current ?? undefined : undefined })
        setPlane(plane, { record, imageBlob: img.blob, imageUrl: URL.createObjectURL(img.blob) })
        navigate(`/measure/review/${plane}`)
      } catch (e) {
        setBusy(null)
        setError(
          e instanceof Error && /fetch|load|network|wasm/i.test(e.message)
            ? '骨格推定の準備に失敗しました。通信状態を確認して、もう一度お試しください。'
            : '骨格を推定できませんでした。もう一度お試しください。',
        )
      }
    },
    [plane, settings.model, latest, setPlane, navigate],
  )

  const shoot = async () => {
    const v = videoRef.current
    if (!v || cam !== 'live') return
    if (needsPermission) request()
    cancelRef.current = false
    for (let n = timer; n > 0; n--) {
      if (cancelRef.current) {
        setCountdown(null)
        return
      }
      setCountdown(n)
      beep(880)
      await new Promise((r) => setTimeout(r, 1000))
    }
    setCountdown(null)
    if (cancelRef.current) return
    beep(1320, 140)
    vibrate(60)
    try {
      const img = await prepareFromVideo(v)
      await process(img, 'camera')
    } catch {
      setError('写真を撮れませんでした。もう一度お試しください。')
    }
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    try {
      setBusy('写真を読み込んでいます')
      const img = await prepareFromFile(file)
      await process(img, 'upload')
    } catch (e) {
      setBusy(null)
      setError(e instanceof Error ? e.message : '写真を読み込めませんでした')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const roll = tilt?.rollDeg ?? null
  const level = roll === null ? null : Math.abs(roll) <= 3

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-ink text-paper">
      <header className="safe-top flex items-center gap-1 px-2">
        <button type="button" aria-label="戻る" onClick={() => navigate(plane === 'side' ? '/measure/review/front' : '/measure')} className="inline-flex size-11 items-center justify-center rounded-full hover:bg-white/10">
          <ChevronLeft aria-hidden className="size-6" />
        </button>
        <h1 className="flex-1 text-[17px] font-bold">{title}</h1>
        <span className="pr-3 text-sm text-paper/75 num">{plane === 'front' ? '1 / 2' : '2 / 2'}</span>
      </header>

      <div className="relative min-h-0 flex-1">
        {cam === 'live' || cam === 'starting' ? (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              aria-label="カメラの映像"
              className={cx('absolute inset-0 size-full object-contain', facingMode === 'user' && '-scale-x-100')}
            />
            <GuideOverlay plane={plane} />
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
          </div>
        )}
        {plane === 'side' && cam === 'live' && (
          <p className="pointer-events-none absolute inset-x-0 bottom-3 px-6 text-center text-sm text-paper/85">体の右側か左側をカメラに向け、真横を向いて立ちます</p>
        )}

        {countdown !== null && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink/30">
            <span className="text-[120px] leading-none font-bold text-level num" aria-live="assertive">
              {countdown}
            </span>
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
        <div className="mb-3 flex items-center justify-center gap-1" role="group" aria-label="セルフタイマー">
          <Timer aria-hidden className="mr-1 size-4 text-paper/75" />
          {[0, 3, 5, 10].map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={timer === t}
              onClick={() => {
                setTimer(t)
                updateSetting('timerSec', t as 0 | 3 | 5 | 10)
              }}
              className={cx('min-h-10 min-w-12 rounded-full px-3 text-sm num', timer === t ? 'bg-paper text-ink font-bold' : 'text-paper/85 hover:bg-white/10')}
            >
              {t === 0 ? 'オフ' : `${t}秒`}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex min-h-14 min-w-16 flex-col items-center justify-center gap-0.5 rounded-xl text-xs text-paper/90 hover:bg-white/10"
          >
            <ImageUp aria-hidden className="size-6" />
            写真を選ぶ
          </button>
          {countdown !== null ? (
            <button type="button" onClick={() => (cancelRef.current = true)} className="flex size-20 items-center justify-center rounded-full border-4 border-paper text-[15px] font-bold">
              中止
            </button>
          ) : (
            <button
              type="button"
              aria-label={timer ? `${timer}秒後に撮影` : '撮影'}
              disabled={cam !== 'live' || !!busy}
              onClick={shoot}
              className="flex size-20 items-center justify-center rounded-full border-4 border-paper disabled:opacity-40"
            >
              <span className="size-15 rounded-full bg-level" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setFacingMode(facingMode === 'environment' ? 'user' : 'environment')}
            disabled={cam !== 'live' && cam !== 'starting'}
            className="flex min-h-14 min-w-16 flex-col items-center justify-center gap-0.5 rounded-xl text-xs text-paper/90 hover:bg-white/10 disabled:opacity-40"
          >
            <SwitchCamera aria-hidden className="size-6" />
            {facingMode === 'environment' ? '内カメラ' : '外カメラ'}
          </button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => onFile(e.target.files?.[0])} />
      </div>
    </div>
  )
}

function StatusChip({ ok, warn, children }: { ok?: boolean; warn?: boolean; children: ReactNode }) {
  return (
    <span className={cx('rounded-full px-3 py-1 text-[13px] font-medium backdrop-blur', ok ? 'bg-level text-ink' : warn ? 'bg-attention-soft text-attention' : 'bg-ink/70 text-paper')}>
      {children}
    </span>
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
