import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDB } from '../src/data/db'
import { repo } from '../src/data/repo'
import { ensurePersisted, isIOS, markStorageNoticeShown, storageNoticeShown } from '../src/data/persist'

afterEach(() => {
  vi.unstubAllGlobals()
})

const stubStorage = (storage: unknown) => vi.stubGlobal('navigator', { userAgent: 'test', maxTouchPoints: 0, storage })

describe('記録を消されにくくする', () => {
  it('navigator.storage がなければ unsupported', async () => {
    stubStorage(undefined)
    expect(await ensurePersisted()).toBe('unsupported')
  })

  it('navigator そのものがなくても unsupported', async () => {
    vi.stubGlobal('navigator', undefined)
    expect(await ensurePersisted()).toBe('unsupported')
  })

  it('もう消されにくくなっていれば、persist を呼ばない', async () => {
    const persist = vi.fn(async () => true)
    stubStorage({ persisted: vi.fn(async () => true), persist })
    expect(await ensurePersisted()).toBe('persisted')
    expect(persist).not.toHaveBeenCalled()
  })

  it('まだなら persist を呼び、その答えを返す', async () => {
    const granted = vi.fn(async () => true)
    stubStorage({ persisted: vi.fn(async () => false), persist: granted })
    expect(await ensurePersisted()).toBe('persisted')
    expect(granted).toHaveBeenCalledTimes(1)

    const denied = vi.fn(async () => false)
    stubStorage({ persisted: vi.fn(async () => false), persist: denied })
    expect(await ensurePersisted()).toBe('not-persisted')
    expect(denied).toHaveBeenCalledTimes(1)
  })

  it('例外は外に出さず unsupported', async () => {
    stubStorage({ persisted: vi.fn(async () => Promise.reject(new Error('blocked'))), persist: vi.fn() })
    expect(await ensurePersisted()).toBe('unsupported')
  })

  it('記録を保存すると頼み、頼むのに失敗しても保存は成功する', async () => {
    const persist = vi.fn(async () => Promise.reject(new Error('blocked')))
    stubStorage({ persisted: vi.fn(async () => false), persist })
    const r = repo(new AppDB(`persist-${Date.now()}`))
    const rec = {
      id: 'm_persist',
      createdAt: '2026-11-13T10:00:00.000Z',
      appVersion: 'test',
      kind: 'squat' as const,
      source: 'upload' as const,
      modelVersion: 'test',
      video: { width: 100, height: 100, durationMs: 0, frameCount: 0, fps: 30, quarterTurns: 0 },
      videoSaved: false,
      frames: [],
      analysis: { algorithmVersion: 0, kind: 'squat' as const, facing: 'left' as const, nearSide: 'left' as const, validFrames: 0, cycles: [], metrics: [], warnings: [] },
    }
    await expect(r.saveMotion(rec)).resolves.toBeUndefined()
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
    expect(await r.db.motions.count()).toBe(1)
  })
})

describe('保存の案内', () => {
  it('1 回出したら、出したことを残す', async () => {
    const db = new AppDB(`notice-${Date.now()}`)
    expect(await storageNoticeShown(db)).toBe(false)
    await markStorageNoticeShown(db)
    expect(await storageNoticeShown(db)).toBe(true)
  })
})

describe('iPhone の判定', () => {
  const ua = (userAgent: string, maxTouchPoints = 0) => vi.stubGlobal('navigator', { userAgent, maxTouchPoints })
  it('iPhone と、Mac を名乗る iPad を iOS とみなし、Mac と Android はみなさない', () => {
    ua('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')
    expect(isIOS()).toBe(true)
    ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 5)
    expect(isIOS()).toBe(true)
    ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 0)
    expect(isIOS()).toBe(false)
    ua('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', 5)
    expect(isIOS()).toBe(false)
  })
})
