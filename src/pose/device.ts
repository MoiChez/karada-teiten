// 端末の傾き（撮影時の水準器）と、タイマーの音
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceTilt } from '../domain/types'

type IOSOrientation = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> }

export function useDeviceTilt() {
  const [tilt, setTilt] = useState<DeviceTilt | null>(null)
  const ios = typeof DeviceOrientationEvent !== 'undefined' && typeof (DeviceOrientationEvent as IOSOrientation).requestPermission === 'function'
  const [granted, setGranted] = useState(!ios)
  const latest = useRef<DeviceTilt | null>(null)

  useEffect(() => {
    if (!granted || typeof window === 'undefined') return
    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return
      const t = { rollDeg: Math.round(e.gamma * 10) / 10, pitchDeg: Math.round(e.beta * 10) / 10 }
      latest.current = t
      setTilt(t)
    }
    window.addEventListener('deviceorientation', onOrient)
    return () => window.removeEventListener('deviceorientation', onOrient)
  }, [granted])

  const request = useCallback(async () => {
    if (!ios) return
    try {
      const r = await (DeviceOrientationEvent as IOSOrientation).requestPermission!()
      setGranted(r === 'granted')
    } catch {
      setGranted(false)
    }
  }, [ios])

  return { tilt, latest, needsPermission: ios && !granted, request }
}

let audio: AudioContext | null = null
export function beep(freq = 880, ms = 90) {
  try {
    audio ??= new AudioContext()
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.frequency.value = freq
    gain.gain.value = 0.08
    osc.connect(gain).connect(audio.destination)
    osc.start()
    osc.stop(audio.currentTime + ms / 1000)
  } catch {
    // 音が出せなくても撮影は続ける
  }
}

export function vibrate(ms: number | number[]) {
  try {
    navigator.vibrate?.(ms)
  } catch {
    // 非対応
  }
}
