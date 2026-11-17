import { describe, expect, it } from 'vitest'
import { MP_FROM_HALPE, RTM_H, RTM_W, cropBox, decodeSimcc, mergeRtm, toImage } from '../src/pose/rtmMerge'
import type { Landmark } from '../src/domain/types'

const body = (): Landmark[] => Array.from({ length: 33 }, (_, i) => ({ x: 0.4 + (i % 5) * 0.02, y: 0.1 + i * 0.02, z: i * 0.01, visibility: 0.9, presence: 0.95 }))

describe('RTMPose の点で MediaPipe の点を細かくする', () => {
  it('切り抜く範囲は、点の範囲を 1.25 倍に広げ、縦横比を 192:256 にそろえる', () => {
    const b = cropBox(body(), 1000, 2000)!
    expect(b.w / b.h).toBeCloseTo(RTM_W / RTM_H, 6)
    // 縦長の体なので、高さは点の範囲（y 0.1〜0.74 → 1280px）の 1.25 倍
    expect(b.h).toBeCloseTo(0.64 * 2000 * 1.25, 3)
  })

  it('SimCC は、いちばん大きいところを 2 で割った位置。点数は横と縦の小さい方', () => {
    const k = 2
    const sx = new Float32Array(k * 384)
    const sy = new Float32Array(k * 512)
    sx[0 * 384 + 100] = 0.8
    sy[0 * 512 + 300] = 0.6
    sx[1 * 384 + 7] = 0.2
    sy[1 * 512 + 9] = 0.9
    const p = decodeSimcc(sx, sy, k)
    expect(p[0]).toEqual({ x: 50, y: 150, score: expect.closeTo(0.6, 6) })
    expect(p[1].x).toBe(3.5)
    expect(p[1].score).toBeCloseTo(0.2, 6)
  })

  it('切り抜いた絵の上の位置を、元の絵の 0..1 の位置に戻す', () => {
    const box = { cx: 500, cy: 1000, w: 600, h: 800 }
    const [q] = toImage([{ x: RTM_W / 2, y: RTM_H / 2, score: 1 }], box, 1000, 2000)
    expect(q.x).toBeCloseTo(0.5, 6)
    expect(q.y).toBeCloseTo(0.5, 6)
    const [r] = toImage([{ x: 0, y: 0, score: 1 }], box, 1000, 2000)
    expect(r.x).toBeCloseTo(0.2, 6)
    expect(r.y).toBeCloseTo(0.3, 6)
  })

  it('対応する点の 2D だけを置き換え、奥行き・見えている度合いは残す。点数の低い点は置き換えない', () => {
    const mp = body()
    const rtm = Array.from({ length: 26 }, (_, h) => ({ x: 0.1 + h * 0.01, y: 0.9 - h * 0.01, score: h === 13 ? 0.1 : 0.8 }))
    const { landmarks, replaced } = mergeRtm(mp, rtm)
    // 左膝（MediaPipe 25 ← Halpe 13）は点数が低いので、そのまま
    expect(landmarks[25].x).toBe(mp[25].x)
    expect(replaced).toBe(MP_FROM_HALPE.length - 1)
    // 右肩（12 ← 6）は置き換わる。奥行きと見えている度合いは MediaPipe のまま
    expect(landmarks[12].x).toBeCloseTo(0.16, 6)
    expect(landmarks[12].y).toBeCloseTo(0.84, 6)
    expect(landmarks[12].z).toBe(mp[12].z)
    expect(landmarks[12].visibility).toBe(0.9)
  })

  it('Halpe にない点（手の指・目の内側・口）は、近くの点と同じだけ動かす', () => {
    const mp = body()
    const rtm = Array.from({ length: 26 }, () => ({ x: 0, y: 0, score: 0 }))
    rtm[9] = { x: mp[15].x + 0.05, y: mp[15].y - 0.02, score: 0.9 } // 左手首
    const { landmarks } = mergeRtm(mp, rtm)
    for (const m of [17, 19, 21]) {
      expect(landmarks[m].x - mp[m].x).toBeCloseTo(0.05, 6)
      expect(landmarks[m].y - mp[m].y).toBeCloseTo(-0.02, 6)
    }
    // 右手の指は動かない
    expect(landmarks[18].x).toBe(mp[18].x)
  })
})

describe('動画の点を何コマかおきに細かくする', () => {
  it('かけなかったコマには、前後のかけたコマのずれを時間で割り振って足す', async () => {
    const { createClipRefiner } = await import('../src/pose/rtmpose')
    // かけたコマの番号だけ、x を 0.01 × 番号 だけずらす（ずれが時間でなめらかに変わる）
    let k = 0
    const calls: number[] = []
    const refine = async (_s: unknown, _w: number, _h: number, l: Landmark[]) => {
      calls.push(k)
      return l.map((p) => ({ ...p, x: p.x + 0.01 * k }))
    }
    const r = createClipRefiner({ refine, step: 3 })
    for (k = 0; k < 8; k++) await r.push({} as CanvasImageSource, 100, 100, body())
    expect(calls).toEqual([0, 3, 6])
    const out = r.finish()
    const base = body()
    // 1 コマ目は 0 と 3 の間の 1/3、7 コマ目は最後のかけたコマ（6）のずれのまま
    expect(out[1][11].x - base[11].x).toBeCloseTo(0.01, 6)
    expect(out[4][11].x - base[11].x).toBeCloseTo(0.04, 6)
    expect(out[7][11].x - base[11].x).toBeCloseTo(0.06, 6)
    // 奥行きは変わらない
    expect(out[4][11].z).toBe(base[11].z)
  })
})

describe('読み取りの精度（標準・高精度）', () => {
  it('設定で選んだモデルの名前が、記録の推定モデルの版に使われる', async () => {
    const { setRtmQuality, currentRtmName, RTM_MODELS } = await import('../src/pose/rtmpose')
    setRtmQuality('high')
    expect(currentRtmName()).toBe(RTM_MODELS.high.name)
    expect(currentRtmName()).toContain('rtmpose-l')
    setRtmQuality('standard')
    expect(currentRtmName()).toContain('rtmpose-m')
    // 分からない値は標準
    setRtmQuality(undefined)
    expect(currentRtmName()).toBe(RTM_MODELS.standard.name)
  })
})
