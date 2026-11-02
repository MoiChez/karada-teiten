import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { AppDB } from '../src/data/db'
import { repo } from '../src/data/repo'
import { blobToDataUrl, dataUrlToBlob, exportJson, importJson, sessionsToCsv, validateExport } from '../src/data/exportImport'
import { buildSession } from '../src/domain/session'
import { frontPose, record, sidePose } from './helpers'

let n = 0
const freshRepo = () => repo(new AppDB(`test-${Date.now()}-${n++}`))

const makeSession = (createdAt: string) =>
  buildSession({ createdAt, front: record('front', frontPose({ leftShoulderDrop: 20 })), side: record('side', sidePose({ earForward: 30 })), imagesSaved: false, modelVersion: 'full' })

describe('保存と削除', () => {
  it('画像は渡したときだけ保存され、セッション削除で一緒に消える', async () => {
    const r = freshRepo()
    const s = makeSession('2026-10-01T09:00:00.000Z')
    await r.saveSession(s)
    expect((await r.getSession(s.id))!.imagesSaved).toBe(false)
    expect(await r.db.images.count()).toBe(0)

    const s2 = makeSession('2026-10-02T09:00:00.000Z')
    await r.saveSession(s2, { front: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }) })
    const got = (await r.getSession(s2.id))!
    expect(got.imagesSaved).toBe(true)
    expect(got.front!.imageMetadata.imageId).toBe(`${s2.id}_front`)
    expect(await r.db.images.count()).toBe(1)

    await r.deleteSession(s2.id)
    expect(await r.db.images.count()).toBe(0)
    expect(await r.getSession(s2.id)).toBeUndefined()
  })

  it('画像だけを全削除しても、指標は残る', async () => {
    const r = freshRepo()
    const s = makeSession('2026-10-01T09:00:00.000Z')
    await r.saveSession(s, { front: new Blob([new Uint8Array([9])], { type: 'image/jpeg' }) })
    await r.deleteAllImages()
    const got = (await r.getSession(s.id))!
    expect(got.imagesSaved).toBe(false)
    expect(got.computedMetrics.length).toBeGreaterThan(0)
  })

  it('計算ロジックの版が古いセッションは読み込み時に再計算される', async () => {
    const r = freshRepo()
    const s = { ...makeSession('2026-10-01T09:00:00.000Z'), algorithmVersion: 0, computedMetrics: [] }
    await r.db.assessments.put(s)
    const got = (await r.getSession(s.id))!
    expect(got.algorithmVersion).toBeGreaterThan(0)
    expect(got.computedMetrics.length).toBeGreaterThan(0)
  })
})

describe('エクスポートとインポート', () => {
  it('JSON 書き出し → 全削除 → 読み込みで元に戻る（画像も含む）', async () => {
    const r = freshRepo()
    await r.saveProfile({ goals: ['posture'], hasClearGoal: false, lifestyle: ['desk_work'], concernAreas: ['neck'] })
    const s = makeSession('2026-10-01T09:00:00.000Z')
    await r.saveSession(s, { side: new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/jpeg' }) })
    await r.addLog({ id: 'l1', date: '2026-10-02T08:00:00.000Z', routineId: 'chin_tuck', feeling: 'ok' })
    await r.addCheckin({ id: 'c1', date: '2026-10-01T08:00:00.000Z', fatigueRating: 3, discomfortAreas: [] })
    await r.setSetting('saveImages', true)

    const file = JSON.parse(JSON.stringify(await exportJson(r.db, { includeImages: true })))
    expect(validateExport(file)).toEqual([])
    await r.wipeAll()
    expect(await r.db.assessments.count()).toBe(0)

    const res = await importJson(r.db, file, 'replace')
    expect(res.ok).toBe(true)
    expect(res.counts).toEqual({ assessments: 1, routineLogs: 1, checkins: 1, images: 1 })
    const got = (await r.getSession(s.id))!
    expect(got.computedMetrics).toEqual((await r.listSessions())[0].computedMetrics)
    expect(got.side!.imageMetadata.imageId).toBe(`${s.id}_side`)
    const img = (await r.getImage(`${s.id}_side`))!
    expect(new Uint8Array(await img.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect((await r.getProfile())!.lifestyle).toEqual(['desk_work'])
    expect((await r.getSettings()).saveImages).toBe(true)
  })

  it('形式が違うファイルは読み込まず、既存データを変えない', async () => {
    const r = freshRepo()
    const s = makeSession('2026-10-01T09:00:00.000Z')
    await r.saveSession(s)
    const res = await importJson(r.db, { app: 'other', schemaVersion: 1 }, 'replace')
    expect(res.ok).toBe(false)
    expect(res.errors.length).toBeGreaterThan(0)
    expect(await r.db.assessments.count()).toBe(1)
  })

  it('CSV は 1 行 = 1 指標で、BOM 付き', () => {
    const s = makeSession('2026-10-01T09:00:00.000Z')
    const csv = sessionsToCsv([s])
    expect(csv.startsWith('﻿測定日時')).toBe(true)
    const lines = csv.split('\r\n')
    expect(lines.length).toBe(1 + s.computedMetrics.length)
    expect(csv).toContain('front_shoulder_tilt')
  })

  it('Blob と data URL の相互変換', async () => {
    for (const bytes of [[], [1], [1, 2], [1, 2, 3], [255, 0, 128, 64, 32]]) {
      const b = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      const url = await blobToDataUrl(b)
      const back = dataUrlToBlob(url)
      expect(new Uint8Array(await back.arrayBuffer())).toEqual(new Uint8Array(bytes))
      expect(back.type).toBe('image/png')
    }
  })
})
