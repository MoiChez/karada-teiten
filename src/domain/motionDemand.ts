// エルゴと自転車の「筋肉の要求度」の推定（色の濃さに使う。0〜1）。
//
// ハンドルやペダルにかかる力は動画から分からないので、次の 2 つを組み合わせる:
//  1. 力の型: 論文にある標準的な力の出方（エルゴは 1 本の中のハンドルの力、自転車はクランクの角度ごとのペダルの力）を仮定し、
//     本人の関節の位置から、その力が各関節を曲げようとする大きさ（関節の負担）を求める。濃さの時間変化はここから決まる
//  2. 筋電図の型: 論文にある「どの局面でその筋肉が働くか」の範囲で、1 の結果を出す範囲を決める（範囲の中は、力が小さくても薄く色を残す）
//
// 力の大きさは分からないので、濃さは筋肉ごとに、その記録の中のいちばん大きいところを 1 とした割合にする。
// 筋肉どうしの強さは比べられない。本人の筋電図や力を測ったものではない。
//
// 出典:
//  エルゴ
//   - Benson A, Abendroth J, King D, Swensen T (2011) J Sports Sci Med 10:267-273.
//     Concept2（固定式）: 力が最大になるのは 1 本の時間の 13.8 ± 3.0%。キャッチとフィニッシュは力が 10 N を超える / 下回る時刻
//   - Greene A, Sinclair P, Smith R (2009) ISB 2009 抄録 "Kinetic comparison of ergometer and on-water rowing".
//     エルゴのドライブは 1 本の 44%。エルゴではキャッチ直後の力の立ち上がりが遅れる
//   - Vieira TM, Cerone GL, Stocchi C, Lalli M, Andrews B, Gazzoni M (2020) Sensors 20:1666.
//     エルゴ（Concept2）の脚の筋電図 20 名: 大腿四頭筋・腓腹筋・ヒラメ筋はキャッチの直前に働き始める。内側 / 外側広筋はフィニッシュの直前まで、
//     半腱様筋・大腿二頭筋・腓腹筋・ヒラメ筋はそれより前に静まる。大腿二頭筋の働く時間はいちばん短い（1 本の 22 ± 5%）
//   - Nowicky AV, Horne S, Burdett R (2005) J Sports Sci Med 4:18-28.
//     脊柱起立筋はドライブの終わりまで働き、ドライブの終わりで静まる。大腿二頭筋は 1 本の初めから働き、リカバリーの終わりに再び働く
//   - Yamashita M ほか (2023) J Sports Sci Med 22:338-344. 脊柱起立筋・広背筋の働きは 1 本の中の時期で変わる（時期の数値は読めていない）
//  自転車
//   - Candotti CT ほか (2007) Sports Biomech 6:31-43. クランクに効く力は 0〜180°（踏み下ろし）で正、180〜360° ではほとんどの人で負
//   - da Silva JCL ほか (2018) PLoS ONE 13:e0201014.（90 回転/分、170〜350 W、針電極。0° は上死点）
//     外側広筋: 始まり 328〜348°、終わり 100〜109°。内側広筋: 始まり 332〜342°。大腿直筋: 始まり 259〜319°、終わり 31〜85°。
//     いちばん働く角度: 大腿二頭筋長頭 105〜111°、半膜様筋 104〜139°、半腱様筋 132〜164°。半腱様筋の終わり 114〜117°
//   - Hug F, Boumier F, Dorel S (2013) Front Physiol 4:232. 区分: 上死点 330〜30°、踏み下ろし 30〜150°、下死点 150〜210°、引き上げ 210〜330°
import { LM, sidePoints } from './landmarks'
import type { Point } from './types'
import { quantile, type PreparedFrame } from './motionCore'
import type { CrankAngles } from './motionCrank'
import type { MotionCycle, MuscleKey } from './motionSports'

export interface DemandSeries {
  /** 筋肉ごとの、コマごとの濃さ（0〜1）。カメラ側の脚と、胴・腕 */
  values: Partial<Record<MuscleKey, number[]>>
  /** 反対側の脚の濃さ（自転車。半回転ずれる） */
  far?: Partial<Record<MuscleKey, number[]>>
}

/** 筋電図の型の範囲の中で、力が小さくても残す薄い色 */
export const WINDOW_FLOOR = 0.2
/** 範囲の端をなめらかにする幅（エルゴは局面の割合、自転車は度） */
const ERG_SOFT = 0.06
const BIKE_SOFT = 15

// ---------- エルゴ ----------

/** ドライブの中で、ハンドルの力が最大になる時刻（ドライブの割合）。1 本の 13.8%（Benson 2011）÷ ドライブ 44%（Greene 2009） */
export const ERG_PEAK_AT = 0.138 / 0.44

/** ハンドルの力の型（最大を 1。u はドライブの中の割合 0〜1）。キャッチで 0 から立ち上がり、ERG_PEAK_AT で最大、フィニッシュで 0。リカバリーは 0 */
export function ergHandleForce(u: number): number {
  if (!(u >= 0 && u <= 1)) return 0
  return u < ERG_PEAK_AT ? Math.sin((Math.PI / 2) * (u / ERG_PEAK_AT)) : Math.cos((Math.PI / 2) * ((u - ERG_PEAK_AT) / (1 - ERG_PEAK_AT)))
}

/**
 * 筋電図の型の範囲（局面 φ。ドライブが 0〜1、リカバリーが 1〜2 で、2 は次のキャッチ）。null は筋電図の出典がなく、力の型だけで決める筋肉。
 * 文献は「キャッチの直前」「フィニッシュの直前」などの言い方なので、端の数値は読み替えた仮定（直前 = 局面の 8%）
 */
export const ERG_WINDOWS: Record<MuscleKey, [number, number] | null> = {
  quads: [1.92, 0.92],
  calves: [1.92, 0.75],
  hamstrings: [1.8, 0.7],
  erectors: [0, 1],
  glutes: null,
  lats: null,
  biceps: null,
}

/** 巡回する範囲 [from, to] の中なら 1、端の soft の幅でなめらかに 0 へ（period で一周） */
export function windowWeight(x: number, from: number, to: number, period: number, soft: number): number {
  const span = (((to - from) % period) + period) % period || period
  const d = (((x - from) % period) + period) % period
  if (d > span) return 0
  const inEdge = Math.min(d, span - d)
  return inEdge >= soft ? 1 : 0.5 * (1 - Math.cos((Math.PI * inEdge) / soft))
}

const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })

/**
 * 関節 j（体の中心側の点 prox、先の側の点 dist）で、先の側の点 at にかかる力 force が、関節を伸ばす筋肉に求める大きさ（正）・曲げる筋肉に求める大きさ（負）。
 * 力が関節を曲げようとするなら、伸ばす筋肉が支える
 */
export function jointDemand(j: Point, prox: Point, dist: Point, at: Point, force: Point): number {
  const m = cross(sub(at, j), force)
  // 先の側を、体の中心側へ近づける（曲げる）回転の向き
  const closing = Math.sign(cross(sub(dist, j), sub(prox, j)))
  return m * closing
}

/** 自分のいちばん大きいところ（98% 点）を 1 とした割合にする */
function normalize(v: number[]): number[] {
  const pos = v.filter((x) => x > 0)
  const top = pos.length ? quantile(pos, 0.98) : 0
  return top > 1e-9 ? v.map((x) => Math.min(1, Math.max(0, x / top))) : v.map(() => 0)
}

const KEYS: MuscleKey[] = ['quads', 'hamstrings', 'glutes', 'calves', 'erectors', 'lats', 'biceps']

/** コマごとの局面（ドライブ 0〜1、リカバリー 1〜2。1 本の外は NaN） */
export function ergPhases(n: number, cycles: MotionCycle[]): number[] {
  const phase = new Array<number>(n).fill(NaN)
  cycles.forEach((c, i) => {
    const a = c.events.find((e) => e.key === 'catch')?.index
    const fin = c.events.find((e) => e.key === 'finish')?.index
    if (a === undefined || fin === undefined || fin <= a) return
    const next = cycles[i + 1]?.events.find((e) => e.key === 'catch')?.index ?? c.endIndex
    for (let k = a; k <= fin && k < n; k++) phase[k] = (k - a) / (fin - a)
    for (let k = fin + 1; k < next && k < n; k++) phase[k] = 1 + (k - fin) / Math.max(1, next - fin)
  })
  // 最初のキャッチの前（直前の 1 本ぶんのリカバリーとして扱う）
  const first = cycles[0]?.events.find((e) => e.key === 'catch')?.index
  const firstFin = cycles[0]?.events.find((e) => e.key === 'finish')?.index
  if (first !== undefined && firstFin !== undefined && cycles[0]) {
    const rec = Math.max(1, (cycles[0].endIndex - firstFin) | 0)
    for (let k = first - 1; k >= 0 && first - k < rec; k--) phase[k] = 2 - (first - k) / rec
  }
  return phase
}

/**
 * エルゴの筋肉の要求度。ハンドルの力（型は ergHandleForce、向きは水平で体の前へ）が手首にかかり、同じ大きさの逆向きの力が足にかかるとして、
 * 膝・足首（足の力）、股関節と腰・肩・ひじ（ハンドルの力）の負担を求める。体の重さと、体を加速する力は入れていない
 */
export function ergDemand(frames: PreparedFrame[], nearSide: 'left' | 'right', f: 1 | -1, cycles: MotionCycle[]): DemandSeries | null {
  const n = frames.length
  if (n < 5 || !cycles.length) return null
  const s = sidePoints(nearSide)
  const elbowI = nearSide === 'left' ? LM.leftElbow : LM.rightElbow
  const phase = ergPhases(n, cycles)
  const raw: Record<MuscleKey, number[]> = { quads: [], hamstrings: [], glutes: [], calves: [], erectors: [], lats: [], biceps: [] }
  for (let k = 0; k < n; k++) {
    const p = frames[k].px
    const u = phase[k]
    const F = ergHandleForce(u)
    const pull: Point = { x: f * F, y: 0 } // ハンドルが手を前へ引く
    const push: Point = { x: -f * F, y: 0 } // 足を置く板が足を後ろへ押す
    const ok = [s.hip, s.knee, s.ankle, s.foot, s.shoulder, s.wrist, elbowI].every((i) => p[i] && Number.isFinite(p[i].x))
    if (!ok || !(F > 0)) {
      for (const m of KEYS) raw[m].push(0)
      continue
    }
    const knee = jointDemand(p[s.knee], p[s.hip], p[s.ankle], p[s.foot], push)
    const ankle = jointDemand(p[s.ankle], p[s.knee], p[s.foot], p[s.foot], push)
    const hip = jointDemand(p[s.hip], p[s.knee], p[s.shoulder], p[s.wrist], pull)
    const shoulder = jointDemand(p[s.shoulder], p[s.hip], p[elbowI], p[s.wrist], pull)
    const elbow = jointDemand(p[elbowI], p[s.shoulder], p[s.wrist], p[s.wrist], pull)
    raw.quads.push(Math.max(0, knee))
    raw.calves.push(Math.max(0, ankle))
    raw.glutes.push(Math.max(0, hip))
    raw.hamstrings.push(Math.max(0, hip))
    raw.erectors.push(Math.max(0, hip))
    // 腕を体へ引きつける向き（肩を伸ばす・ひじを曲げる）は、力が関節を開こうとするとき
    raw.lats.push(Math.max(0, -shoulder))
    raw.biceps.push(Math.max(0, -elbow))
  }
  const values: DemandSeries['values'] = {}
  for (const m of KEYS) {
    const g = normalize(raw[m])
    const win = ERG_WINDOWS[m]
    values[m] = g.map((v, k) => {
      if (!win) return v
      if (!Number.isFinite(phase[k])) return 0
      const w = windowWeight(phase[k], win[0], win[1], 2, ERG_SOFT)
      return w * (WINDOW_FLOOR + (1 - WINDOW_FLOOR) * v)
    })
  }
  return { values }
}

// ---------- 自転車 ----------

/** ペダルを踏む力の型（最大を 1。角度は上死点 0°、こぐ向きに増える）。0〜180° で正（Candotti 2007）。形は正弦と仮定し、引き上げの間は 0 とする */
export function bikePedalForce(deg: number): number {
  const a = ((deg % 360) + 360) % 360
  return a < 180 ? Math.sin((a * Math.PI) / 180) : 0
}

/** 筋電図の型の範囲（クランクの角度、度）。null は出典の数値がなく、力の型だけで決める筋肉。腕と背中は、自転車では出さない */
export const BIKE_WINDOWS: Partial<Record<MuscleKey, [number, number] | null>> = {
  // 大腿直筋の始まり（約 320°）から、外側広筋の終わり（約 105°）まで（da Silva 2018）
  quads: [320, 105],
  // いちばん働く角度が 105〜164°（da Silva 2018）。始まりと終わりは、その前後 60° とした仮定
  hamstrings: [45, 225],
  glutes: null,
  calves: null,
}

const BIKE_KEYS: MuscleKey[] = ['quads', 'hamstrings', 'glutes', 'calves']

/**
 * 自転車の筋肉の要求度。ペダルが足を真上へ押す力（型は bikePedalForce。向きは真上と仮定）が足先にかかるとして、
 * カメラ側の脚の膝・股関節・足首の負担を求める。反対側の脚は、同じ人の角度ごとの値を半回転ずらして当てる
 */
export function bikeDemand(frames: PreparedFrame[], nearSide: 'left' | 'right', crank: CrankAngles | undefined): DemandSeries | null {
  const n = frames.length
  if (n < 5 || !crank || crank.angle.length !== n) return null
  const s = sidePoints(nearSide)
  const raw: Record<string, number[]> = { quads: [], hamstrings: [], glutes: [], calves: [] }
  for (let k = 0; k < n; k++) {
    const p = frames[k].px
    const deg = crank.angle[k]
    const F = Number.isFinite(deg) ? bikePedalForce(deg) : 0
    const up: Point = { x: 0, y: -F } // 画像は下が +
    const ok = [s.hip, s.knee, s.ankle, s.foot, s.shoulder].every((i) => p[i] && Number.isFinite(p[i].x))
    if (!ok || !(F > 0)) {
      for (const m of BIKE_KEYS) raw[m].push(0)
      continue
    }
    const knee = jointDemand(p[s.knee], p[s.hip], p[s.ankle], p[s.foot], up)
    const hip = jointDemand(p[s.hip], p[s.shoulder], p[s.knee], p[s.foot], up)
    const ankle = jointDemand(p[s.ankle], p[s.knee], p[s.foot], p[s.foot], up)
    raw.quads.push(Math.max(0, knee))
    // 太ももの裏は、股関節を伸ばす働きと、膝を曲げる向きの負担の大きいほう
    raw.hamstrings.push(Math.max(0, hip, -knee))
    raw.glutes.push(Math.max(0, hip))
    raw.calves.push(Math.max(0, ankle))
  }
  const values: DemandSeries['values'] = {}
  const far: DemandSeries['far'] = {}
  for (const m of BIKE_KEYS) {
    const g = normalize(raw[m])
    const win = BIKE_WINDOWS[m]
    const near = g.map((v, k) => {
      const deg = crank.angle[k]
      if (!Number.isFinite(deg)) return 0
      if (!win) return v
      return windowWeight(deg, win[0], win[1], 360, BIKE_SOFT) * (WINDOW_FLOOR + (1 - WINDOW_FLOOR) * v)
    })
    values[m] = near
    // 角度 10° ごとの中央値を作り、反対側の脚には半回転ずれた角度の値を当てる
    const bins: number[][] = Array.from({ length: 36 }, () => [])
    near.forEach((v, k) => {
      const deg = crank.angle[k]
      if (Number.isFinite(deg)) bins[Math.min(35, Math.floor((((deg % 360) + 360) % 360) / 10))].push(v)
    })
    const byAngle = bins.map((b) => (b.length ? quantile(b, 0.5) : 0))
    far[m] = near.map((_, k) => {
      const deg = crank.angle[k]
      return Number.isFinite(deg) ? byAngle[Math.min(35, Math.floor((((deg + 180) % 360) + 360) % 360 / 10))] : 0
    })
  }
  return { values, far }
}

/** 画面に出す出典（短い形） */
export const DEMAND_SOURCES: Record<'erg' | 'bike', string[]> = {
  erg: [
    'Benson ほか 2011, J Sports Sci Med 10:267（ハンドルの力が最大になる時期）',
    'Greene ほか 2009, ISB 抄録（エルゴのドライブは 1 本の 44%）',
    'Vieira ほか 2020, Sensors 20:1666（脚の筋電図の時期）',
    'Nowicky ほか 2005, J Sports Sci Med 4:18（背中と太ももの裏の筋電図の時期）',
  ],
  bike: [
    'Candotti ほか 2007, Sports Biomech 6:31（ペダルの力は踏み下ろしで正）',
    'da Silva ほか 2018, PLoS ONE 13:e0201014（太ももの筋電図の角度）',
    'Hug ほか 2013, Front Physiol 4:232（回転の区分）',
  ],
}
