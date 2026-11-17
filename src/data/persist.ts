// 記録を消されにくくする。ブラウザは空きが少なくなると、サイトのデータを断りなく消すことがあるので、
// 記録を保存したときに「このサイトのデータは消さないで」と頼む（navigator.storage.persist）。
// 頼めるかどうか・聞き入れるかどうかはブラウザ次第で、失敗しても保存そのものには関わらない
import type { AppSettings } from '../domain/types'
import { db as defaultDb, type AppDB } from './db'

export type PersistState = 'persisted' | 'not-persisted' | 'unsupported'

/** 消されにくい保存になっているかを確かめ、なっていなければ頼む。例外は外に出さない */
export async function ensurePersisted(): Promise<PersistState> {
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
    if (!storage || typeof storage.persisted !== 'function') return 'unsupported'
    if (await storage.persisted()) return 'persisted'
    if (typeof storage.persist !== 'function') return 'not-persisted'
    return (await storage.persist()) ? 'persisted' : 'not-persisted'
  } catch {
    return 'unsupported'
  }
}

// ---------- 1 回だけ出す案内 ----------

export const STORAGE_NOTICE = '記録はこのスマホの中にだけあります。ホーム画面に追加しておくと消えにくくなります。ブラウザの履歴やサイトのデータを消すと、記録も消えます。'

/** 案内を出したかを残す設定のキー（AppSettings には含めない、画面の設定ではない値） */
const NOTICE_KEY = 'storageNotice' as keyof AppSettings

/** 保存の案内を、もう出したか */
export async function storageNoticeShown(db: AppDB = defaultDb): Promise<boolean> {
  const row = await db.settings.get(NOTICE_KEY)
  return row?.value === true
}

/** 保存の案内を出したことを残す */
export async function markStorageNoticeShown(db: AppDB = defaultDb): Promise<void> {
  await db.settings.put({ key: NOTICE_KEY, value: true })
}

// ---------- iPhone ----------

export const IOS_NOTE = 'iPhone での動作は、まだ確かめている途中です。うまく撮れないときは、写真や動画を選んで測ることもできます。'

/** iPhone・iPad か。iPadOS 13 以降の Safari は Mac と同じ userAgent を名乗るので、触れる点の数で見分ける */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent ?? ''
  if (/iPhone|iPad|iPod/.test(ua)) return true
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
}
