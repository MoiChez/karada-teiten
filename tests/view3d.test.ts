/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { VIEW3D_POINTS, parseView3DModel, runView3D, view3dFrameFeatures, view3dOutput, type View3DModelFile } from '../src/domain/view3d'
import type { Landmark, Point } from '../src/domain/types'

const FILE = 'public/models/view3d-v2.json'

describe('向きによらない 3D のモデル', () => {
  it.skipIf(!existsSync(FILE))('アプリの計算が、学習した道具（PyTorch・float16 の重み）と同じ結果になる', () => {
    const f = JSON.parse(readFileSync(FILE, 'utf8')) as View3DModelFile
    const m = parseView3DModel(f)
    expect(f.test).toBeDefined()
    for (let k = 0; k < f.test!.x.length; k++) {
      const y = runView3D(m, f.test!.x[k])
      const want = f.test!.y[k]
      for (let i = 0; i < want.length; i++) expect(Math.abs(y[i] - want[i])).toBeLessThan(2e-3)
    }
  })

  it('1 コマの入力は、両股関節の中点を原点・点の広がりを 1 にし、推定モデルの 3D も同じようにそろえる', () => {
    const px: Point[] = Array.from({ length: 33 }, (_, i) => ({ x: 100 + i * 3, y: 200 + (i % 5) * 7 }))
    const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.9 }))
    const world: Landmark[] = Array.from({ length: 33 }, (_, i) => ({ x: i * 0.01, y: -i * 0.02, z: (i % 3) * 0.01 }))
    const x = view3dFrameFeatures(px, lm, world)
    const n = VIEW3D_POINTS.length
    expect(x.length).toBe(n * 6)
    // 両股関節（23・24）の中点が原点
    const k23 = VIEW3D_POINTS.indexOf(23)
    const k24 = VIEW3D_POINTS.indexOf(24)
    expect(x[2 * k23] + x[2 * k24]).toBeCloseTo(0, 5)
    expect(x[2 * k23 + 1] + x[2 * k24 + 1]).toBeCloseTo(0, 5)
    // 広がりが 1（見えている度合いが同じなら、2 乗の平均の平方根）
    let ss = 0
    for (let k = 0; k < n; k++) ss += x[2 * k] ** 2 + x[2 * k + 1] ** 2
    expect(Math.sqrt(ss / n / 2)).toBeCloseTo(1, 3)
    // 画面の上の位置を 2 倍にしても同じ入力
    const x2 = view3dFrameFeatures(
      px.map((p) => ({ x: p.x * 2, y: p.y * 2 })),
      lm,
      world,
    )
    for (let i = 0; i < x.length; i++) expect(x2[i]).toBeCloseTo(x[i], 4)
  })

  it('出力の上の向きは長さ 1 にする', () => {
    const y = new Float32Array(VIEW3D_POINTS.length * 3 + 3)
    y[VIEW3D_POINTS.length * 3 + 1] = -2
    const r = view3dOutput(y)
    expect(r.up.y).toBeCloseTo(-1, 6)
    expect(r.points.length).toBe(VIEW3D_POINTS.length)
  })
})
