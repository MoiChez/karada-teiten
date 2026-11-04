// IndexedDB（Dexie）。データはこの端末のブラウザの中にだけ保存される
import Dexie, { type EntityTable } from 'dexie'
import type {
  AppSettings,
  AssessmentSession,
  CheckIn,
  Plane,
  RecommendationPlan,
  RoutineLog,
  UserProfile,
} from '../domain/types'

export interface StoredImage {
  id: string
  assessmentId: string
  plane: Plane
  blob: Blob
  width: number
  height: number
  createdAt: string
}

export interface SettingRow {
  key: keyof AppSettings
  value: unknown
}

export class AppDB extends Dexie {
  profile!: EntityTable<UserProfile, 'id'>
  assessments!: EntityTable<AssessmentSession, 'id'>
  images!: EntityTable<StoredImage, 'id'>
  routineLogs!: EntityTable<RoutineLog, 'id'>
  checkins!: EntityTable<CheckIn, 'id'>
  plans!: EntityTable<RecommendationPlan, 'id'>
  settings!: EntityTable<SettingRow, 'key'>

  constructor(name = 'karada-teiten') {
    super(name)
    this.version(1).stores({
      profile: 'id',
      assessments: 'id, createdAt',
      images: 'id, assessmentId',
      routineLogs: 'id, date, routineId',
      checkins: 'id, date',
      plans: 'id, generatedAt, basedOnAssessmentId',
      settings: 'key',
    })
  }
}

export const db = new AppDB()

export const DEFAULT_SETTINGS: AppSettings = {
  saveImages: false,
  timerSec: 5,
  captureMode: 'precise',
  onboarded: false,
}
