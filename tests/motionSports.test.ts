import { describe, expect, it } from 'vitest'
import type { Landmark } from '../src/domain/types'
import { analyzeMotion, compareMotion, findCycles, motionMetric, prepareMotion, type MotionInput } from '../src/domain/motion'
import { motionEquipment, motionPoses } from '../src/domain/motionPose'
import { motionCyclesCsv, motionFramesCsv, motionJson } from '../src/domain/motionExport'

const W = 2000
const H = 1500
const THIGH = 440
const SHIN = 420
const TRUNK = 520
const UPPER = 300
const FORE = 280
const RAD = Math.PI / 180

type P = { x: number; y: number }

/** 2 本の骨（長さ l1・l2）で a と b をつなぐときの、間の関節の位置。side = +1 なら a→b の向きの左手側（画像では上側になる向き） */
function joint(a: P, b: P, l1: number, l2: number, side: 1 | -1): P {
  const d = Math.min(Math.hypot(b.x - a.x, b.y - a.y), l1 + l2 - 1e-6)
  const base = Math.atan2(b.y - a.y, b.x - a.x)
  const alpha = Math.acos((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))
  return { x: a.x + l1 * Math.cos(base - side * alpha), y: a.y + l1 * Math.sin(base - side * alpha) }
}

const interiorFlex = (l1: number, l2: number, d: number) => 180 - Math.acos((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2)) / RAD

/** カメラ側（左）の点から 33 点を作る。奥側（右）は少しずらして、見えにくくする */
function body(pts: Record<number, P>): Landmark[] {
  const out: Landmark[] = []
  for (let i = 0; i < 33; i++) {
    const base = i === 0 ? 0 : i % 2 === 1 ? i : i - 1
    const p = pts[base] ?? pts[0]
    const near = i === 0 || i % 2 === 1
    out.push({ x: (p.x + (near ? 0 : 8)) / W, y: p.y / H, z: 0, visibility: near ? 0.95 : 0.3 })
  }
  return out
}

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u))
const span = (s: number, a: number, b: number) => smooth((s - a) / (b - a))

// ---------- エルゴ ----------

const ERG = { T: 2400, drive: 800, seat: [300, 820], trunk: [25, -15], elbow: [0, 0] as number[] }

/** ドライブの進み s（0 = キャッチ、1 = フィニッシュ）の姿勢。脚 → 上体 → 腕の順に動く */
function ergPose(s: number): Record<number, P> {
  const ankle = { x: 1400, y: 1000 }
  const seat = ERG.seat[0] + (ERG.seat[1] - ERG.seat[0]) * span(s, 0, 0.6)
  const lean = ERG.trunk[0] + (ERG.trunk[1] - ERG.trunk[0]) * span(s, 0.3, 0.8)
  const hip = { x: ankle.x - seat, y: ankle.y - 20 }
  const knee = joint(hip, ankle, THIGH, SHIN, 1)
  const shoulder = { x: hip.x + Math.sin(lean * RAD) * TRUNK, y: hip.y - Math.cos(lean * RAD) * TRUNK }
  const ear = { x: shoulder.x + Math.sin(lean * RAD) * 200, y: shoulder.y - Math.cos(lean * RAD) * 200 }
  // 手はハンドルの高さ。腕が伸びたときの前への届きから、引くほど体に近づく
  const hy = hip.y - 260
  const reachMax = Math.sqrt((UPPER + FORE - 2) ** 2 - (shoulder.y - hy) ** 2)
  const reach = reachMax - (reachMax - 160) * span(s, 0.6, 1)
  const wrist = { x: shoulder.x + reach, y: hy }
  const elbow = joint(shoulder, wrist, UPPER, FORE, -1)
  return {
    0: { x: ear.x + 30, y: ear.y + 10 },
    7: ear,
    11: shoulder,
    13: elbow,
    15: wrist,
    23: hip,
    25: knee,
    27: ankle,
    29: { x: ankle.x - 30, y: ankle.y + 40 },
    31: { x: ankle.x + 110, y: ankle.y - 30 },
  }
}

function ergInput(strokes = 5): MotionInput {
  const frames: MotionInput['frames'] = []
  for (let t = 0; t <= strokes * ERG.T; t += 1000 / 30) {
    const u = t % ERG.T
    const s = u <= ERG.drive ? u / ERG.drive : 1 - (u - ERG.drive) / (ERG.T - ERG.drive)
    frames.push({ t: Math.round(t), lm: body(ergPose(s)) })
  }
  return { frames, width: W, height: H }
}

describe('ローイングエルゴ', () => {
  const a = analyzeMotion(ergInput(), 'erg')
  const v = (k: string) => motionMetric(a, k)!.value!

  it('キャッチから次のキャッチまでを 1 本として区切り、レートと時間を出す', () => {
    expect(a.warnings).toEqual([])
    // 5 本ぶんの動きで、最初と最後のキャッチの間の 4 本（端のキャッチは山として見つからないことがある）
    expect(a.cycles.length).toBeGreaterThanOrEqual(3)
    expect(v('rate')).toBeCloseTo(25, 0)
    // なめらか化で折り返しが少しずれる分を許す
    expect(Math.abs(v('drive') - 0.8)).toBeLessThan(0.1)
    expect(Math.abs(v('recovery') - 1.6)).toBeLessThan(0.1)
    expect(v('ratio')).toBeCloseTo(2, 0)
  })

  it('キャッチとフィニッシュの上体の傾き、キャッチの膝、フィニッシュのひじを出す', () => {
    expect(v('trunk_catch')).toBeCloseTo(25, 0)
    expect(v('trunk_finish')).toBeCloseTo(-15, 0)
    const dCatch = Math.hypot(ERG.seat[0], 20)
    expect(Math.abs(v('knee_catch') - interiorFlex(THIGH, SHIN, dCatch))).toBeLessThan(2)
    expect(v('elbow_finish')).toBeGreaterThan(90)
    expect(v('length')).toBeGreaterThan(60)
  })

  it('脚 → 上体 → 腕の順に動いたことが、半分に達した時刻の順で分かる', () => {
    expect(v('leg_half')).toBeLessThan(v('trunk_half'))
    expect(v('trunk_half')).toBeLessThan(v('arm_half'))
    expect(v('leg_half')).toBeGreaterThan(15)
    expect(v('arm_half')).toBeLessThan(95)
  })

  it('3D の体はシートの高さから大きさを決め、器具の目安（シート・レール）を返す', () => {
    const prep = prepareMotion(ergInput(), 'erg')!
    const { cycles } = findCycles(prep)
    const poses = motionPoses(prep, cycles)
    const eq = motionEquipment('erg', poses, prep.nearSide)
    expect(eq.erg).toBeDefined()
    // 腰の動いた範囲がレールに収まる
    const z = poses.map((p) => p.pose.points[23]!.z)
    expect(eq.erg!.railFrom).toBeLessThan(Math.min(...z))
    expect(eq.erg!.railTo).toBeGreaterThan(Math.max(...z))
    // 体の高さ 1 に対して、脚の長さは標準の体の比（0.53）
    const p = poses[0].pose.points
    const leg = Math.hypot(p[23]!.y - p[25]!.y, p[23]!.z - p[25]!.z) + Math.hypot(p[25]!.y - p[27]!.y, p[25]!.z - p[27]!.z)
    expect(leg).toBeCloseTo(0.53, 1)
  })

  it('1 本しか写っていなければ、測れないことを知らせる', () => {
    const one = analyzeMotion({ ...ergInput(1) }, 'erg')
    expect(one.cycles).toHaveLength(0)
    expect(one.warnings.some((w) => w.includes('ストロークを見つけられませんでした'))).toBe(true)
  })

  it('種目が違う記録どうしは比べない', () => {
    expect(compareMotion(a, { ...a, kind: 'bike' })).toEqual([])
    expect(compareMotion(a, a).every((c) => !c.noticeable)).toBe(true)
  })
})

// ---------- 自転車 ----------

const BIKE = { T: 667, r: 170, hip: { x: 800, y: 600 }, crank: { x: 930, y: 1270 } }

function bikePose(t: number): Record<number, P> {
  const th = (2 * Math.PI * t) / BIKE.T
  const ankle = { x: BIKE.crank.x + BIKE.r * Math.cos(th), y: BIKE.crank.y + BIKE.r * Math.sin(th) }
  const hip = BIKE.hip
  const knee = joint(hip, ankle, THIGH, SHIN, 1)
  const lean = 45
  const shoulder = { x: hip.x + Math.sin(lean * RAD) * TRUNK, y: hip.y - Math.cos(lean * RAD) * TRUNK }
  const ear = { x: shoulder.x + Math.sin(lean * RAD) * 200, y: shoulder.y - Math.cos(lean * RAD) * 200 }
  const wrist = { x: shoulder.x + 330, y: shoulder.y + 330 }
  const elbow = joint(shoulder, wrist, UPPER, FORE, -1)
  // つま先は、足首の少し前・下。回転に合わせて 10° 上下する
  const tilt = (15 + 10 * Math.sin(th)) * RAD
  return {
    0: { x: ear.x + 30, y: ear.y + 10 },
    7: ear,
    11: shoulder,
    13: elbow,
    15: wrist,
    23: hip,
    25: knee,
    27: ankle,
    29: { x: ankle.x - 40, y: ankle.y + 20 },
    31: { x: ankle.x + 130 * Math.cos(tilt), y: ankle.y + 130 * Math.sin(tilt) },
  }
}

function bikeInput(ms = 6000): MotionInput {
  const frames: MotionInput['frames'] = []
  for (let t = 0; t <= ms; t += 1000 / 30) frames.push({ t: Math.round(t), lm: body(bikePose(t)) })
  return { frames, width: W, height: H }
}

describe('固定式の自転車', () => {
  const a = analyzeMotion(bikeInput(), 'bike')
  const v = (k: string) => motionMetric(a, k)!.value!

  it('下死点から次の下死点までを 1 回転として区切り、ケイデンスを出す', () => {
    expect(a.warnings).toEqual([])
    expect(a.cycles.length).toBeGreaterThanOrEqual(6)
    expect(v('cadence')).toBeCloseTo(90, -1)
    expect(Math.abs(v('cadence') - 90)).toBeLessThan(3)
  })

  it('下死点と上死点の膝の曲がりを出す（なめらか化とコマの間隔の分だけ、極値は少し内側に出る）', () => {
    const dx = BIKE.crank.x - BIKE.hip.x
    const dy = BIKE.crank.y - BIKE.hip.y
    const far = Math.hypot(dx, dy) + BIKE.r
    const nearD = Math.hypot(dx, dy) - BIKE.r
    expect(Math.abs(v('knee_bdc') - interiorFlex(THIGH, SHIN, far))).toBeLessThan(5)
    expect(Math.abs(v('knee_tdc') - interiorFlex(THIGH, SHIN, nearD))).toBeLessThan(5)
    expect(v('knee_tdc')).toBeGreaterThan(v('knee_bdc') + 30)
    expect(v('trunk')).toBeCloseTo(45, 0)
    expect(v('ankle_range')).toBeGreaterThan(5)
  })

  it('3D では、奥側の脚をカメラ側の脚の半回転ずれた動きにし、クランクの円を足首の通り道から求める', () => {
    const prep = prepareMotion(bikeInput(), 'bike')!
    const { cycles } = findCycles(prep)
    const poses = motionPoses(prep, cycles)
    const k = 20
    const near = poses[k].pose.points[27]!
    const far = poses[k].pose.points[28]!
    // 逆の位置にあるので、前後か上下のどちらかが大きく違う
    expect(Math.hypot(near.y - far.y, near.z - far.z)).toBeGreaterThan(0.1)
    const eq = motionEquipment('bike', poses, prep.nearSide)
    expect(eq.bike).toBeDefined()
    const scale = prep.leg / 0.53
    expect(eq.bike!.crank.r).toBeCloseTo(BIKE.r / scale, 2)
  })

  it('回転が写っていなければ、測れないことを知らせる', () => {
    const still = bikeInput(3000)
    for (const f of still.frames) f.lm = body(bikePose(0))
    const s = analyzeMotion(still, 'bike')
    expect(s.cycles).toHaveLength(0)
    expect(s.warnings.some((w) => w.includes('回転を見つけられませんでした'))).toBe(true)
  })
})

// ---------- 手で直した点・書き出し ----------

describe('手で直した点と書き出し', () => {
  it('手で直した点は、なめらか化の後もその位置のままで、推定した点は書き換えない', () => {
    const input = bikeInput(2000)
    const t = input.frames[10].t
    const before = input.frames[10].lm[25].x
    const prep = prepareMotion({ ...input, edits: [{ t, i: 25, x: 0.5, y: 0.4 }] }, 'bike')!
    expect(prep.frames[10].lm[25].x).toBe(0.5)
    expect(prep.frames[10].lm[25].y).toBe(0.4)
    expect(prep.frames[10].edited).toEqual([25])
    expect(prep.frames[9].edited).toEqual([])
    expect(input.frames[10].lm[25].x).toBe(before)
  })

  it('コマごと・1 回ごとの CSV と、記録の JSON を作る', () => {
    const input = ergInput(4)
    const rec = {
      id: 'm_test',
      createdAt: '2026-11-13T10:00:00.000Z',
      appVersion: 'test',
      kind: 'erg' as const,
      source: 'upload' as const,
      modelVersion: 'test',
      video: { width: W, height: H, durationMs: 9600, frameCount: input.frames.length, fps: 30, quarterTurns: 0 },
      videoSaved: true,
      frames: [],
      analysis: analyzeMotion(input, 'erg'),
    }
    const prep = prepareMotion(input, 'erg')!
    const { cycles } = findCycles(prep)
    const frames = motionFramesCsv(rec, prep, cycles).split('\r\n')
    expect(frames[0]).toContain('上体の前傾（°）')
    expect(frames).toHaveLength(prep.frames.length + 1)
    expect(frames.some((l) => l.includes('キャッチ'))).toBe(true)
    const cyc = motionCyclesCsv(rec).split('\r\n')
    expect(cyc[0]).toContain('ストロークレート（回/分）')
    expect(cyc).toHaveLength(rec.analysis.cycles.length + 1)
    const json = JSON.parse(motionJson(rec))
    expect(json.type).toBe('motion')
    // 動画は書き出さない
    expect(json.record.videoSaved).toBe(false)
  })
})
