// データの読み書き。画面からはここを通して DB を使う
import type { AppDB, StoredImage } from './db'
import { DEFAULT_SETTINGS, db as defaultDb } from './db'
import type { AppSettings, AssessmentSession, CheckIn, RecommendationPlan, RoutineLog, UserProfile } from '../domain/types'
import { ALGORITHM_VERSION } from '../domain/constants'
import { recomputeSession } from '../domain/session'
import { upgradeGait, type GaitRecord } from '../domain/gait'

export function repo(db: AppDB = defaultDb) {
  return {
    db,

    // ---- 設定 ----
    async getSettings(): Promise<AppSettings> {
      const rows = await db.settings.toArray()
      const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>
      for (const r of rows) out[r.key] = r.value
      return out as unknown as AppSettings
    },
    async setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
      await db.settings.put({ key, value })
    },

    // ---- プロフィール ----
    getProfile: () => db.profile.get('me'),
    async saveProfile(p: Omit<UserProfile, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<UserProfile, 'createdAt'>>) {
      const now = new Date().toISOString()
      const existing = await db.profile.get('me')
      const profile: UserProfile = { ...p, id: 'me', createdAt: existing?.createdAt ?? p.createdAt ?? now, updatedAt: now }
      await db.profile.put(profile)
      return profile
    },

    // ---- 測定 ----
    async listSessions(): Promise<AssessmentSession[]> {
      const list = await db.assessments.orderBy('createdAt').reverse().toArray()
      return Promise.all(list.map((s) => this.upgrade(s)))
    },
    async getSession(id: string) {
      const s = await db.assessments.get(id)
      return s ? this.upgrade(s) : undefined
    },
    /** 計算ロジックの版が古ければ、保存済みのランドマークから再計算して保存し直す */
    async upgrade(s: AssessmentSession): Promise<AssessmentSession> {
      if (s.algorithmVersion === ALGORITHM_VERSION) return s
      const next = recomputeSession(s)
      await db.assessments.put(next)
      return next
    },
    /** 起動時に一度だけ: 古い版のセッションをまとめて再計算する */
    async upgradeAll() {
      const list = await db.assessments.toArray()
      for (const s of list) await this.upgrade(s)
    },
    async saveSession(s: AssessmentSession, images?: { front?: Blob; side?: Blob }) {
      await db.transaction('rw', db.assessments, db.images, async () => {
        const copy: AssessmentSession = structuredClone(s)
        for (const plane of ['front', 'side'] as const) {
          const blob = images?.[plane]
          const rec = copy[plane]
          if (!blob || !rec) continue
          const id = `${s.id}_${plane}`
          await db.images.put({
            id,
            assessmentId: s.id,
            plane,
            blob,
            width: rec.imageMetadata.width,
            height: rec.imageMetadata.height,
            createdAt: s.createdAt,
          })
          rec.imageMetadata.imageId = id
        }
        copy.imagesSaved = !!(copy.front?.imageMetadata.imageId || copy.side?.imageMetadata.imageId)
        await db.assessments.put(copy)
      })
    },
    async updateSession(s: AssessmentSession) {
      await db.assessments.put(s)
    },
    /** 「意識した姿勢」を付けたセッションを保存する。写真は渡したときだけ保存（id は <セッション>_conscious_<面>） */
    async saveConscious(s: AssessmentSession, images?: { front?: Blob; side?: Blob }) {
      await db.transaction('rw', db.assessments, db.images, async () => {
        const copy: AssessmentSession = structuredClone(s)
        // いつもの姿勢の写真の参照は、保存済みのものを引き継ぐ（古いコピーを渡されても消さない）
        const stored = await db.assessments.get(s.id)
        for (const plane of ['front', 'side'] as const) {
          const id = stored?.[plane]?.imageMetadata.imageId
          if (id && copy[plane]) copy[plane]!.imageMetadata.imageId = id
        }
        if (stored) copy.imagesSaved = stored.imagesSaved
        // 撮り直したときは、前の意識した姿勢の写真を消す
        const old = await db.images.where('assessmentId').equals(s.id).filter((im) => im.id.includes('_conscious_')).primaryKeys()
        await db.images.bulkDelete(old)
        for (const plane of ['front', 'side'] as const) {
          const rec = copy.conscious?.[plane]
          if (!rec) continue
          delete rec.imageMetadata.imageId
          const blob = images?.[plane]
          if (!blob) continue
          const id = `${s.id}_conscious_${plane}`
          await db.images.put({ id, assessmentId: s.id, plane, blob, width: rec.imageMetadata.width, height: rec.imageMetadata.height, createdAt: copy.conscious!.capturedAt })
          rec.imageMetadata.imageId = id
        }
        await db.assessments.put(copy)
      })
    },
    async deleteSession(id: string) {
      await db.transaction('rw', db.assessments, db.images, async () => {
        await db.images.where('assessmentId').equals(id).delete()
        await db.assessments.delete(id)
      })
    },
    getImage: (id: string): Promise<StoredImage | undefined> => db.images.get(id),
    /** 保存済みの画像をすべて削除する（ランドマークと指標は残す） */
    async deleteAllImages() {
      await db.transaction('rw', db.assessments, db.images, async () => {
        await db.images.clear()
        const all = await db.assessments.toArray()
        for (const s of all) {
          if (s.front) delete s.front.imageMetadata.imageId
          if (s.side) delete s.side.imageMetadata.imageId
          if (s.conscious?.front) delete s.conscious.front.imageMetadata.imageId
          if (s.conscious?.side) delete s.conscious.side.imageMetadata.imageId
          s.imagesSaved = false
        }
        await db.assessments.bulkPut(all)
      })
    },

    // ---- 歩き方 ----
    async listGaits(): Promise<GaitRecord[]> {
      const list = await db.gaits.orderBy('createdAt').reverse().toArray()
      return list.map(upgradeGait)
    },
    async getGait(id: string) {
      const r = await db.gaits.get(id)
      return r ? upgradeGait(r) : undefined
    },
    saveGait: (r: GaitRecord) => db.gaits.put(r),
    deleteGait: (id: string) => db.gaits.delete(id),

    // ---- 記録 ----
    addLog: (l: RoutineLog) => db.routineLogs.put(l),
    listLogs: () => db.routineLogs.orderBy('date').toArray(),
    deleteLog: (id: string) => db.routineLogs.delete(id),
    addCheckin: (c: CheckIn) => db.checkins.put(c),
    listCheckins: () => db.checkins.orderBy('date').toArray(),
    savePlan: (p: RecommendationPlan) => db.plans.put(p),

    // ---- すべて削除 ----
    async wipeAll() {
      await db.transaction('rw', [db.profile, db.assessments, db.images, db.routineLogs, db.checkins, db.plans, db.settings, db.gaits], async () => {
        await Promise.all([
          db.gaits.clear(),
          db.profile.clear(),
          db.assessments.clear(),
          db.images.clear(),
          db.routineLogs.clear(),
          db.checkins.clear(),
          db.plans.clear(),
          db.settings.clear(),
        ])
      })
    },
  }
}

export const data = repo()
