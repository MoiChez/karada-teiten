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
import type { MotionRecord } from '../domain/motion'

export interface StoredImage {
  id: string
  assessmentId: string
  plane: Plane
  blob: Blob
  width: number
  height: number
  createdAt: string
}

/** 動きの記録の動画（コマの画像）。残すと選んだときだけ保存する */
export interface StoredMotionVideo {
  id: string
  width: number
  height: number
  images: { t: number; blob: Blob }[]
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
  motions!: EntityTable<MotionRecord, 'id'>
  motionVideos!: EntityTable<StoredMotionVideo, 'id'>

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
    // 版 0.8: 歩き方の記録
    this.version(2).stores({
      gaits: 'id, createdAt',
    })
    // 版 0.11: 歩き方をやめ、動き（スクワット）の記録にする
    this.version(3).stores({
      gaits: null,
      motions: 'id, createdAt',
      motionVideos: 'id',
    })
  }
}

export const db = new AppDB()

export const DEFAULT_SETTINGS: AppSettings = {
  saveImages: false,
  timerSec: 5,
  shootStyle: 'placed',
  onboarded: false,
}
