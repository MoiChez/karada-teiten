// 画面をまたぐ状態。撮影中の下書き（メモリのみ）と設定
import { create } from 'zustand'
import type { AppSettings, CheckIn, Plane, PlaneRecord } from '../domain/types'
import { DEFAULT_SETTINGS } from '../data/db'
import { data } from '../data/repo'

export interface PlaneDraft {
  record: PlaneRecord
  imageBlob: Blob
  imageUrl: string
}

interface DraftState {
  front?: PlaneDraft
  side?: PlaneDraft
  checkin?: CheckIn
  /** 保存済みセッションを補正し直している場合の ID */
  editingSessionId?: string
  setPlane: (plane: Plane, draft: PlaneDraft) => void
  updateRecord: (plane: Plane, record: PlaneRecord) => void
  removePlane: (plane: Plane) => void
  setCheckin: (c: CheckIn | undefined) => void
  setEditing: (id: string | undefined) => void
  clear: () => void
}

export const useDraft = create<DraftState>((set, get) => ({
  setPlane: (plane, draft) => {
    const prev = get()[plane]
    if (prev && prev.imageUrl !== draft.imageUrl) URL.revokeObjectURL(prev.imageUrl)
    set({ [plane]: draft })
  },
  updateRecord: (plane, record) => {
    const d = get()[plane]
    if (d) set({ [plane]: { ...d, record } })
  },
  removePlane: (plane) => {
    const d = get()[plane]
    if (d) URL.revokeObjectURL(d.imageUrl)
    set({ [plane]: undefined })
  },
  setCheckin: (checkin) => set({ checkin }),
  setEditing: (editingSessionId) => set({ editingSessionId }),
  clear: () => {
    const { front, side } = get()
    if (front) URL.revokeObjectURL(front.imageUrl)
    if (side) URL.revokeObjectURL(side.imageUrl)
    set({ front: undefined, side: undefined, checkin: undefined, editingSessionId: undefined })
  },
}))

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
