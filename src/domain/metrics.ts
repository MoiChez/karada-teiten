// 姿勢指標の計算（docs/05-analysis-logic.md の定義どおり）
import type { BurstInfo, ComputedMetric, EdgeLine, Landmark, MetricKey, MetricUnit, Plane, PlaneRecord, Point } from './types'
import {
  BACK_EDGE_SIGMA_FRACTION,
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
import { backLower, backSideOf, backUpper, type BackLower, type BackShapeInput, type BackUpper } from './backContour'

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
  /** 点の位置の誤差（体の高さ H に対する比、1σ）。省略時は想定値 LANDMARK_SIGMA_FRACTION */
  sigmaFraction?: number
  /** 複数枚撮りの各撮影の点（landmarks と同じ座標系）。1 枚ごとの値を出すのに使う */
  frames?: Landmark[][]
  /** 側面: 背中側の輪郭（正規化座標）。この機能より前の記録にはなく、そのときは輪郭の指標を出さない */
  back?: EdgeLine
  /** 側面・複数枚撮り: 各撮影の背中側の輪郭（frames と同じ順） */
  backFrames?: (Point[] | null)[]
  /** 鏡の前で自撮りした写真（スマホを持つ腕の位置は評価しない） */
  mirrorSelfie?: boolean
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
  /** 側面: 背中側の輪郭（ピクセル） */
  back?: Point[]
  /** 背中側の輪郭を取れなかった理由 */
  backNote?: string
  /** 不確かさの計算中だけ: 輪郭から取った点を後ろ向きにずらす量（ピクセル） */
  backJitter?: (key: string) => number
  /** 鏡の前で自撮りした写真 */
  mirrorSelfie?: boolean
}

/** len: 位置のずれ・高さの差などの長さ（ピクセル、raw と同じ向きで符号付き）。cm 換算に使う */
type ComputeResult = { raw: number; norm: number | null; note?: string; len?: number } | { fail: string }

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
  /** len を返す指標で、その長さが何を表すか（画面表示用） */
  offsetLabel?: string
  /** 背中側の輪郭を使う指標 */
  usesBack?: boolean
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

/** 鏡の前で自撮りした写真で、値の読み方に気をつけたい指標 */
const MIRROR_NOTES: Partial<Record<MetricKey, string>> = {
  front_shoulder_tilt: 'スマホを持つ側の肩が上がりやすいため、置いて撮った測定とは比べにくい値です。',
  front_head_tilt: '撮る瞬間に画面を見ていると、頭の傾きが変わります。',
  side_head_forward: '撮る瞬間に画面を見ていると、頭が前に出たり下を向いたりしやすくなります。',
  side_head_pitch: '撮る瞬間に画面を見ていると、顔が下を向きやすくなります。',
}

/** 背中の輪郭の計算に渡す値。腕・手の点（確認できたものだけ）は、輪郭に重なっていないかの確認に使う */
function backInput(p: Getter, c: Ctx): BackShapeInput | { fail: string } {
  if (!c.back || c.back.length === 0) return { fail: c.backNote ?? '背中の輪郭を取り出せませんでした' }
  const arms: Point[] = []
  for (const [sh, el, ...rest] of [
    [LM.leftShoulder, 13, 15, 17, 19, 21],
    [LM.rightShoulder, 14, 16, 18, 20, 22],
  ]) {
    if (c.isValid(el)) {
      arms.push(p(el))
      if (c.isValid(sh)) arms.push(mid(p(sh), p(el)))
    }
    for (const i of rest) if (c.isValid(i)) arms.push(p(i))
  }
  return { contour: c.back, shoulderY: p(c.side.shoulder).y, hipY: p(c.side.hip).y, H: c.H, f: c.f, arms, jitter: c.backJitter }
}

/** 記述のみの指標で、差の向きを言葉にする（「〜へ約 X 変わった」の「〜」） */
export function towardPhrase(key: MetricKey, diff: number): string {
  switch (key) {
    case 'side_head_pitch':
      return diff >= 0 ? '下向きの方向' : '上向きの方向'
    case 'side_back_upper':
      return diff >= 0 ? '丸みが強い方向' : '丸みが弱い方向'
    case 'side_back_lower':
      return diff >= 0 ? 'すき間が深い方向' : 'すき間が浅い方向'
    default:
      return diff >= 0 ? '前の方向' : '後ろの方向'
  }
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
    label: '全身の左右傾き',
    plane: 'front',
    group: 'alignment',
    unit: '°',
    normalizedUnit: '% (体の高さ比)',
    kind: 'judged',
    landmarks: () => [LM.leftShoulder, LM.rightShoulder, LM.leftAnkle, LM.rightAnkle, LM.leftHip, LM.rightHip],
    compute: (p, c) => {
      const sh = mid(p(LM.leftShoulder), p(LM.rightShoulder))
      const an = mid(p(LM.leftAnkle), p(LM.rightAnkle))
      const len = (sh.x - an.x) * c.sLat
      return { raw: angleFromVerticalDeg(an, sh, c.sLat), norm: pctOf(len, c.H), len }
    },
    direction: (v) => (v >= 0 ? '全身が左へ傾く方向' : '全身が右へ傾く方向'),
    offsetLabel: '肩の中心の位置（足元の中心から）',
  },
  {
    key: 'front_trunk_shift',
    label: '上半身の左右傾き',
    plane: 'front',
    group: 'alignment',
    unit: '°',
    normalizedUnit: '% (胴の長さ比)',
    kind: 'judged',
    landmarks: () => [LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip],
    compute: (p, c) => {
      const sh = mid(p(LM.leftShoulder), p(LM.rightShoulder))
      const hp = mid(p(LM.leftHip), p(LM.rightHip))
      const len = (sh.x - hp.x) * c.sLat
      return { raw: angleFromVerticalDeg(hp, sh, c.sLat), norm: pctOf(len, dist(sh, hp)), len }
    },
    direction: (v) => (v >= 0 ? '上半身が左へ傾く方向' : '上半身が右へ傾く方向'),
    offsetLabel: '胸のあたりの位置（骨盤の中心から）',
  },
  {
    key: 'front_lower_lean',
    label: '下半身の左右傾き',
    plane: 'front',
    group: 'alignment',
    unit: '°',
    normalizedUnit: '% (体の高さ比)',
    kind: 'judged',
    landmarks: () => [LM.leftHip, LM.rightHip, LM.leftAnkle, LM.rightAnkle],
    compute: (p, c) => {
      const hp = mid(p(LM.leftHip), p(LM.rightHip))
      const an = mid(p(LM.leftAnkle), p(LM.rightAnkle))
      const len = (hp.x - an.x) * c.sLat
      return { raw: angleFromVerticalDeg(an, hp, c.sLat), norm: pctOf(len, c.H), len }
    },
    direction: (v) => (v >= 0 ? '下半身が左へ傾く方向（腰が左寄り）' : '下半身が右へ傾く方向（腰が右寄り）'),
    offsetLabel: '腰の位置（足元の中心から）',
  },
  {
    key: 'front_head_tilt',
    label: '頭の左右傾き',
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
    key: 'front_neck_shift',
    label: '首の左右位置ずれ',
    plane: 'front',
    group: 'alignment',
    unit: '%',
    normalizedUnit: '% (体の高さ比)',
    kind: 'judged',
    landmarks: (c) =>
      c.isValid(LM.leftEar) && c.isValid(LM.rightEar)
        ? [LM.leftEar, LM.rightEar, LM.leftShoulder, LM.rightShoulder]
        : [LM.nose, LM.leftShoulder, LM.rightShoulder],
    compute: (p, c) => {
      const useEars = c.isValid(LM.leftEar) && c.isValid(LM.rightEar)
      const head = useEars ? mid(p(LM.leftEar), p(LM.rightEar)) : p(LM.nose)
      const sh = mid(p(LM.leftShoulder), p(LM.rightShoulder))
      const len = (head.x - sh.x) * c.sLat
      const v = pctOf(len, c.H)
      return { raw: v, norm: v, len, note: useEars ? undefined : '耳が検出できなかったため、鼻で代用しています' }
    },
    direction: (v) => (v >= 0 ? '頭の中心が肩の中心より左' : '頭の中心が肩の中心より右'),
    offsetLabel: '頭の中心の位置（肩の中心から）',
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
      return { raw: tiltDeg(l, r), norm: pctOf(l.y - r.y, T), len: l.y - r.y }
    },
    direction: (v) => (v >= 0 ? '左肩が低い' : '右肩が低い'),
    offsetLabel: '高さの差',
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
      return { raw: tiltDeg(l, r), norm: pctOf(l.y - r.y, T), len: l.y - r.y }
    },
    direction: (v) => (v >= 0 ? '左側が低い' : '右側が低い'),
    offsetLabel: '高さの差',
  },
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
      const len = (center.x - base.x) * c.sLat
      const v = pctOf(len, hipW)
      return { raw: v, norm: v, len }
    },
    direction: (v) => (v >= 0 ? '体の中心が左足側へ寄る' : '体の中心が右足側へ寄る'),
    offsetLabel: '体の中心の位置（足元の中心から）',
  },
  kneeFront('left'),
  kneeFront('right'),
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
      const len = Math.hypot(e.x, e.y) * s
      return { raw: angle * s, norm: pctOf(len, legLen), len }
    },
    direction: (v) => (v >= 0 ? '膝が外側へ出る方向（O脚に関連）' : '膝が内側へ入る方向（X脚に関連）'),
    offsetLabel: '膝の位置（股関節と足首を結ぶ線から）',
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
      const len = (E.x - S.x) * c.f
      return { raw: angleFromVerticalDeg(S, E, c.f), norm: pctOf(len, T), len }
    },
    direction: (v) => (v >= 0 ? '耳が肩より前にある' : '耳が肩より後ろにある'),
    offsetLabel: '耳の位置（肩から前後に）',
  },
  {
    key: 'side_trunk_lean',
    label: '上半身の前後傾き',
    plane: 'side',
    group: 'alignment',
    unit: '°',
    normalizedUnit: '% (胴の長さ比)',
    kind: 'judged',
    landmarks: (c) => [c.side.shoulder, c.side.hip],
    compute: (p, c) => {
      const S = p(c.side.shoulder)
      const P = p(c.side.hip)
      const len = (S.x - P.x) * c.f
      return { raw: angleFromVerticalDeg(P, S, c.f), norm: pctOf(len, dist(S, P)), len }
    },
    direction: (v) => (v >= 0 ? '前に傾く方向' : '後ろに傾く方向'),
    offsetLabel: '肩の位置（股関節から前後に）',
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
      if (c.mirrorSelfie) return { fail: '鏡の前で自撮りした写真では、スマホを持つ腕の位置が変わるため評価しません' }
      const T = dist(p(c.side.shoulder), p(c.side.hip))
      const len = (p(c.side.wrist).x - p(c.side.hip).x) * c.f
      const v = pctOf(len, T)
      return { raw: v, norm: v, len }
    },
    direction: (v) => (v >= 0 ? '手首が股関節より前にある' : '手首が股関節より後ろにある'),
    offsetLabel: '手首の位置（股関節から前後に）',
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
      const len = Math.hypot(e.x, e.y) * s
      const v = pctOf(len, c.H)
      return { raw: v, norm: v, len }
    },
    direction: (v) => (v >= 0 ? '骨盤のあたりが体の線より前' : '骨盤のあたりが体の線より後ろ'),
    offsetLabel: '骨盤帯の位置（足首と肩を結ぶ線から）',
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
      const len = Math.hypot(e.x, e.y) * s
      return { raw: angle * s, norm: pctOf(len, legLen), len }
    },
    direction: (v) => (v >= 0 ? '膝が後ろへ押し込まれる方向' : '膝が軽く曲がっている方向'),
    offsetLabel: '膝の位置（股関節と足首を結ぶ線から）',
  },
  plumbAngle('side_plumb_shoulder', '全身の前後傾き', 'shoulder', '全身', '肩の位置（足首から前後に）'),
  plumbAngle('side_plumb_hip', '下半身の前後傾き', 'hip', '下半身', '股関節の位置（足首から前後に）'),
  plumb('side_plumb_ear', '耳の前後位置（足首基準）', 'ear'),
  plumb('side_plumb_knee', '膝の前後位置（足首基準）', 'knee'),
  {
    key: 'side_head_pitch',
    label: '頭の前後傾き（顔の上下の向き）',
    plane: 'side',
    group: 'relative',
    unit: '°',
    kind: 'descriptive',
    landmarks: (c) => [c.side.ear, c.side.eye],
    compute: (p, c) => {
      const E = p(c.side.ear)
      const Y = p(c.side.eye)
      const ahead = (Y.x - E.x) * c.f
      if (ahead <= 0) return { fail: '目尻が耳より前に写っていないため、顔の向きを求められません' }
      // 目尻が耳より下にあるとき + （顔が下を向く方向）
      return { raw: (Math.atan2(Y.y - E.y, ahead) * 180) / Math.PI, norm: null }
    },
    direction: (v) => (v >= 0 ? '顔が下を向く方向' : '顔が上を向く方向'),
  },
  {
    key: 'side_back_upper',
    label: '背中上部の丸み（背中の輪郭）',
    plane: 'side',
    group: 'relative',
    unit: '°',
    normalizedUnit: '% (体の高さ比)',
    kind: 'descriptive',
    usesBack: true,
    landmarks: (c) => [c.side.shoulder, c.side.hip],
    compute: (p, c) => {
      const inp = backInput(p, c)
      if ('fail' in inp) return inp
      const r = backUpper(inp)
      if ('fail' in r) return r
      return { raw: r.ok.angleDeg, norm: pctOf(r.ok.depth, c.H), len: r.ok.depth }
    },
    direction: (v) => (v >= 0 ? '背中上部の輪郭が後ろへ丸く出る形（数値が大きいほど丸い）' : '背中上部の輪郭が内側へ反る形'),
    offsetLabel: '膨らみの深さ（肩の高さと胸の下を結ぶ線から）',
  },
  {
    key: 'side_back_lower',
    label: '腰のすき間の深さ（背中の輪郭）',
    plane: 'side',
    group: 'relative',
    unit: '%',
    normalizedUnit: '% (体の高さ比)',
    kind: 'descriptive',
    usesBack: true,
    landmarks: (c) => [c.side.shoulder, c.side.hip],
    compute: (p, c) => {
      const inp = backInput(p, c)
      if ('fail' in inp) return inp
      const r = backLower(inp)
      if ('fail' in r) return r
      const v = pctOf(r.ok.depth, c.H)
      return { raw: v, norm: v, len: r.ok.depth }
    },
    direction: () => '背中とお尻に後ろから定規を当てたときの、腰のすき間（数値が大きいほど深い）',
    offsetLabel: 'すき間の深さ',
  },
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

/** 足首を通る鉛直線から各部がどれだけ前後にあるか（体の高さ比）。良し悪しは判定しない */
function plumb(key: MetricKey, label: string, part: 'ear' | 'knee'): MetricDef {
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
      const len = (p(c.side[part]).x - p(c.side.ankle).x) * c.f
      const v = pctOf(len, c.H)
      return { raw: v, norm: v, len }
    },
    direction: (v) => (v >= 0 ? '足首より前' : '足首より後ろ'),
    offsetLabel: '足首からの距離',
  }
}

/** 足首から肩・股関節へ引いた線の、鉛直からの前後の傾き。良し悪しは判定しない */
function plumbAngle(key: MetricKey, label: string, part: 'shoulder' | 'hip', name: string, offsetLabel: string): MetricDef {
  return {
    key,
    label,
    plane: 'side',
    group: 'relative',
    unit: '°',
    normalizedUnit: '% (体の高さ比)',
    kind: 'descriptive',
    landmarks: (c) => [c.side[part], c.side.ankle],
    compute: (p, c) => {
      const A = p(c.side.ankle)
      const X = p(c.side[part])
      const len = (X.x - A.x) * c.f
      return { raw: angleFromVerticalDeg(A, X, c.f), norm: pctOf(len, c.H), len }
    },
    direction: (v) => (v >= 0 ? `${name}が前へ傾く方向` : `${name}が後ろへ傾く方向`),
    offsetLabel,
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
    sigmaFraction: burstSigmaFraction(record.burst),
    frames: record.burst && record.burst.frames.length >= 2 ? burstFramesCorrected(record, corrected) : undefined,
    // 背中側は今の顔の向きで決める（確認画面で向きを切り替えても正しい側を使う）
    mirrorSelfie: record.imageMetadata.mirrorSelfie,
    back: record.plane === 'side' && record.outline ? backSideOf(record.outline, record.imageMetadata.facing) : undefined,
    backFrames:
      record.plane === 'side' ? record.burst?.outlines?.map((o) => (o ? backSideOf(o, record.imageMetadata.facing) : null)) : undefined,
  }
}

/**
 * 判定に使う点の誤差（H 比、1σ）。想定値を下限にする。
 * 続けて撮った写真の平均で小さくなるのは、写真ごとの点の揺れだけ。服や体格による推定のずれは
 * 何枚撮っても減らないため、平均しても想定値より小さくはしない。
 * 平均した後の揺れ（1 枚あたりの揺れ ÷ √枚数）でも想定値を超えるときだけ、それを使う
 */
export function burstSigmaFraction(b: BurstInfo | undefined): number {
  if (!b || b.frames.length < 2) return LANDMARK_SIGMA_FRACTION
  return Math.max(LANDMARK_SIGMA_FRACTION, (b.spreadFrac ?? 0) / Math.sqrt(b.frames.length))
}

/** 各撮影の点に手動補正を反映する（平均に加えた補正と同じだけ動かす） */
function burstFramesCorrected(record: PlaneRecord, corrected: Set<number>): Landmark[][] {
  const frames = record.burst!.frames
  if (!corrected.size) return frames
  return frames.map((fr) =>
    fr.map((l, i) => {
      if (!corrected.has(i)) return l
      const c = record.landmarksCorrected[i]
      const r = record.landmarksRaw[i]
      // その枚で検出できていなかった点は、補正した位置をそのまま使う
      if (!(visibilityOf(l) >= MIN_VISIBILITY)) return { ...l, x: c.x, y: c.y, visibility: 1 }
      return { ...l, x: l.x + (c.x - r.x), y: l.y + (c.y - r.y), visibility: 1 }
    }),
  )
}

export function computePlaneMetrics(input: PlaneInput): ComputedMetric[] {
  const { landmarks, width, height, correctedIdx } = input
  const pts: Point[] = landmarks.map((lm) => ({ x: lm.x * width, y: lm.y * height }))
  const base: Getter = (i) => pts[i]
  const vis = (i: number) => (correctedIdx.has(i) ? 1 : visibilityOf(landmarks[i]))
  const isValid = (i: number) => !!landmarks[i] && inFrame(landmarks[i]) && vis(i) >= MIN_VISIBILITY

  const nearSide = input.nearSide ?? 'left'
  const H = bodyHeightPx(input.plane, base, isValid, nearSide)
  const toPx = (list: Point[]) => list.map((q) => ({ x: q.x * width, y: q.y * height }))
  const ctx: Ctx = {
    plane: input.plane,
    sLat: input.plane === 'front' && landmarks.length >= 33 ? lateralSign(base) : 1,
    f: input.facing === 'left' ? -1 : 1,
    side: sidePoints(nearSide),
    H: H ?? height * 0.7,
    isValid,
    back: input.back ? toPx(input.back.points) : undefined,
    backNote: input.back?.note,
    mirrorSelfie: input.mirrorSelfie,
  }
  const sigmaPx = (input.sigmaFraction ?? LANDMARK_SIGMA_FRACTION) * ctx.H
  const edgeSigmaPx = BACK_EDGE_SIGMA_FRACTION * ctx.H
  // 背中の輪郭の指標は、輪郭を記録した測定だけで出す
  const defs = METRIC_DEFS.filter((d) => d.plane === input.plane && (!d.usesBack || input.back !== undefined))
  const framePts = (input.frames ?? []).map((fr, k) => {
    const back = input.backFrames?.[k]
    return {
      pts: fr.map((lm) => ({ x: lm.x * width, y: lm.y * height })),
      valid: (i: number) => !!fr[i] && inFrame(fr[i]) && visibilityOf(fr[i]) >= MIN_VISIBILITY,
      back: back && back.length ? toPx(back) : null,
    }
  })

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

    // 不確かさ: 使用点を σ だけ乱数でずらして再計算した標準偏差。
    // 背中の輪郭の指標は、輪郭から取った点（接点・頂点など）も、輪郭の想定誤差だけ前後にずらす
    const rand = rng(hashString(def.key))
    const samples: number[] = []
    const lenSamples: number[] = []
    for (let n = 0; n < PERTURBATION_SAMPLES; n++) {
      const jitter = new Map<number, Point>()
      for (const i of used) {
        jitter.set(i, { x: pts[i].x + gaussian(rand) * sigmaPx, y: pts[i].y + gaussian(rand) * sigmaPx })
      }
      const getter: Getter = (i) => jitter.get(i) ?? pts[i]
      let sctx = ctx
      if (def.usesBack) {
        const offs = new Map<string, number>()
        sctx = {
          ...ctx,
          backJitter: (k) => {
            if (!offs.has(k)) offs.set(k, gaussian(rand) * edgeSigmaPx)
            return offs.get(k)!
          },
        }
      }
      const r = def.compute(getter, sctx)
      if (!('fail' in r) && Number.isFinite(r.raw)) {
        samples.push(r.raw)
        if (r.len !== undefined && Number.isFinite(r.len)) lenSamples.push(r.len)
      }
    }
    const uncertainty = samples.length > 10 ? std(samples) : null

    const minVis = Math.min(...used.map(vis))
    const cap = CONFIDENCE_CAP[def.key] ?? 1
    const confidence = Math.max(0, Math.min(cap, minVis * input.qualityFactor))

    let status: ComputedMetric['status']
    if (def.kind === 'descriptive') status = 'descriptive'
    else if (uncertainty !== null && Math.abs(result.raw) > NOTICEABLE_K * uncertainty) status = 'noticeable'
    else status = 'within_noise'

    const mirrorNote = input.mirrorSelfie ? MIRROR_NOTES[def.key] : undefined
    const metric: ComputedMetric = {
      ...shell,
      rawValue: round(result.raw, 2),
      normalizedValue: result.norm === null ? null : round(result.norm, 2),
      direction: def.direction(result.raw),
      uncertainty: uncertainty === null ? null : round(uncertainty, 3),
      status,
      confidence: round(confidence, 3),
      qualityNote: [result.note, mirrorNote].filter(Boolean).join(' ') || undefined,
      usedLandmarks: used,
      correctedLandmarks: used.filter((i) => correctedIdx.has(i)),
    }
    if (result.len !== undefined && def.offsetLabel) {
      metric.offset = {
        frac: round(result.len / ctx.H, 5),
        sigma: lenSamples.length > 10 ? round(std(lenSamples) / ctx.H, 5) : null,
        label: def.offsetLabel,
      }
    }
    if (def.group === 'composite') metric.components = compositeComponents(def.key, base, ctx)
    if (framePts.length >= 2 && (!def.usesBack || input.backFrames)) {
      metric.burstValues = framePts.map((fp) => {
        if (!used.every(fp.valid)) return null
        if (def.usesBack && !fp.back) return null
        const r = def.compute((i) => fp.pts[i], def.usesBack ? { ...ctx, back: fp.back!, backNote: undefined } : ctx)
        return 'fail' in r || !Number.isFinite(r.raw) ? null : round(r.raw, 2)
      })
      // 輪郭の指標: 1 枚ごとの値の揺れ ÷ √枚数 が想定より大きければ、ばらつきをそれに広げる（狭めはしない）
      const vals = metric.burstValues.filter((v): v is number => v !== null)
      if (def.usesBack && vals.length >= 2 && metric.uncertainty !== null) {
        const measured = std(vals) / Math.sqrt(vals.length)
        if (measured > metric.uncertainty) {
          const k = metric.uncertainty > 0 ? measured / metric.uncertainty : 1
          metric.uncertainty = round(measured, 3)
          if (metric.offset?.sigma != null) metric.offset.sigma = round(metric.offset.sigma * k, 5)
        }
      }
    }
    return metric
  })
}

export interface BackShapeView {
  /** 背中側の輪郭（ピクセル） */
  contour: Point[]
  upper?: BackUpper
  lower?: BackLower
}

/** 画面に描くための背中の輪郭と、丸み・すき間を求めた線（ピクセル）。輪郭がなければ null */
export function backShapeFor(record: PlaneRecord, useCorrected = true): BackShapeView | null {
  if (record.plane !== 'side' || !record.outline) return null
  const input = planeInputFrom(record, useCorrected)
  const { landmarks, width, height, correctedIdx } = input
  if (!input.back?.points.length) return null
  const contour = input.back.points.map((q) => ({ x: q.x * width, y: q.y * height }))
  if (landmarks.length < 33) return { contour }
  const pts: Point[] = landmarks.map((lm) => ({ x: lm.x * width, y: lm.y * height }))
  const p: Getter = (i) => pts[i]
  const isValid = (i: number) =>
    !!landmarks[i] && inFrame(landmarks[i]) && (correctedIdx.has(i) ? 1 : visibilityOf(landmarks[i])) >= MIN_VISIBILITY
  const nearSide = input.nearSide ?? 'left'
  const H = bodyHeightPx('side', p, isValid, nearSide)
  const side = sidePoints(nearSide)
  if (!H || !isValid(side.shoulder) || !isValid(side.hip)) return { contour }
  const ctx: Ctx = { plane: 'side', sLat: 1, f: input.facing === 'left' ? -1 : 1, side, H, isValid, back: contour }
  const inp = backInput(p, ctx)
  if ('fail' in inp) return { contour }
  const u = backUpper(inp)
  const l = backLower(inp)
  return { contour, upper: 'ok' in u ? u.ok : undefined, lower: 'ok' in l ? l.ok : undefined }
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
