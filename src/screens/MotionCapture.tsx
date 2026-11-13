// 動きの撮影（スクワット）。横から撮り、撮り終わってから 1 コマずつ骨格を推定する。
// 動画（コマの画像）は、残すと選んだときだけ端末に保存する。残さないときも、この画面を閉じるまでは結果で再生できる
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ChevronLeft, FileVideo, Loader2, Video } from 'lucide-react'
import { MOTION_KIND_LIST, PROFILES, analyzeMotion, fullBodyInFrame, motionInputOf, turnsFromBody, voteTurns, type MotionKind, type MotionRecord } from '../domain/motion'
import { quarterTurnsOf, screenRollDeg } from '../domain/tilt'
import type { DeviceTilt } from '../domain/types'
import { APP_VERSION, newId } from '../domain/session'
import { POSE_MODEL, detectImage, getLandmarker, modelVersion } from '../pose/landmarker'
import { beep, speak, useDeviceTilt, vibrate } from '../pose/device'
import { FILE_MAX_MS, detectRecorded, detectVideoFile, recordFrames, type DetectedClip, type Progress } from '../pose/motionVideo'
import { keepMotionVideo } from '../state/motionMedia'
import { data } from '../data/repo'
import { useProfile } from '../data/hooks'
import { Button, Notice, Screen, Segmented, cx } from '../components/ui'

type Phase = 'guide' | 'camera' | 'countdown' | 'recording' | 'analyzing' | 'failed'
type CamState = 'starting' | 'live' | 'denied' | 'unavailable' | 'insecure' | 'error'

/** 押してから撮り始めるまで（立ち位置へ移るため）と、撮る長さの上限 */
const COUNTDOWN_SEC = 5
const RECORD_MS = 20_000

function screenAngle() {
  const a = screen.orientation?.angle
  if (typeof a === 'number') return a
  const legacy = (window as unknown as { orientation?: number }).orientation
  return typeof legacy === 'number' ? (legacy + 360) % 360 : 0
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function MotionCapture() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const initial = params.get('kind')
  const [kind, setKind] = useState<MotionKind>(MOTION_KIND_LIST.includes(initial as MotionKind) ? (initial as MotionKind) : 'squat')
  const profile = PROFILES[kind]
  const me = useProfile()
  const [phase, setPhase] = useState<Phase>('guide')
  const [keepVideo, setKeepVideo] = useState(false)
  const [cam, setCam] = useState<CamState>('starting')
  const [count, setCount] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [failure, setFailure] = useState<string[]>([])
  const [live, setLive] = useState<'none' | 'partial' | 'ok' | null>(null)
  const [vdims, setVdims] = useState<{ w: number; h: number } | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const stopRef = useRef(false)
  const bodyTurns = useRef<number | null>(null)
  const turnVotes = useRef<(number | null)[]>([])
  const { tilt, latest, needsPermission, request } = useDeviceTilt()

  const cameraOn = phase === 'camera' || phase === 'countdown' || phase === 'recording'

  // カメラ
  useEffect(() => {
    if (!cameraOn) return
    let stopped = false
    async function start() {
      if (!window.isSecureContext) return setCam('insecure')
      if (!navigator.mediaDevices?.getUserMedia) return setCam('unavailable')
      setCam('starting')
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
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
  }, [cameraOn])

  // 撮影中は画面が消えないようにする（対応ブラウザのみ）
  useEffect(() => {
    if (!cameraOn) return
    let lock: { release: () => Promise<void> } | null = null
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }
    nav.wakeLock
      ?.request('screen')
      .then((l) => (lock = l))
      .catch(() => undefined)
    return () => {
      lock?.release().catch(() => undefined)
    }
  }, [cameraOn])

  useEffect(() => {
    const v = videoRef.current
    if (!v || cam !== 'live') return
    const update = () => v.videoWidth && setVdims({ w: v.videoWidth, h: v.videoHeight })
    update()
    v.addEventListener('loadedmetadata', update)
    v.addEventListener('resize', update)
    return () => {
      v.removeEventListener('loadedmetadata', update)
      v.removeEventListener('resize', update)
    }
  }, [cam])

  // 全身が入っているか・体の向き（低頻度。撮影中は止める）
  useEffect(() => {
    if (phase !== 'camera' || cam !== 'live') return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      const v = videoRef.current
      if (!alive) return
      if (v && v.readyState >= 2 && v.videoWidth) {
        try {
          const r = await detectImage(v, POSE_MODEL)
          if (!alive) return
          if (!r.landmarks) setLive('none')
          else {
            setLive(fullBodyInFrame(r.landmarks) ? 'ok' : 'partial')
            // 直近 5 回の推定の多数決で、映像の回し方を決める（1 回の乱れで回さない）
            const k = turnsFromBody(r.landmarks, v.videoWidth, v.videoHeight)
            if (k !== null) turnVotes.current = [...turnVotes.current, k].slice(-5)
            if (turnVotes.current.length >= 3) bodyTurns.current = voteTurns(turnVotes.current)
          }
        } catch {
          if (alive) setLive(null)
        }
      }
      timer = setTimeout(tick, 900)
    }
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [phase, cam])

  useEffect(() => {
    getLandmarker(POSE_MODEL).catch(() => undefined)
  }, [])

  // 端末の傾きから、映像の回し方と残りの傾き（立てて置いているときだけ使う）
  const sensorOf = (t: DeviceTilt | null) => (!t || t.pitchDeg < 45 || t.pitchDeg > 135 ? null : quarterTurnsOf(screenRollDeg(t.rollDeg, screenAngle())))
  const sensor = sensorOf(tilt)
  // 写っている人の向きを優先し、分からなければ端末の傾きで決める
  const turnsNow = () => bodyTurns.current ?? sensorOf(latest.current)?.turns ?? 0
  const turns = bodyTurns.current ?? sensor?.turns ?? 0
  const residual = sensor && sensor.turns === turns ? sensor.residualDeg : null
  const level = residual === null ? null : Math.abs(residual) <= 2
  // 回したあとの映像の向きが、種目のおすすめ（スクワットは縦、エルゴと自転車は横）と違えば知らせる
  const landscapeOut = vdims ? (Math.abs(turns) % 2 === 1 ? vdims.w < vdims.h : vdims.w > vdims.h) : null
  const turnHint = landscapeOut === null ? null : profile.orientation === 'portrait' && landscapeOut ? 'スマホを縦向きにすると、体を大きく写せます' : profile.orientation === 'landscape' && !landscapeOut ? 'スマホを横向きにすると、広く写せます' : null

  const finishWith = async (clip: DetectedClip, source: MotionRecord['source'], rollDeg: number | undefined) => {
    const base: Omit<MotionRecord, 'analysis'> = {
      id: newId('m'),
      createdAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      kind,
      source,
      modelVersion: modelVersion(POSE_MODEL),
      video: {
        width: clip.width,
        height: clip.height,
        durationMs: Math.round(clip.durationMs),
        frameCount: clip.frameCount,
        fps: Math.round(clip.fps * 10) / 10,
        quarterTurns: clip.quarterTurns,
        rollDeg: rollDeg === undefined ? undefined : Math.round(rollDeg * 10) / 10,
      },
      videoSaved: false,
      frames: clip.frames,
      // 重心と負担の推定に使う（プロフィールに入っていれば。結果の画面で変えられる）
      body: me?.heightCm || me?.weightKg ? { heightCm: me.heightCm, weightKg: me.weightKg } : undefined,
    }
    const analysis = analyzeMotion(motionInputOf(base), kind)
    if (!analysis.cycles.length) {
      setFailure(analysis.warnings.length ? analysis.warnings : ['動きの区切りを見つけられませんでした。'])
      setPhase('failed')
      return
    }
    const rec: MotionRecord = { ...base, analysis }
    const video = { width: clip.width, height: clip.height, images: clip.images }
    keepMotionVideo(rec.id, video)
    await data.saveMotion(rec, keepVideo ? video : undefined)
    navigate(`/motion/${rec.id}`, { replace: true })
  }

  const fail = (e: unknown) => {
    if (e instanceof Error && e.message === 'cancelled') {
      setPhase('guide')
      return
    }
    setFailure([
      e instanceof Error && /fetch|load|network|wasm/i.test(e.message)
        ? '骨格推定の準備に失敗しました。通信状態を確かめて、もう一度お試しください。'
        : e instanceof Error && e.message
          ? e.message
          : '推定の途中で問題が起きました。もう一度お試しください。',
    ])
    setPhase('failed')
  }

  const start = async () => {
    const v = videoRef.current
    if (!v || cam !== 'live' || !v.videoWidth) return
    if (needsPermission) request()
    stopRef.current = false
    setPhase('countdown')
    speak(`${COUNTDOWN_SEC}秒後に撮影を始めます。${kind === 'squat' ? '横向きに立ってください' : '準備してください'}`)
    for (let n = COUNTDOWN_SEC; n > 0; n--) {
      if (stopRef.current) return setPhase('camera')
      setCount(n)
      if (n <= 3) beep(880)
      await sleep(1000)
    }
    if (stopRef.current) return setPhase('camera')
    // 撮り始めの向きで、映像の回し方を決める
    const k = turnsNow()
    const rolls: number[] = []
    setElapsed(0)
    setPhase('recording')
    beep(1320, 200)
    vibrate(80)
    speak('始めてください')
    let lastShown = 0
    const clip = await recordFrames(v, {
      durationMs: RECORD_MS,
      turns: k,
      stopRef,
      onTick: (ms) => {
        const q = sensorOf(latest.current)
        if (q && q.turns === k) rolls.push(q.residualDeg)
        if (ms - lastShown > 250) {
          lastShown = ms
          setElapsed(ms)
        }
      },
    })
    beep(660, 250)
    speak('撮影が終わりました')
    // 「撮り終える」で止めたときも、3 秒以上撮れていれば使う
    const cancelled = stopRef.current && clip.durationMs < 3000
    streamRef.current?.getTracks().forEach((t) => t.stop())
    if (cancelled) return setPhase('guide')
    stopRef.current = false
    setProgress({ done: 0, total: clip.frames.length })
    setPhase('analyzing')
    const rollDeg = rolls.length >= clip.frames.length / 2 ? rolls.reduce((a, b) => a + b, 0) / rolls.length : undefined
    try {
      const detected = await detectRecorded(clip, k, setProgress, stopRef)
      await finishWith(detected, 'camera', rollDeg)
    } catch (e) {
      fail(e)
    }
  }

  const onFile = async (list: FileList | null) => {
    const file = list?.[0]
    if (fileRef.current) fileRef.current.value = ''
    if (!file) return
    stopRef.current = false
    setProgress(null)
    setPhase('analyzing')
    try {
      const detected = await detectVideoFile(file, setProgress, stopRef)
      await finishWith(detected, 'upload', undefined)
    } catch (e) {
      fail(e)
    }
  }

  const label = profile.label

  if (phase === 'guide' || phase === 'failed' || phase === 'analyzing') {
    return (
      <Screen title={`${label}を撮る`} back={phase === 'analyzing' ? undefined : '/motion'}>
        {phase === 'analyzing' ? (
          <div className="flex flex-col items-center py-12 text-center" role="status" aria-live="polite">
            <Loader2 aria-hidden className="size-8 animate-spin text-measure" />
            <p className="mt-4 text-[17px] font-bold">骨格を推定しています</p>
            {progress ? (
              <>
                <p className="mt-1 text-ink-2 num">
                  {progress.done} / {progress.total} コマ
                </p>
                <div className="mt-3 h-2 w-full max-w-xs overflow-hidden rounded-full bg-sunken">
                  <div className="h-full bg-measure transition-[width]" style={{ width: `${progress.total ? (100 * progress.done) / progress.total : 0}%` }} />
                </div>
              </>
            ) : (
              <p className="mt-1 text-ink-2">動画を読み込んでいます</p>
            )}
            <p className="mt-4 max-w-[34ch] text-sm text-ink-3">1 コマずつ推定するため、スマホでは 30 秒〜1 分ほどかかります。この画面のままお待ちください。</p>
            <Button variant="quiet" className="mt-4" onClick={() => (stopRef.current = true)}>
              やめる
            </Button>
          </div>
        ) : (
          <>
            {phase === 'failed' && (
              <div className="mt-2">
                <Notice tone="warn" title="測れませんでした">
                  <ul className="list-disc space-y-1 pl-4">
                    {failure.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </Notice>
              </div>
            )}
            <div className="mt-2">
              <Segmented legend="種目" value={kind} onChange={setKind} columns={3} options={MOTION_KIND_LIST.map((k) => ({ value: k, label: k === 'erg' ? 'エルゴ' : k === 'bike' ? '自転車' : PROFILES[k].label }))} />
            </div>
            <p className="text-[15px] text-ink-2">
              横から{label}の動きを撮って、1 {profile.unitLabel}ごとに、{profile.metrics
                .slice(0, 5)
                .map((m) => m.label)
                .join('・')}
              などを測ります。撮った動画と 3D の体を並べて、スロー再生やコマ送りで見られます。
            </p>
            <h2 className="mt-6 font-bold">撮る前に</h2>
            <ol className="mt-2 list-decimal space-y-2 pl-5 text-[15px]">
              {profile.guide.map((g) => (
                <li key={g}>{g}</li>
              ))}
              <li>撮影は最長 {RECORD_MS / 1000} 秒です。</li>
            </ol>
            <label className="mt-5 flex min-h-11 items-start gap-3 rounded-[var(--radius-control)] bg-surface px-3.5 py-3 text-[15px]">
              <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--color-ink)]" checked={keepVideo} onChange={(e) => setKeepVideo(e.target.checked)} />
              <span>
                動画をこの端末に残す
                <span className="mt-0.5 block text-sm text-ink-3">
                  残すと、あとで開いたときも動画と 3D を並べて見られます。残さない場合も、骨格の動きは保存され、動画はこのページを閉じるまで見られます。どちらの場合も、外部には送りません。
                </span>
              </span>
            </label>
            <div className="mt-6 flex flex-col gap-2">
              <Button variant="primary" size="lg" block icon={<Video aria-hidden className="size-5" />} onClick={() => setPhase('camera')}>
                カメラで撮る
              </Button>
              <Button variant="secondary" size="lg" block icon={<FileVideo aria-hidden className="size-5" />} onClick={() => fileRef.current?.click()}>
                撮った動画を選ぶ
              </Button>
              <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={(e) => onFile(e.target.files)} />
              <p className="text-sm text-ink-3">
                スマホのカメラで横から撮った動画も使えます（最初の {FILE_MAX_MS / 1000} 秒まで）。カメラは動かさずに置いて撮り、スローモーションにしないでください。
              </p>
            </div>
          </>
        )}
      </Screen>
    )
  }

  const camMessage: Record<Exclude<CamState, 'live' | 'starting'>, string> = {
    denied: 'カメラの使用が許可されていません。ブラウザの設定で許可するか、撮った動画を選んでください。',
    unavailable: 'カメラが見つかりませんでした。撮った動画を選んでください。',
    insecure: 'この接続ではカメラを使えません（https で開いてください）。',
    error: 'カメラを開けませんでした。撮った動画を選んでください。',
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-ink text-paper">
      <header className="safe-top flex items-center gap-1 px-2">
        <button
          type="button"
          aria-label="戻る"
          onClick={() => {
            stopRef.current = true
            setPhase('guide')
          }}
          className="inline-flex size-11 items-center justify-center rounded-full hover:bg-white/10"
        >
          <ChevronLeft aria-hidden className="size-6" />
        </button>
        <h1 className="flex-1 text-[17px] font-bold">{label}を撮る</h1>
      </header>
      <div className="relative min-h-0 flex-1">
        <video ref={videoRef} playsInline muted autoPlay aria-label="カメラの映像" className="absolute inset-0 size-full object-contain" />
        {cam !== 'live' && cam !== 'starting' && <p className="absolute inset-x-6 top-1/3 text-center text-[15px]">{camMessage[cam]}</p>}
        {phase === 'camera' && cam === 'live' && (
          <div className="absolute inset-x-0 top-2 flex flex-wrap justify-center gap-2 px-3 text-sm">
            <span className={cx('rounded-full px-3 py-1', live === 'ok' ? 'bg-good text-paper' : 'bg-black/60')}>
              {live === 'ok' ? '全身が写っています' : live === 'partial' ? '頭から足まで入るように離れてください' : live === 'none' ? '立つ位置に立つと、写り方を確かめられます' : '確認しています…'}
            </span>
            {residual !== null && (
              <span className={cx('rounded-full px-3 py-1 num', level ? 'bg-good text-paper' : 'bg-attention text-paper')}>
                傾き {Math.abs(residual).toFixed(1)}°{level ? '' : '（まっすぐに）'}
              </span>
            )}
            {turnHint && <span className="rounded-full bg-black/60 px-3 py-1">{turnHint}</span>}
          </div>
        )}
        {phase === 'countdown' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 text-center" role="status" aria-live="assertive">
            <span className="text-[96px] leading-none font-bold num">{count}</span>
            <p className="mt-3 px-6 text-[17px]">{kind === 'squat' ? 'カメラに対して横向きに立ってください' : '動き始める準備をしてください'}</p>
          </div>
        )}
        {phase === 'recording' && (
          <div className="absolute inset-x-0 top-2 flex justify-center" role="status" aria-live="polite">
            <span className="flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-[15px] num">
              <span aria-hidden className="size-2.5 animate-pulse rounded-full bg-danger" />
              撮影中 {Math.floor(elapsed / 1000)} 秒（最長 {RECORD_MS / 1000} 秒）
            </span>
          </div>
        )}
      </div>
      <div className="safe-bottom flex flex-col items-center gap-2 px-4 pt-3 pb-4">
        {phase === 'camera' ? (
          <>
            <Button variant="primary" size="lg" block disabled={cam !== 'live'} onClick={start}>
              撮影を始める
            </Button>
            <p className="text-center text-sm text-paper/80">
              押すと {COUNTDOWN_SEC} 秒後に撮り始めます。終わったら「撮り終える」を押してください。
            </p>
          </>
        ) : (
          <Button variant={phase === 'recording' ? 'primary' : 'secondary'} size="lg" block onClick={() => (stopRef.current = true)}>
            {phase === 'countdown' ? 'やめる' : '撮り終える'}
          </Button>
        )}
      </div>
    </div>
  )
}
