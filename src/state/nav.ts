// 画面の「戻る」を、来た画面へ戻すための記録。
// 閲覧履歴の各位置（history.state.idx）に、その時の画面の道すじを覚えておく（このタブの中だけ）。
// 1 つ前が撮影の途中の画面（測る・撮る・分析中）なら、そこへは戻らず、決まった画面へ移る
import { useEffect } from 'react'
import { useLocation } from 'react-router'

const KEY = 'kt.navStack'
const FLOW = /^\/(measure\/|motion\/capture|onboarding)/

function read(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function idxNow(): number | null {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx
  return typeof idx === 'number' ? idx : null
}

/** ルーターの中に 1 つ置く。画面が変わるたびに、今の位置の道すじを記録する */
export function NavRecorder() {
  const loc = useLocation()
  useEffect(() => {
    const idx = idxNow()
    if (idx === null) return
    const m = read()
    m[idx] = loc.pathname
    try {
      sessionStorage.setItem(KEY, JSON.stringify(m))
    } catch {
      // 保存できなくても、戻るは決まった画面へ移るだけ
    }
  }, [loc.key, loc.pathname])
  return null
}

/** 1 つ前の画面へ戻ってよいか（アプリの中から来ていて、そこが撮影の途中の画面でない） */
export function canGoBack(): boolean {
  const idx = idxNow()
  if (idx === null || idx <= 0) return false
  const prev = read()[idx - 1]
  return !!prev && !FLOW.test(prev)
}
