import { describe, expect, it } from 'vitest'
import type { Point } from '../src/domain/types'
import { backLower, backUpper, extractEdge, mergeContours } from '../src/domain/backContour'
import { mergeBurst } from '../src/domain/burst'
import { backShapeFor, computePlaneMetrics, planeInputFrom } from '../src/domain/metrics'
import { H, W, record, sidePose } from './helpers'

// sidePose: 顔が画像の右、肩 (500, 500)、股関節 (500, 1000)、耳 y=300 → かかと y=1840（体の高さ 1540px）
const HB = 1540

/**
 * 背中側の端が胴の中心線（x = 500）から後ろへどれだけ離れているか（px）。
 * 肩〜胸の下（y 500〜800）は深さ h の円弧、腰（y 900）でくぼみ、お尻（y 1030）でいちばん後ろへ出る
 */
function backDepth(y: number, h = 30, o: { noButtock?: boolean } = {}): number {
  if (y < 500) return 100 - (500 - y) * 0.5
  if (y <= 800) {
    const R = (150 ** 2 + h ** 2) / (2 * h)
    return 100 + h - R + Math.sqrt(R ** 2 - (y - 650) ** 2)
  }
  const c = (t: number) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, t)))) / 2
  if (y <= 900) return 100 - 20 * c((y - 800) / 100)
  if (o.noButtock) return 80 + 0.4 * (y - 900)
  if (y <= 1030) return 80 + 60 * c((y - 900) / 130)
  return 140 - 80 * c((y - 1030) / 170)
}

/** 輪郭（正規化座標）。y 376〜1216 を 6px おき */
function contour(h = 30, o: { noButtock?: boolean } = {}): Point[] {
  const pts: Point[] = []
  for (let y = 376; y <= 1216; y += 6) pts.push({ x: (500 - backDepth(y, h, o)) / W, y: y / H })
  return pts
}

/** 顔が画像の右向きなので、背中側は体の左端 */
function sideRecord(back: Point[] | null, poseOpts: Parameters<typeof sidePose>[0] = {}) {
  const rec = record('side', sidePose(poseOpts))
  return back ? { ...rec, outline: { left: { points: back }, right: { points: [] } } } : rec
}

const mirror = (pts: Point[]) => pts.map((p) => ({ x: 1 - p.x, y: p.y }))

const metric = (rec: ReturnType<typeof sideRecord>, key: string) => computePlaneMetrics(planeInputFrom(rec, true)).find((m) => m.key === key)

describe('マスクから背中側の端を取り出す', () => {
  function mask(o: { hole?: boolean; arm?: boolean } = {}) {
    const data = new Float32Array(W * H)
    for (let row = 0; row < H; row++) {
      const y = row + 0.5
      if (y < 250 || y > 1850) continue
      const e = 500 - backDepth(y)
      for (let i = 0; i < W; i++) {
        const c = i + 0.5
        if (c > 620) break
        data[row * W + i] = Math.min(1, Math.max(0, 0.5 + (c - e) / 3))
      }
      if (o.hole && row % 3 === 0) for (let i = 485; i < 488; i++) data[row * W + i] = 0
      if (o.arm && y > 700 && y < 820) for (let i = 320; i < 345; i++) data[row * W + i] = 1
    }
    return { data, width: W, height: H }
  }
  const opts = { shoulder: { x: 0.5, y: 0.25 }, hip: { x: 0.5, y: 0.5 }, heightFrac: HB / H, side: 'left' as const }

  it('境目の値を補間して、画素より細かく端の位置を求める', () => {
    const r = extractEdge(mask(), opts)
    expect(r.note).toBeUndefined()
    expect(r.points.length).toBeGreaterThan(120)
    for (const p of r.points) expect(Math.abs(p.x * W - (500 - backDepth(p.y * H)))).toBeLessThan(0.05)
  })

  it('体の中の小さな抜けは飛ばし、離れた腕はつなげない', () => {
    const r = extractEdge(mask({ hole: true, arm: true }), opts)
    for (const p of r.points) expect(Math.abs(p.x * W - (500 - backDepth(p.y * H)))).toBeLessThan(0.05)
  })

  it('人の領域がなければ、理由をつけて空にする', () => {
    const r = extractEdge({ data: new Float32Array(W * H), width: W, height: H }, opts)
    expect(r.points).toEqual([])
    expect(r.note).toBeTruthy()
  })
})

describe('背中上部の丸みと腰のすき間', () => {
  const px = (pts: Point[]) => pts.map((p) => ({ x: p.x * W, y: p.y * H }))
  const input = (h = 30, o: { noButtock?: boolean } = {}, arms: Point[] = []) => ({ contour: px(contour(h, o)), shoulderY: 500, hipY: 1000, H: HB, f: 1, arms })

  it('円弧の膨らみ: 深さと、円弧の両端の接線のなす角を求める', () => {
    const r = backUpper(input(30))
    if (!('ok' in r)) throw new Error(r.fail)
    expect(r.ok.depth).toBeCloseTo(30, 0)
    expect(r.ok.chord).toBeCloseTo(300, 0)
    // 4 × atan(2 × 30 / 300) = 45.2°（同じ円弧の中心角 2 × asin(150 / 390) と一致）
    expect(r.ok.angleDeg).toBeCloseTo(45.2, 0)
    expect(r.ok.apex.y).toBeCloseTo(650, -1)
    // 膨らみが浅ければ角度も小さい
    const flat = backUpper(input(5))
    if (!('ok' in flat)) throw new Error(flat.fail)
    expect(flat.ok.angleDeg).toBeLessThan(10)
  })

  it('腰のすき間: 背中とお尻に当てた線から、腰のいちばん深いところまでの距離', () => {
    const r = backLower(input(30))
    if (!('ok' in r)) throw new Error(r.fail)
    // 背中の頂点 (650, 130) とお尻の頂点 (1030, 140) を結ぶ線から、くぼみ (900, 80) まで ≈ 56.6px
    expect(r.ok.depth).toBeGreaterThan(54)
    expect(r.ok.depth).toBeLessThan(59)
    expect(r.ok.deepest.y).toBeGreaterThan(870)
    expect(r.ok.deepest.y).toBeLessThan(930)
    expect(r.ok.lowerTouch.y).toBeGreaterThan(1000)
  })

  it('お尻のいちばん後ろが範囲内に見つからなければ、すき間は求めない', () => {
    const r = backLower(input(30, { noButtock: true }))
    expect('fail' in r && r.fail).toMatch('お尻')
  })

  it('腕や手が輪郭の近くにあれば測らない', () => {
    // 手首が腰の輪郭のすぐ内側にある
    const r = backLower(input(30, {}, [{ x: 500 - 125, y: 1000 }]))
    expect('fail' in r && r.fail).toMatch('腕')
    // 胴の中心あたりなら測る
    expect('ok' in backLower(input(30, {}, [{ x: 500, y: 1000 }]))).toBe(true)
  })
})

describe('指標として計算する', () => {
  it('輪郭がある横向きの記録では、2 つの指標を記述として出す（ばらつきつき）', () => {
    const rec = sideRecord(contour(30))
    const up = metric(rec, 'side_back_upper')!
    expect(up.status).toBe('descriptive')
    expect(up.rawValue!).toBeCloseTo(45.2, 0)
    expect(up.normalizedValue!).toBeCloseTo((30 / HB) * 100, 1)
    expect(up.uncertainty!).toBeGreaterThan(0)
    expect(up.offset?.frac).toBeCloseTo(30 / HB, 3)
    const low = metric(rec, 'side_back_lower')!
    expect(low.status).toBe('descriptive')
    expect(low.rawValue!).toBeGreaterThan(3.5)
    expect(low.rawValue!).toBeLessThan(3.85)
    expect(low.uncertainty!).toBeGreaterThan(0)
  })

  it('輪郭を記録していない（この機能より前の）記録では、指標を出さない', () => {
    const keys = computePlaneMetrics(planeInputFrom(sideRecord(null), true)).map((m) => m.key)
    expect(keys).not.toContain('side_back_upper')
    expect(keys).not.toContain('side_back_lower')
  })

  it('輪郭を取れなかったときは、理由をつけて評価不可にする', () => {
    const note = '体が写真の端で切れているため、背中の輪郭を取れませんでした'
    const rec = { ...sideRecord(null), outline: { left: { points: [], note }, right: { points: [], note } } }
    const m = metric(rec, 'side_back_upper')!
    expect(m.status).toBe('unassessable')
    expect(m.qualityNote).toMatch('写真の端')
  })

  it('手が腰の輪郭に重なっていれば、腰のすき間だけ評価不可', () => {
    const rec = sideRecord(contour(30), { wristForward: -125 })
    expect(metric(rec, 'side_back_lower')!.qualityNote).toMatch('腕')
    expect(metric(rec, 'side_back_upper')!.rawValue).not.toBeNull()
  })

  it('複数枚撮りでは、1 枚ごとの輪郭からの値も出す', () => {
    const base = sideRecord(contour(30))
    const pose = sidePose()
    const rec = {
      ...base,
      burst: {
        frames: [pose, pose, pose],
        repIndex: 1,
        attempted: 3,
        spreadFrac: 0.002,
        outlines: [{ left: contour(26), right: [] }, { left: contour(30), right: [] }, null],
      },
    }
    const vals = metric(rec, 'side_back_upper')!.burstValues!
    expect(vals).toHaveLength(3)
    expect(vals[0]!).toBeLessThan(vals[1]!)
    expect(vals[2]).toBeNull()
  })

  it('ばらつきは輪郭の想定誤差から求め、1 枚ごとの値の揺れ ÷ √枚数 のほうが大きければそれに広げる', () => {
    const single = metric(sideRecord(contour(30)), 'side_back_upper')!
    // 想定誤差（体の高さの 0.2%）での角度のばらつきは数度
    expect(single.uncertainty!).toBeGreaterThan(1)
    expect(single.uncertainty!).toBeLessThan(10)
    const pose = sidePose()
    const o = (h: number) => ({ left: contour(h), right: [] })
    const steady = { ...sideRecord(contour(30)), burst: { frames: [pose, pose, pose], repIndex: 1, attempted: 3, spreadFrac: 0.001, outlines: [o(30), o(30), o(30)] } }
    expect(metric(steady, 'side_back_upper')!.uncertainty).toBe(single.uncertainty)
    const shaky = { ...steady, burst: { ...steady.burst, outlines: [o(10), o(30), o(50)] } }
    const m = metric(shaky, 'side_back_upper')!
    const v = m.burstValues!.map((x) => x!)
    const mean = (v[0] + v[1] + v[2]) / 3
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / 2)
    expect(m.uncertainty!).toBeCloseTo(sd / Math.sqrt(3), 2)
    expect(m.uncertainty!).toBeGreaterThan(single.uncertainty!)
  })

  it('背中側は今の顔の向きで決める（確認画面で向きを切り替えても正しい側を使う）', () => {
    // 顔が画像の左向き: 背中側は体の右端
    const left = { ...record('side', sidePose({ facing: 'left' }), { facing: 'left' }), outline: { left: { points: [] }, right: { points: mirror(contour(30)) } } }
    expect(metric(left, 'side_back_upper')!.rawValue!).toBeCloseTo(45.2, 0)
    // 向きを右に切り替えると、左端（ここでは空）を使う
    const flipped = { ...left, imageMetadata: { ...left.imageMetadata, facing: 'right' as const } }
    expect(metric(flipped, 'side_back_upper')!.rawValue).toBeNull()
  })

  it('画面に描くための線を返す', () => {
    const v = backShapeFor(sideRecord(contour(30)))!
    expect(v.contour.length).toBeGreaterThan(100)
    expect(v.upper?.top.y).toBeCloseTo(500, 0)
    expect(v.lower?.depth).toBeGreaterThan(50)
    expect(backShapeFor(sideRecord(null))).toBeNull()
  })
})

describe('続けて撮った輪郭をまとめる', () => {
  it('高さごとに x を平均する', () => {
    const a = contour(30)
    const b = a.map((p) => ({ ...p, x: p.x + 0.004 }))
    const m = mergeContours([a, b, null], 0.03)
    expect(m).toHaveLength(a.length)
    m.forEach((p, i) => expect(p.x).toBeCloseTo(a[i].x + 0.002, 5))
  })

  it('写真ごとの点を、代表の写真の座標へ移す（骨格と同じそろえ方）', () => {
    const base = sidePose()
    const moved = base.map((l) => ({ ...l, x: l.x * 1.05 + 0.02, y: l.y * 1.05 - 0.01 }))
    const m = mergeBurst('side', [{ landmarks: base, width: W, height: H }, { landmarks: moved, width: W, height: H }], 'right')!
    for (const k of [0, 1]) {
      const src = k === 0 ? base : moved
      for (const j of [12, 24, 28]) {
        const q = m.toRep(k, src[j])
        expect(q.x).toBeCloseTo(m.frames[k][j].x, 6)
        expect(q.y).toBeCloseTo(m.frames[k][j].y, 6)
      }
    }
  })
})
