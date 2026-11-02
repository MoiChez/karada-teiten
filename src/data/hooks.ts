// 画面から使う読み取り専用のフック（IndexedDB の変更を自動で反映）
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'

export const useSessions = () => useLiveQuery(() => db.assessments.orderBy('createdAt').reverse().toArray(), [])

export const useSession = (id: string | undefined) => useLiveQuery(() => (id ? db.assessments.get(id) : undefined), [id])

export const useProfile = () => useLiveQuery(async () => (await db.profile.get('me')) ?? null, [])

export const useLogs = () => useLiveQuery(() => db.routineLogs.orderBy('date').toArray(), [])

export const useCheckins = () => useLiveQuery(() => db.checkins.orderBy('date').toArray(), [])
