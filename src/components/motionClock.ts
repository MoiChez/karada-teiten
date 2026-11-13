// 動画・3D・グラフで同じ時刻を指すための時計。再生中は画面の描き換えに合わせて進め、終わりまで来たら最初に戻る
import { useEffect, useState, useSyncExternalStore } from 'react'

export interface Clock {
  readonly start: number
  readonly end: number
  /** 今の時刻（ミリ秒） */
  get(): number
  set(t: number): void
  isPlaying(): boolean
  play(): void
  pause(): void
  getSpeed(): number
  setSpeed(s: number): void
  subscribe(fn: () => void): () => void
}

export function createClock(start: number, end: number): Clock {
  let t = start
  let playing = false
  let speed = 1
  let raf = 0
  let last = 0
  const subs = new Set<() => void>()
  const emit = () => subs.forEach((f) => f())
  const span = Math.max(1, end - start)
  const clamp = (v: number) => Math.min(end, Math.max(start, v))
  const tick = (now: number) => {
    if (!playing) return
    const dt = last ? Math.min(100, now - last) : 0
    last = now
    t += dt * speed
    if (t > end) t = start + ((t - start) % span)
    emit()
    raf = requestAnimationFrame(tick)
  }
  return {
    start,
    end,
    get: () => t,
    set(v) {
      t = clamp(v)
      emit()
    },
    isPlaying: () => playing,
    play() {
      if (playing) return
      if (t >= end) t = start
      playing = true
      last = 0
      raf = requestAnimationFrame(tick)
      emit()
    },
    pause() {
      if (!playing) return
      playing = false
      cancelAnimationFrame(raf)
      emit()
    },
    getSpeed: () => speed,
    setSpeed(s) {
      speed = s
      emit()
    },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}

/** 区間ごとに 1 つの時計を作り、画面を離れたら止める */
export function useClock(start: number, end: number): Clock {
  const [clock] = useState(() => createClock(start, end))
  useEffect(() => () => clock.pause(), [clock])
  return clock
}

/** 時計の値を画面に出す（変わるたびに描き直す） */
export function useClockValue<T>(clock: Clock, read: (c: Clock) => T): T {
  return useSyncExternalStore(clock.subscribe, () => read(clock))
}

/** 並んだ時刻 ts（昇順）のうち、t 以下でいちばん近いものの位置 */
export function indexAt(ts: number[], t: number): number {
  if (!ts.length) return -1
  if (t <= ts[0]) return 0
  let lo = 0
  let hi = ts.length - 1
  if (t >= ts[hi]) return hi
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (ts[m] <= t) lo = m
    else hi = m
  }
  return lo
}
