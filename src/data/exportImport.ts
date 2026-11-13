// エクスポート（JSON / CSV）とインポート（JSON）
import type { AppDB, StoredImage } from './db'
import type { AssessmentSession, CheckIn, RecommendationPlan, RoutineLog, UserProfile } from '../domain/types'
import type { MotionRecord } from '../domain/motion'
import { fmtDate } from '../domain/format'

export const SCHEMA_VERSION = 1
const APP_ID = 'karada-teiten'

export interface ExportedImage {
  id: string
  assessmentId: string
  plane: 'front' | 'side'
  width: number
  height: number
  createdAt: string
  dataUrl: string
}

export interface ExportFile {
  app: typeof APP_ID
  schemaVersion: number
  exportedAt: string
  profile: UserProfile | null
  assessments: AssessmentSession[]
  routineLogs: RoutineLog[]
  checkins: CheckIn[]
  plans: RecommendationPlan[]
  settings: { key: string; value: unknown }[]
  images: ExportedImage[]
  /** 動きの記録（版 0.11 から。体の点の動きだけで、動画は含めない。ないファイルもある） */
  motions?: MotionRecord[]
}

export async function exportJson(db: AppDB, opts: { includeImages: boolean }): Promise<ExportFile> {
  const [profile, assessments, routineLogs, checkins, plans, settings, images, motions] = await Promise.all([
    db.profile.get('me'),
    db.assessments.orderBy('createdAt').toArray(),
    db.routineLogs.toArray(),
    db.checkins.toArray(),
    db.plans.toArray(),
    db.settings.toArray(),
    opts.includeImages ? db.images.toArray() : Promise.resolve([] as StoredImage[]),
    db.motions.orderBy('createdAt').toArray(),
  ])
  return {
    app: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    profile: profile ?? null,
    assessments,
    routineLogs,
    checkins,
    plans,
    settings,
    images: await Promise.all(
      images.map(async (im) => ({
        id: im.id,
        assessmentId: im.assessmentId,
        plane: im.plane,
        width: im.width,
        height: im.height,
        createdAt: im.createdAt,
        dataUrl: await blobToDataUrl(im.blob),
      })),
    ),
    // 動画は書き出さないので、読み込んだ先では「残していない」扱いにする
    motions: motions.map((m) => ({ ...m, videoSaved: false })),
  }
}

export interface ImportResult {
  ok: boolean
  errors: string[]
  counts?: { assessments: number; routineLogs: number; checkins: number; images: number }
}

/** 形式を確かめる。問題があれば、どこが不正かを返す */
export function validateExport(raw: unknown): string[] {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object') return ['JSON の形式ではありません']
  const f = raw as Record<string, unknown>
  if (f.app !== APP_ID) errors.push('このアプリから書き出したファイルではありません（app が違います）')
  if (typeof f.schemaVersion !== 'number') errors.push('schemaVersion がありません')
  else if (f.schemaVersion > SCHEMA_VERSION) errors.push(`新しい版のアプリで書き出したファイルです（schemaVersion ${f.schemaVersion}）`)
  for (const k of ['assessments', 'routineLogs', 'checkins', 'plans', 'settings', 'images']) {
    if (!Array.isArray(f[k])) errors.push(`${k} が配列ではありません`)
  }
  if (Array.isArray(f.assessments)) {
    f.assessments.forEach((s: unknown, i: number) => {
      const a = s as Partial<AssessmentSession>
      if (!a || typeof a.id !== 'string') errors.push(`assessments[${i}] に id がありません`)
      else if (typeof a.createdAt !== 'string') errors.push(`assessments[${i}] に createdAt がありません`)
      else if (!Array.isArray(a.computedMetrics)) errors.push(`assessments[${i}] に computedMetrics がありません`)
    })
  }
  if (f.motions !== undefined && !Array.isArray(f.motions)) errors.push('motions が配列ではありません')
  if (f.profile !== null && f.profile !== undefined) {
    const p = f.profile as Partial<UserProfile>
    if (p.id !== 'me' || !Array.isArray(p.goals)) errors.push('profile の形式が正しくありません')
  }
  return errors
}

/** インポート。replace: 今のデータを消して置き換える / merge: 同じ id は上書き、他は残す */
export async function importJson(db: AppDB, raw: unknown, mode: 'replace' | 'merge'): Promise<ImportResult> {
  const errors = validateExport(raw)
  if (errors.length) return { ok: false, errors }
  const f = raw as ExportFile
  const images: StoredImage[] = []
  for (const im of f.images) {
    try {
      images.push({ id: im.id, assessmentId: im.assessmentId, plane: im.plane, width: im.width, height: im.height, createdAt: im.createdAt, blob: dataUrlToBlob(im.dataUrl) })
    } catch {
      return { ok: false, errors: [`画像 ${im.id} を読み込めませんでした`] }
    }
  }
  await db.transaction('rw', [db.profile, db.assessments, db.images, db.routineLogs, db.checkins, db.plans, db.settings, db.motions, db.motionVideos], async () => {
    if (mode === 'replace') {
      await Promise.all([db.motions.clear(), db.motionVideos.clear(), db.profile.clear(), db.assessments.clear(), db.images.clear(), db.routineLogs.clear(), db.checkins.clear(), db.plans.clear(), db.settings.clear()])
    }
    if (f.profile) await db.profile.put(f.profile)
    await db.assessments.bulkPut(f.assessments)
    await db.routineLogs.bulkPut(f.routineLogs)
    await db.checkins.bulkPut(f.checkins)
    await db.plans.bulkPut(f.plans)
    await db.settings.bulkPut(f.settings as never)
    await db.images.bulkPut(images)
    if (f.motions) await db.motions.bulkPut(f.motions.map((m) => ({ ...m, videoSaved: false })))
  })
  return {
    ok: true,
    errors: [],
    counts: { assessments: f.assessments.length, routineLogs: f.routineLogs.length, checkins: f.checkins.length, images: images.length },
  }
}

// ---------- CSV ----------

const CSV_HEADER = [
  '測定日時',
  'セッションID',
  '面',
  '指標キー',
  '指標名',
  '値',
  '単位',
  '正規化値',
  '正規化の単位',
  'ばらつきの目安(1σ)',
  '判定',
  '信頼度',
  '補正した点',
  '向き',
  '備考',
]

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function sessionsToCsv(sessions: AssessmentSession[]): string {
  const rows = [CSV_HEADER]
  for (const s of [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    for (const m of s.computedMetrics) {
      rows.push([
        fmtDate(s.createdAt, true),
        s.id,
        m.plane === 'front' ? '正面' : '側面',
        m.key,
        m.label,
        m.rawValue === null ? '' : String(m.rawValue),
        m.unit,
        m.normalizedValue === null ? '' : String(m.normalizedValue),
        m.normalizedUnit ?? '',
        m.uncertainty === null ? '' : String(m.uncertainty),
        m.status,
        String(m.confidence),
        m.correctedLandmarks.join(' '),
        m.direction,
        m.qualityNote ?? '',
      ])
    }
  }
  // Excel で文字化けしないよう BOM を付ける
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
}

// ---------- Blob と data URL ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? B64[n & 63] : '='
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${out}`
}

export function dataUrlToBlob(url: string): Blob {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url)
  if (!m || !m[2]) throw new Error('invalid data url')
  const bin = atob(m[3])
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: m[1] || 'application/octet-stream' })
}
