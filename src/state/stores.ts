// 画面をまたぐ状態。撮影中の下書き（メモリのみ）と設定
import { create } from 'zustand'
import type { AppSettings, CaptureMode, CheckIn, Plane, PlaneRecord } from '../domain/types'
import { DEFAULT_SETTINGS } from '../data/db'
import { data } from '../data/repo'

export interface PlaneDraft {
  record: PlaneRecord
  /** 代表の写真（保存・表示に使う） */
  imageBlob: Blob
  imageUrl: string
  /** 撮影について利用者に伝えること（平均に使えなかった枚数など） */
  notice?: string
}

/** いつもの姿勢（通常の測定）か、意識した姿勢（測定済みのセッションに追加する）か */
export type Pose = 'habitual' | 'conscious'

interface ConsciousDraft {
  /** 意識した姿勢を追加するセッション */
  sessionId?: string
  front?: PlaneDraft
  side?: PlaneDraft
}

interface DraftState {
  front?: PlaneDraft
  side?: PlaneDraft
  checkin?: CheckIn
  /** 保存済みセッションを補正し直している場合の ID */
  editingSessionId?: string
  /** いつもの姿勢の測定のモード（撮影ガイドで選ぶ） */
  mode: CaptureMode
  conscious: ConsciousDraft
  setMode: (m: CaptureMode) => void
  setPlane: (plane: Plane, draft: PlaneDraft, pose?: Pose) => void
  updateRecord: (plane: Plane, record: PlaneRecord, pose?: Pose) => void
  removePlane: (plane: Plane) => void
  setCheckin: (c: CheckIn | undefined) => void
  setEditing: (id: string | undefined) => void
  /** 意識した姿勢の撮影を始める（前の下書きは捨てる） */
  startConscious: (sessionId: string) => void
  clear: () => void
}

const revoke = (d: PlaneDraft | undefined) => d && URL.revokeObjectURL(d.imageUrl)

export const useDraft = create<DraftState>((set, get) => ({
  mode: 'precise',
  conscious: {},
  setMode: (mode) => set({ mode }),
  setPlane: (plane, draft, pose = 'habitual') => {
    const prev = pose === 'habitual' ? get()[plane] : get().conscious[plane]
    if (prev && prev.imageUrl !== draft.imageUrl) URL.revokeObjectURL(prev.imageUrl)
    if (pose === 'habitual') set({ [plane]: draft })
    else set({ conscious: { ...get().conscious, [plane]: draft } })
  },
  updateRecord: (plane, record, pose = 'habitual') => {
    const d = pose === 'habitual' ? get()[plane] : get().conscious[plane]
    if (!d) return
    if (pose === 'habitual') set({ [plane]: { ...d, record } })
    else set({ conscious: { ...get().conscious, [plane]: { ...d, record } } })
  },
  removePlane: (plane) => {
    revoke(get()[plane])
    set({ [plane]: undefined })
  },
  setCheckin: (checkin) => set({ checkin }),
  setEditing: (editingSessionId) => set({ editingSessionId }),
  startConscious: (sessionId) => {
    const c = get().conscious
    revoke(c.front)
    revoke(c.side)
    set({ conscious: { sessionId } })
  },
  clear: () => {
    const { front, side, conscious } = get()
    revoke(front)
    revoke(side)
    revoke(conscious.front)
    revoke(conscious.side)
    set({ front: undefined, side: undefined, checkin: undefined, editingSessionId: undefined, conscious: {} })
  },
}))

/** 姿勢と面に対応する下書き */
export function usePlaneDraft(pose: Pose, plane: Plane): PlaneDraft | undefined {
  return useDraft((s) => (pose === 'habitual' ? s[plane] : s.conscious[plane]))
}

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  storageError?: string
  load: () => Promise<void>
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    try {
      const settings = await data.getSettings()
      set({ settings, loaded: true })
    } catch (e) {
      set({ loaded: true, storageError: e instanceof Error ? e.message : String(e) })
    }
  },
  update: async (key, value) => {
    set({ settings: { ...get().settings, [key]: value } })
    await data.setSetting(key, value)
  },
}))

interface ToastState {
  message?: string
  show: (m: string) => void
  hide: () => void
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
export const useToast = create<ToastState>((set) => ({
  show: (message) => {
    set({ message })
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => set({ message: undefined }), 4000)
  },
  hide: () => set({ message: undefined }),
}))

// 開発時のみ: ブラウザのコンソールから状態を確認・操作できるようにする（本番ビルドには含まれない）
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__stores = { useDraft, useSettings }
}
