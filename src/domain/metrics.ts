// 姿勢指標の計算（docs/05-analysis-logic.md の定義どおり）
import type { ComputedMetric, Landmark, MetricKey, MetricUnit, Plane, PlaneRecord, Point } from './types'
import {
  CONFIDENCE_CAP,
  COMPOSITE_SCALE,
  LANDMARK_SIGMA_FRACTION,
  MIN_VISIBILITY,
  NOTICEABLE_K,
  PERTURBATION_SAMPLES,
  QUALITY_CONFIDENCE_FACTOR,
} from './constants'
import {
  angleFromVerticalDeg,
  dist,
  gaussian,
  hashString,
  interiorAngleDeg,
  mid,
  perpendicular,
  rng,
  sign,
  std,
  tiltDeg,
} from './geometry'
import { LM, landmarkName, sidePoints } from './landmarks'

// ---------- 入力 ----------

export interface PlaneInput {
  plane: Plane
  landmarks: Landmark[]
  width: number
  height: number
  correctedIdx: Set<number>
  /** 品質フラグから求めた信頼度係数 */
  qualityFactor: number
  facing?: 'left' | 'right'
  nearSide?: 'left' | 'right'
}

type Getter = (i: number) => Point

interface Ctx {
  plane: Plane
  /** 正面: 被写体の左が画像の右なら +1 */
  sLat: number
  /** 側面: 顔が画像の右を向いていれば +1 */
  f: number
  side: ReturnType<typeof sidePoints>
  /** 体の高さ（ピクセル）。摂動の大きさと正規化に使う。摂動中も固定 */
  H: number
  isValid: (i: number) => boolean
}

type ComputeResult = { raw: number; norm: number | null; note?: string } | { fail: string }

interface MetricDef {
  key: MetricKey
  label: string
  plane: Plane
  group: ComputedMetric['group']
  unit: MetricUnit
  normalizedUnit?: string
  kind: 'judged' | 'descriptive' | 'unsupported'
  landmarks: (ctx: Ctx) => number[]
  compute: (p: Getter, ctx: Ctx) => ComputeResult
  direction: (raw: number) => string
  unsupportedNote?: string
}

// ---------- 共通 ----------

export function visibilityOf(lm: Landmark | undefined): number {
  if (!lm) return 0
  return Math.min(lm.visibility ?? 1, lm.presence ?? 1)
}

function inFrame(lm: Landmark): boolean {
  return lm.x >= 0 && lm.x <= 1 && lm.y >= 0 && lm.y <= 1
}

const pctOf = (v: number, base: number) => (v / base) * 100

function lateralSign(p: Getter): number {
  const s = p(LM.leftShoulder).x - p(LM.rightShoulder).x + (p(LM.leftHip).x - p(LM.rightHip).x)
  return s >= 0 ? 1 : -1
}

/** 体の高さ H（ピクセル）。耳（なければ鼻）からかかと（なければ足首）までの縦の距離 */
export function bodyHeightPx(plane: Plane, p: Getter, isValid: (i: number) => boolean, nearSide?: 'left' | 'right'): number | null {
  let top: number | null = null
  let bottom: number | null = null
  if (plane === 'front') {
    if (isValid(LM.leftEar) && isValid(LM.rightEar)) top = mid(p(LM.leftEar), p(LM.rightEar)).y
    else if (isValid(LM.nose)) top = p(LM.nose).y
    if (isValid(LM.leftHeel) && isValid(LM.rightHeel)) bottom = mid(p(LM.leftHeel), p(LM.rightHeel)).y
    else if (isValid(LM.leftAnkle) && isValid(LM.rightAnkle)) bottom = mid(p(LM.leftAnkle), p(LM.rightAnkle)).y
  } else {
    const s = sidePoints(nearSide ?? 'left')
    if (isValid(s.ear)) top = p(s.ear).y
    else if (isValid(LM.nose)) top = p(LM.nose).y
    if (isValid(s.heel)) bottom = p(s.heel).y
    else if (isValid(s.ankle)) bottom = p(s.ankle).y
  }
  if (top === null || bottom === null) return null
  const h = bottom - top
  return h > 0 ? h : null
}

// ---------- 正面の指標 ----------

const FRONT: MetricDef[] = [
  {
    key: 'front_body_lean',
    label: '全身の左右傾斜',
    plane: 'front',
    group: 'alignment',
    unit: '°',
    normalizedUnit: '% (体の高さ比)',
    kind: 'judged',
    landmarks: () => [LM.leftShoulder, LM.rightShoulder, LM.leftAnkle, LM.rightAnkle, LM.leftHip, LM.rightHip],
    compute: (p, c) => {
      const sh = mid(p(LM.leftShoulder), p(LM.rightShoulder))
      const an = mid(p(LM.leftAnkle), p(LM.rightAnkle))
      return { raw: angleFromVerticalDeg(an, sh, c.sLat), norm: pctOf((sh.x - an.x) * c.sLat, c.H) }
    },
    direction: (v) => (v >= 0 ? '上半身が左へ傾く方向' : '上半身が右へ傾く方向'),
  },
  {
    key: 'front_shoulder_tilt',
    label: '肩の高さの左右差',
    plane: 'front',
    group: 'alignment',
    unit: '°',
    normalizedUnit: '% (胴の長さ比)',
    kind: 'judged',
    landmarks: () => [LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip],
    compute: (p, c) => {
      const l = p(LM.leftShoulder)
      const r = p(LM.rightShoulder)
      if (Math.abs(l.x - r.x) < 0.05 * c.H) return { fail: '両肩の横幅が小さすぎます（正面を向いていない可能性）' }
      const T = dist(mid(l, r), mid(p(LM.leftHip), p(LM.rightHip)))
      return { raw: tiltDeg(l, r), norm: pctOf(l.y - r.y, T) }
    },
    direction: (v) => (v >= 0 ? '左肩が低い' : '右肩が低い'),
  },
  {
    key: 'front_pelvis_tilt',
    label: '骨盤付近の左右差',
    plane: 'front',
    group: 'alignment',
    unit: '°',
    normalizedUnit: '% (胴の長さ比)',
    kind: 'judged',
    landmarks: () => [LM.leftHip, LM.rightHip, LM.leftShoulder, LM.rightShoulder],
    compute: (p, c) => {
      const l = p(LM.leftHip)
      const r = p(LM.rightHip)
      if (Math.abs(l.x - r.x) < 0.05 * c.H) return { fail: '股関節の横幅が小さすぎます（正面を向いていない可能性）' }
      const T = dist(mid(p(LM.leftShoulder), p(LM.rightShoulder)), mid(l, r))
      return { raw: tiltDeg(l, r), norm: pctOf(l.y - r.y, T) }
    },
    direction: (v) => (v >= 0 ? '左側が低い' : '右側が低い'),
  },
  {
    key: 'front_head_tilt',
    label: '頭部の左右傾き',
    plane: 'front',
    group: 'alignment',
    unit: '°',
    kind: 'judged',
    landmarks: (c) =>
      c.isValid(LM.leftEar) && c.isValid(LM.rightEar)
        ? [LM.leftEar, LM.rightEar]
        : [LM.leftEyeOuter, LM.rightEyeOuter],
    compute: (p, c) => {
      const useEars = c.isValid(LM.leftEar) && c.isValid(LM.rightEar)
      const l = p(useEars ? LM.leftEar : LM.leftEyeOuter)
      const r = p(useEars ? LM.rightEar : LM.rightEyeOuter)
      return {
        raw: tiltDeg(l, r),
        norm: null,
        note: useEars ? undefined : '耳が検出できなかったため、目尻で代用しています',
      }
    },
    direction: (v) => (v >= 0 ? '頭が左へ傾く方向' : '頭が右へ傾く方向'),
  },
  {
    key: 'front_trunk_shift',
    label: '体幹の左右偏位（参考）',
    plane: 'front',
    group: 'alignment',
    unit: '%',
    normalizedUnit: '% (胴の長さ比)',
    kind: 'judged',
    landmarks: () => [LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip],
    compute: (p, c) => {
      const sh = mid(p(LM.leftShoulder), p(LM.rightShoulder))
      const hp = mid(p(LM.leftHip), p(LM.rightHip))
      const v = pctOf((sh.x - hp.x) * c.sLat, dist(sh, hp))
      return { raw: v, norm: v }
    },
    direction: (v) => (v >= 0 ? '胸のあたりが骨盤より左へ' : '胸のあたりが骨盤より右へ'),
  },
  kneeFront('left'),
  kneeFront('right'),
  {
    key: 'front_load_shift',
    label: '左右荷重の傾向（参考推定）',
    plane: 'front',
    group: 'alignment',
    unit: '%',
    normalizedUnit: '% (股関節の幅比)',
    kind: 'judged',
    landmarks: () => [LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip, LM.leftAnkle, LM.rightAnkle],
    compute: (p, c) => {
      const hipW = dist(p(LM.leftHip), p(LM.rightHip))
      if (hipW < 0.05 * c.H) return { fail: '股関節の横幅が小さすぎます（正面を向いていない可能性）' }
      const center = mid(mid(p(LM.leftShoulder), p(LM.rightShoulder)), mid(p(LM.leftHip), p(LM.rightHip)))
      const base = mid(p(LM.leftAnkle), p(LM.rightAnkle))
      const v = pctOf((center.x - base.x) * c.sLat, hipW)
      return { raw: v, norm: v }
    },
    direction: (v) => (v >= 0 ? '体の中心が左足側へ寄る' : '体の中心が右足側へ寄る'),
  },
]

function kneeFront(side: 'left' | 'right'): MetricDef {
  const L = side === 'left'
  const hip = L ? LM.leftHip : LM.rightHip
  const knee = L ? LM.leftKnee : LM.rightKnee
  const ankle = L ? LM.leftAnkle : LM.rightAnkle
  return {
    key: L ? 'front_knee_left' : 'front_knee_right',
    label: L ? '脚のアライメント（左）' : '脚のアライメント（右）',
    plane: 'front',
    group: 'alignment',
    unit: '°',
    normalizedUnit: '% (脚の長さ比)',
    kind: 'judged',
    landmarks: () => [hip, knee, ankle, LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip],
    compute: (p, c) => {
      const H_ = p(hip)
      const K = p(knee)
      const A = p(ankle)
      const legLen = dist(H_, A)
      if (legLen < 0.25 * c.H) return { fail: '脚が短く写っています（全身が入っていない可能性）' }
      const e = perpendicular(K, H_, A)
      // 被写体の左脚の外側は +sLat 方向、右脚の外側は −sLat 方向
      const outward = L ? c.sLat : -c.sLat
      const s = sign(e.x * outward) || 1
      const angle = 180 - interiorAngleDeg(H_, K, A)
      return { raw: angle * s, norm: pctOf(Math.hypot(e.x, e.y) * s, legLen) }
    },
    direction: (v) => (v >= 0 ? '膝が外側へ出る方向（O脚に関連）' : '膝が内側へ入る方向（X脚に関連）'),
  }
}

// ---------- 側面の指標 ----------

const SIDE: MetricDef[] = [
  {
    key: 'side_head_forward',
    label: '頭部前方位の参考指標',
    plane: 'side',
    group: 'alignment',
    unit: '°',
    normalizedUnit: '% (胴の長さ比)',
    kind: 'judged',
    landmarks: (c) => [c.side.ear, c.side.shoulder, c.side.hip],
    compute: (p, c) => {
      const E = p(c.side.ear)
      const S = p(c.side.shoulder)
      const T = dist(S, p(c.side.hip))
      return { raw: angleFromVerticalDeg(S, E, c.f), norm: pctOf((E.x - S.x) * c.f, T) }
    },
    direction: (v) => (v >= 0 ? '耳が肩より前にある' : '耳が肩より後ろにある'),
  },
  {
    key: 'side_trunk_lean',
    label: '体幹の前後傾',
    plane: 'side',
    group: 'alignment',
    unit: '°',
    normalizedUnit: '% (胴の長さ比)',
    kind: 'judged',
    landmarks: (c) => [c.side.shoulder, c.side.hip],
    compute: (p, c) => {
      const S = p(c.side.shoulder)
      const P = p(c.side.hip)
      return { raw: angleFromVerticalDeg(P, S, c.f), norm: pctOf((S.x - P.x) * c.f, dist(S, P)) }
    },
    direction: (v) => (v >= 0 ? '前に傾く方向' : '後ろに傾く方向'),
  },
  {
    key: 'side_arm_forward',
    label: '腕の前方位置（巻き肩に関連する参考特徴）',
    plane: 'side',
    group: 'alignment',
    unit: '%',
    normalizedUnit: '% (胴の長さ比)',
    kind: 'judged',
    landmarks: (c) => [c.side.wrist, c.side.hip, c.side.shoulder],
    compute: (p, c) => {
      const T = dist(p(c.side.shoulder), p(c.side.hip))
      const v = pctOf((p(c.side.wrist).x - p(c.side.hip).x) * c.f, T)
      return { raw: v, norm: v }
    },
    direction: (v) => (v >= 0 ? '手首が股関節より前にある' : '手首が股関節より後ろにある'),
  },
  {
    key: 'side_hip_forward',
    label: '骨盤帯の前後位置',
    plane: 'side',
    group: 'alignment',
    unit: '%',
    normalizedUnit: '% (体の高さ比)',
    kind: 'judged',
    landmarks: (c) => [c.side.ankle, c.side.hip, c.side.shoulder],
    compute: (p, c) => {
      const e = perpendicular(p(c.side.hip), p(c.side.ankle), p(c.side.shoulder))
      const s = sign(e.x * c.f) || 1
      const v = pctOf(Math.hypot(e.x, e.y) * s, c.H)
      return { raw: v, norm: v }
    },
    direction: (v) => (v >= 0 ? '骨盤のあたりが体の線より前' : '骨盤のあたりが体の線より後ろ'),
  },
  {
    key: 'side_knee_extension',
    label: '膝過伸展傾向の参考指標',
    plane: 'side',
    group: 'alignment',
    unit: '°',
    normalizedUnit: '% (脚の長さ比)',
    kind: 'judged',
    landmarks: (c) => [c.side.hip, c.side.knee, c.side.ankle],
    compute: (p, c) => {
      const P = p(c.side.hip)
      const K = p(c.side.knee)
      const A = p(c.side.ankle)
      const legLen = dist(P, A)
      if (legLen < 0.25 * c.H) return { fail: '脚が短く写っています（全身が入っていない可能性）' }
      const e = perpendicular(K, P, A)
      // 膝が線より後ろ（前方と逆）にあるとき + （伸びすぎの方向）
      const s = sign(e.x * c.f) < 0 ? 1 : -1
      const angle = 180 - interiorAngleDeg(P, K, A)
      return { raw: angle * s, norm: pctOf(Math.hypot(e.x, e.y) * s, legLen) }
    },
    direction: (v) => (v >= 0 ? '膝が後ろへ押し込まれる方向' : '膝が軽く曲がっている方向'),
  },
  plumb('side_plumb_ear', '耳の前後位置（足首基準）', 'ear'),
  plumb('side_plumb_shoulder', '肩の前後位置（足首基準）', 'shoulder'),
  plumb('side_plumb_hip', '股関節の前後位置（足首基準）', 'hip'),
  plumb('side_plumb_knee', '膝の前後位置（足首基準）', 'knee'),
  {
    key: 'side_pelvis_tilt',
    label: '骨盤の前後傾',
    plane: 'side',
    group: 'alignment',
    unit: '°',
    kind: 'unsupported',
    landmarks: () => [],
    compute: () => ({ fail: '' }),
    direction: () => '',
    unsupportedNote:
      '骨盤の前端・後端の目印が MediaPipe にないため、この写真からは推定できません。参考として「骨盤帯の前後位置」を見てください。',
  },
]

function plumb(key: MetricKey, label: string, part: 'ear' | 'shoulder' | 'hip' | 'knee'): MetricDef {
  return {
    key,
    label,
    plane: 'side',
    group: 'relative',
    unit: '%',
    normalizedUnit: '% (体の高さ比)',
    kind: 'descriptive',
    landmarks: (c) => [c.side[part], c.side.ankle],
    compute: (p, c) => {
      const v = pctOf((p(c.side[part]).x - p(c.side.ankle).x) * c.f, c.H)
      return { raw: v, norm: v }
    },
    direction: (v) => (v >= 0 ? '足首より前' : '足首より後ろ'),
  }
}

// ---------- 複合指標 ----------

function defOf(key: MetricKey): MetricDef {
  const d = [...FRONT, ...SIDE].find((m) => m.key === key)
  if (!d) throw new Error(`unknown metric ${key}`)
  return d
}

interface CompositeComponent {
  key: MetricKey
  scale: number
  invert?: boolean
  required: boolean
}

function composite(key: MetricKey, label: string, components: CompositeComponent[]): MetricDef {
  const available = (c: Ctx) =>
    components.filter((cc) => defOf(cc.key).landmarks(c).every((i) => c.isValid(i)))
  return {
    key,
    label,
    plane: 'side',
    group: 'composite',
    unit: 'score',
    kind: 'judged',
    landmarks: (c) => {
      const comps = available(c)
      const missingRequired = components.some((cc) => cc.required && !comps.includes(cc))
      // 必須成分が欠けていれば、必須成分の点をそのまま返して評価不可にする
      const use = missingRequired ? components.filter((cc) => cc.required) : comps
      return [...new Set(use.flatMap((cc) => defOf(cc.key).landmarks(c)))]
    },
    compute: (p, c) => {
      const comps = available(c)
      const values: number[] = []
      for (const cc of comps) {
        const r = defOf(cc.key).compute(p, c)
        if ('fail' in r) {
          if (cc.required) return { fail: r.fail }
          continue
        }
        values.push(((cc.invert ? -1 : 1) * r.raw) / cc.scale)
      }
      if (values.length === 0) return { fail: '成分を計算できません' }
      return { raw: values.reduce((s, v) => s + v, 0) / values.length, norm: null }
    },
    direction: (v) => (v >= 0 ? '関連する特徴の方向' : '関連する特徴と逆の方向'),
  }
}

const K = COMPOSITE_SCALE
const COMPOSITES: MetricDef[] = [
  composite('composite_kyphosis', '猫背傾向スコア', [
    { key: 'side_head_forward', scale: K.kyphosis.headForwardDeg, required: true },
    { key: 'side_trunk_lean', scale: K.kyphosis.trunkLeanDeg, required: true },
    { key: 'side_arm_forward', scale: K.kyphosis.armForwardPct, required: false },
  ]),
  composite('composite_swayback', '反り腰関連スコア', [
    { key: 'side_hip_forward', scale: K.swayback.hipForwardPct, required: true },
    { key: 'side_knee_extension', scale: K.swayback.kneeExtensionDeg, required: true },
    { key: 'side_trunk_lean', scale: K.swayback.trunkBackDeg, invert: true, required: false },
  ]),
]

export const METRIC_DEFS: MetricDef[] = [...FRONT, ...SIDE, ...COMPOSITES]

export function metricLabel(key: MetricKey): string {
  return METRIC_DEFS.find((m) => m.key === key)?.label ?? key
}

/** 改善の方向が「0 に近づく」指標か（記述のみの指標は false） */
export function prefersTowardZero(key: MetricKey): boolean {
  const d = METRIC_DEFS.find((m) => m.key === key)
  return d?.kind === 'judged'
}

// ---------- 計算本体 ----------

function qualityFactorOf(record: PlaneRecord): number {
  return record.qualityFlags.reduce((f, q) => f * (QUALITY_CONFIDENCE_FACTOR[q.key] ?? 1), 1)
}

export function planeInputFrom(record: PlaneRecord, useCorrected: boolean): PlaneInput {
  const corrected = useCorrected ? new Set(record.correctionLog.map((c) => c.index)) : new Set<number>()
  // 補正ログで元の位置に戻した点は補正済みに含めない
  if (useCorrected) {
    for (const idx of [...corrected]) {
      const a = record.landmarksCorrected[idx]
      const b = record.landmarksRaw[idx]
      if (a && b && a.x === b.x && a.y === b.y) corrected.delete(idx)
    }
  }
  return {
    plane: record.plane,
    landmarks: useCorrected ? record.landmarksCorrected : record.landmarksRaw,
    width: record.imageMetadata.width,
    height: record.imageMetadata.height,
    correctedIdx: corrected,
    qualityFactor: qualityFactorOf(record),
    facing: record.imageMetadata.facing,
    nearSide: record.imageMetadata.nearSide,
  }
}

export function computePlaneMetrics(input: PlaneInput): ComputedMetric[] {
  const { landmarks, width, height, correctedIdx } = input
  const pts: Point[] = landmarks.map((lm) => ({ x: lm.x * width, y: lm.y * height }))
  const base: Getter = (i) => pts[i]
  const vis = (i: number) => (correctedIdx.has(i) ? 1 : visibilityOf(landmarks[i]))
  const isValid = (i: number) => !!landmarks[i] && inFrame(landmarks[i]) && vis(i) >= MIN_VISIBILITY

  const nearSide = input.nearSide ?? 'left'
  const H = bodyHeightPx(input.plane, base, isValid, nearSide)
  const ctx: Ctx = {
    plane: input.plane,
    sLat: input.plane === 'front' && landmarks.length >= 33 ? lateralSign(base) : 1,
    f: input.facing === 'left' ? -1 : 1,
    side: sidePoints(nearSide),
    H: H ?? height * 0.7,
    isValid,
  }
  const sigmaPx = LANDMARK_SIGMA_FRACTION * ctx.H
  const defs = METRIC_DEFS.filter((d) => d.plane === input.plane)

  return defs.map((def) => {
    const shell: ComputedMetric = {
      key: def.key,
      label: def.label,
      plane: def.plane,
      group: def.group,
      rawValue: null,
      unit: def.unit,
      normalizedValue: null,
      normalizedUnit: def.normalizedUnit,
      direction: '',
      uncertainty: null,
      status: 'unassessable',
      confidence: 0,
      usedLandmarks: [],
      correctedLandmarks: [],
    }
    if (def.kind === 'unsupported') {
      return { ...shell, status: 'unsupported', qualityNote: def.unsupportedNote }
    }
    if (landmarks.length < 33) {
      return { ...shell, qualityNote: '人物が検出されていません' }
    }
    if (H === null) {
      return { ...shell, qualityNote: '頭と足元の位置が分からないため、体の大きさを決められません' }
    }
    const used = def.landmarks(ctx)
    const invalid = used.filter((i) => !isValid(i))
    if (invalid.length > 0) {
      return {
        ...shell,
        usedLandmarks: used,
        qualityNote: `${invalid.map(landmarkName).join('・')}の位置を確認できないため評価できません`,
      }
    }
    const result = def.compute(base, ctx)
    if ('fail' in result) {
      return { ...shell, usedLandmarks: used, qualityNote: result.fail }
    }

    // 不確かさ: 使用点を σ だけ乱数でずらして再計算した標準偏差
    const rand = rng(hashString(def.key))
    const samples: number[] = []
    for (let n = 0; n < PERTURBATION_SAMPLES; n++) {
      const jitter = new Map<number, Point>()
      for (const i of used) {
        jitter.set(i, { x: pts[i].x + gaussian(rand) * sigmaPx, y: pts[i].y + gaussian(rand) * sigmaPx })
      }
      const getter: Getter = (i) => jitter.get(i) ?? pts[i]
      const r = def.compute(getter, ctx)
      if (!('fail' in r) && Number.isFinite(r.raw)) samples.push(r.raw)
    }
    const uncertainty = samples.length > 10 ? std(samples) : null

    const minVis = Math.min(...used.map(vis))
    const cap = CONFIDENCE_CAP[def.key] ?? 1
    const confidence = Math.max(0, Math.min(cap, minVis * input.qualityFactor))

    let status: ComputedMetric['status']
    if (def.kind === 'descriptive') status = 'descriptive'
    else if (uncertainty !== null && Math.abs(result.raw) > NOTICEABLE_K * uncertainty) status = 'noticeable'
    else status = 'within_noise'

    const metric: ComputedMetric = {
      ...shell,
      rawValue: round(result.raw, 2),
      normalizedValue: result.norm === null ? null : round(result.norm, 2),
      direction: def.direction(result.raw),
      uncertainty: uncertainty === null ? null : round(uncertainty, 3),
      status,
      confidence: round(confidence, 3),
      qualityNote: result.note,
      usedLandmarks: used,
      correctedLandmarks: used.filter((i) => correctedIdx.has(i)),
    }
    if (def.group === 'composite') metric.components = compositeComponents(def.key, base, ctx)
    return metric
  })
}

function compositeComponents(key: MetricKey, p: Getter, c: Ctx): ComputedMetric['components'] {
  const spec =
    key === 'composite_kyphosis'
      ? [
          { key: 'side_head_forward' as MetricKey, scale: K.kyphosis.headForwardDeg },
          { key: 'side_trunk_lean' as MetricKey, scale: K.kyphosis.trunkLeanDeg },
          { key: 'side_arm_forward' as MetricKey, scale: K.kyphosis.armForwardPct },
        ]
      : [
          { key: 'side_hip_forward' as MetricKey, scale: K.swayback.hipForwardPct },
          { key: 'side_knee_extension' as MetricKey, scale: K.swayback.kneeExtensionDeg },
          { key: 'side_trunk_lean' as MetricKey, scale: -K.swayback.trunkBackDeg },
        ]
  const out: NonNullable<ComputedMetric['components']> = []
  for (const s of spec) {
    const d = defOf(s.key)
    if (!d.landmarks(c).every((i) => c.isValid(i))) continue
    const r = d.compute(p, c)
    if ('fail' in r) continue
    out.push({ key: s.key, value: round(r.raw, 2), scale: s.scale })
  }
  return out
}

function round(v: number, digits: number): number {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

/** 正面・側面のレコードから全指標を計算する */
export function computeAllMetrics(
  front: PlaneRecord | undefined,
  side: PlaneRecord | undefined,
  useCorrected = true,
): ComputedMetric[] {
  const out: ComputedMetric[] = []
  if (front) out.push(...computePlaneMetrics(planeInputFrom(front, useCorrected)))
  if (side) out.push(...computePlaneMetrics(planeInputFrom(side, useCorrected)))
  return out
}

/** 指標の一覧から平面ごとの信頼度（評価できた指標の平均）を求める */
export function confidenceSummary(metrics: ComputedMetric[]): { overall: number; front?: number; side?: number } {
  const avg = (plane?: Plane) => {
    const list = metrics.filter(
      (m) => (!plane || m.plane === plane) && m.rawValue !== null && m.status !== 'unsupported',
    )
    if (list.length === 0) return undefined
    return round(list.reduce((s, m) => s + m.confidence, 0) / list.length, 3)
  }
  return { overall: avg() ?? 0, front: avg('front'), side: avg('side') }
}
