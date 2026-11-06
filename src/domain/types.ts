// アプリ全体で使うデータ型。docs/04-data-model.md と対応する

export type Plane = 'front' | 'side'

/** MediaPipe のランドマーク（正規化画像座標 or ワールド座標） */
export interface Landmark {
  x: number
  y: number
  z: number
  visibility?: number
  presence?: number
}

export interface Point {
  x: number
  y: number
}

// ---------- プロフィール ----------

export type GoalTag =
  | 'posture'
  | 'diet'
  | 'body_make'
  | 'relieve_discomfort'
  | 'fatigue'
  | 'appearance'
  | 'health'
  | 'other'

export type LifestyleTag =
  | 'desk_work'
  | 'standing_work'
  | 'physical_work'
  | 'driving'
  | 'smartphone_long'
  | 'bag_one_side'
  | 'crossed_legs'
  | 'housework_childcare'

export type BodyArea =
  | 'neck'
  | 'shoulders'
  | 'upper_back'
  | 'lower_back'
  | 'hips'
  | 'knees'
  | 'feet'
  | 'whole_body'

export type Rating = 1 | 2 | 3 | 4 | 5

export interface UserProfile {
  id: 'me'
  age?: number
  sex?: 'female' | 'male' | 'other' | 'no_answer'
  heightCm?: number
  weightKg?: number
  goals: GoalTag[]
  goalNote?: string
  hasClearGoal: boolean
  activityLevel?: 'low' | 'moderate' | 'high'
  exerciseExperience?: 'none' | 'some' | 'regular'
  lifestyle: LifestyleTag[]
  /** 1 = よく眠れている … 5 = 眠れていない */
  sleepRating?: Rating
  /** 1 = 疲れにくい … 5 = とても疲れやすい */
  fatigueRating?: Rating
  concernAreas: BodyArea[]
  createdAt: string
  updatedAt: string
}

// ---------- 測定 ----------

export type QualitySeverity = 'blocking' | 'major' | 'minor'

export type QualityFlagKey =
  | 'no_pose'
  | 'multiple_people'
  | 'body_cut_off'
  | 'occluded'
  | 'orientation_front'
  | 'orientation_side'
  | 'extreme_tilt'
  | 'too_small'
  | 'low_resolution'
  | 'too_dark'
  | 'too_bright'
  | 'low_contrast'
  | 'blurry'
  | 'device_tilt'
  | 'mirrored_possible'
  | 'uncertain_points'

export interface QualityFlag {
  key: QualityFlagKey
  plane: Plane
  severity: QualitySeverity
  message: string
  /** 判定に使った値（説明用） */
  value?: number
}

export interface ImageStats {
  meanLuma: number
  stdLuma: number
  laplacianVar: number
}

export interface DeviceTilt {
  /** 左右の傾き（0 = 水平に構えている）。度 */
  rollDeg: number
  /** 前後の傾き（90 = 垂直に立てている）。度 */
  pitchDeg: number
}

export interface ImageMetadata {
  width: number
  height: number
  source: 'camera' | 'upload'
  capturedAt: string
  /** 側面: 被写体の顔が画像の左右どちらを向いているか */
  facing?: 'left' | 'right'
  /** 側面: 計算に使ったカメラ側の半身 */
  nearSide?: 'left' | 'right'
  deviceTilt?: DeviceTilt
  imageStats?: ImageStats
  imageId?: string
  /** 2 人目の大きさ（H 比）。複数人の判定用 */
  secondPersonScale?: number
  /** ワールド座標の肩の線から推定した体の回旋（度）。正面なら 0 付近 */
  yawDeg?: number
  /** 鏡の前で自撮りした写真（左右を戻してから分析・保存している） */
  mirrorSelfie?: boolean
}

export interface CorrectionEntry {
  index: number
  from: Point
  to: Point
  at: string
}

/**
 * 続けて複数枚撮ったときの情報。landmarksRaw はこの平均。
 * 各撮影の点は、代表の写真の位置と大きさにそろえてある（正規化座標）
 */
export interface BurstInfo {
  frames: Landmark[][]
  /** 代表の写真（保存・表示する写真）が何枚目か（0 始まり） */
  repIndex: number
  /** 撮影した枚数（骨格を検出できなかった分も含む） */
  attempted: number
  /** 1 枚あたりの点の揺れ（体の高さ H に対する比、1σ）。点が足りず求められなければ null */
  spreadFrac: number | null
  /** 側面: 各撮影の体の左端・右端（frames と同じ順、代表の写真の位置と大きさにそろえてある）。取れなかった枚は null */
  outlines?: ({ left: Point[]; right: Point[] } | null)[]
}

/** 体の端の線 */
export interface EdgeLine {
  /** 正規化画像座標、上から下へ。取れなかったときは空 */
  points: Point[]
  /** 取れなかった理由 */
  note?: string
}

/**
 * 側面: 人の領域の左端と右端（肩より少し上から、股関節より下まで）。
 * どちらが背中側かは顔の向きで決まる（顔が画像の右向きなら左端）。顔の向きをあとから切り替えても使えるよう両方を残す。
 * 服・髪・体つきを含んだ外形で、背骨の形ではない
 */
export interface BodyOutline {
  left: EdgeLine
  right: EdgeLine
}

export interface PlaneRecord {
  plane: Plane
  imageMetadata: ImageMetadata
  landmarksRaw: Landmark[]
  worldLandmarksRaw: Landmark[]
  landmarksCorrected: Landmark[]
  correctionLog: CorrectionEntry[]
  qualityFlags: QualityFlag[]
  burst?: BurstInfo
  /** 側面: 体の輪郭の左端・右端（この機能より前の記録にはない） */
  outline?: BodyOutline
}

// ---------- 指標 ----------

export type MetricKey =
  | 'front_body_lean'
  | 'front_shoulder_tilt'
  | 'front_pelvis_tilt'
  | 'front_head_tilt'
  | 'front_trunk_shift'
  | 'front_lower_lean'
  | 'front_neck_shift'
  | 'front_knee_left'
  | 'front_knee_right'
  | 'front_load_shift'
  | 'side_head_forward'
  | 'side_trunk_lean'
  | 'side_arm_forward'
  | 'side_hip_forward'
  | 'side_knee_extension'
  | 'side_plumb_ear'
  | 'side_plumb_shoulder'
  | 'side_plumb_hip'
  | 'side_plumb_knee'
  | 'side_head_pitch'
  | 'side_pelvis_tilt'
  | 'side_back_upper'
  | 'side_back_lower'
  | 'composite_kyphosis'
  | 'composite_swayback'

export type MetricStatus = 'noticeable' | 'within_noise' | 'descriptive' | 'unassessable' | 'unsupported'

export type MetricUnit = '°' | '%' | 'score'

export interface ComputedMetric {
  key: MetricKey
  label: string
  plane: Plane
  group: 'alignment' | 'relative' | 'composite'
  rawValue: number | null
  unit: MetricUnit
  normalizedValue: number | null
  normalizedUnit?: string
  /** 値の向きの説明（例: 「左肩が低い」） */
  direction: string
  /** 測定のばらつきの目安（1σ、rawValue と同じ単位） */
  uncertainty: number | null
  status: MetricStatus
  /** 0..1 */
  confidence: number
  qualityNote?: string
  usedLandmarks: number[]
  correctedLandmarks: number[]
  /** 複合指標の内訳 */
  components?: { key: MetricKey; value: number; scale: number }[]
  /**
   * 位置のずれ・高さの差の長さ（体の高さ H に対する比、符号は rawValue と同じ向き）。
   * 身長が分かれば cm の目安に換算して表示する
   */
  offset?: { frac: number; sigma: number | null; label: string }
  /** 複数枚撮りのとき、1 枚ごとの値（評価できなかった枚は null） */
  burstValues?: (number | null)[]
}

// ---------- 姿勢特徴 ----------

export type TraitKey =
  | 'lateral_lean'
  | 'shoulder_asymmetry'
  | 'pelvis_asymmetry'
  | 'head_tilt'
  | 'trunk_shift'
  | 'lower_lean'
  | 'neck_shift'
  | 'leg_alignment'
  | 'load_shift'
  | 'forward_head'
  | 'kyphosis_related'
  | 'rounded_shoulder_related'
  | 'trunk_sagittal'
  | 'swayback_related'
  | 'knee_hyperextension'

export type TraitStatus = 'noticeable' | 'within_noise' | 'unassessable' | 'not_measured'

export interface PostureTrait {
  key: TraitKey
  label: string
  plane: Plane
  status: TraitStatus
  evidenceMetricKeys: MetricKey[]
  summary: string
  caution: string
  /** 0..3（ばらつきの何倍の差か / 2 を上限 3 で切ったもの）。提案の重み付けに使う */
  magnitude: number
  relatedAreas: BodyArea[]
}

export interface Hypothesis {
  id: string
  traitKey: TraitKey
  text: string
  basis: string
}

// ---------- セッション ----------

/** 「意識した姿勢」（自分が良いと思う姿勢）の測定。いつもの姿勢と同じ日に撮って比べる */
export interface ConsciousPose {
  capturedAt: string
  front?: PlaneRecord
  side?: PlaneRecord
  computedMetrics: ComputedMetric[]
  computedMetricsRaw: ComputedMetric[]
  confidenceScores: { overall: number; front?: number; side?: number }
  qualityFlags: QualityFlag[]
}

/** 以前の測定のモード（版 0.6 まで）。simple = 1 枚ずつ、precise = 5 枚の平均。今は使わず、古い記録の表示と比較にだけ使う */
export type CaptureMode = 'simple' | 'precise'

/** 撮り方。placed = スマホを置いてタイマーで撮る、mirror = 鏡の前で自撮り */
export type ShootStyle = 'placed' | 'mirror'

export interface AssessmentSession {
  id: string
  createdAt: string
  note?: string
  front?: PlaneRecord
  side?: PlaneRecord
  computedMetrics: ComputedMetric[]
  computedMetricsRaw: ComputedMetric[]
  postureTraits: PostureTrait[]
  confidenceScores: { overall: number; front?: number; side?: number }
  qualityFlags: QualityFlag[]
  recommendationSnapshot?: { planId: string; routineIds: string[] }
  checkinId?: string
  /** 以前の測定のモード（版 0.6 までの記録だけ） */
  captureMode?: CaptureMode
  /** 撮り方（版 0.7 から。ない記録はスマホを置いて撮ったもの） */
  shootStyle?: ShootStyle
  conscious?: ConsciousPose
  imagesSaved: boolean
  modelVersion: string
  appVersion: string
  algorithmVersion: number
}

// ---------- 運動 ----------

export type RoutineCategory = 'stretch' | 'mobility' | 'light_exercise' | 'posture_tip' | 'breathing'

export type TargetTag = TraitKey | BodyArea | 'general' | 'recovery' | 'activity'

export interface Routine {
  id: string
  name: string
  category: RoutineCategory
  durationMin: number
  difficulty: 1 | 2 | 3
  targetTags: TargetTag[]
  summary: string
  instructions: string[]
  cautions: string[]
  contraindications: string[]
  logFields: ('feeling' | 'discomfort' | 'note')[]
  notes?: string
}

export type Slot =
  | 'today'
  | 'set3'
  | 'set5'
  | 'set10'
  | 'tired'
  | 'minimal'
  | 'priority'
  | 'continue'
  | 'strengthen'
  | 'recovery'

export interface PlannedRoutine {
  routineId: string
  slot: Slot
  score: number
  reasons: string[]
}

export interface HabitSuggestion {
  id: string
  text: string
  reason: string
}

export interface RecommendationPlan {
  id: string
  generatedAt: string
  basedOnAssessmentId?: string
  basedOnComparison?: { a: string; b: string }
  goalTags: GoalTag[]
  routines: PlannedRoutine[]
  habitSuggestions: HabitSuggestion[]
  reviewTiming: { days: number; text: string }
}

export interface RoutineLog {
  id: string
  date: string
  routineId: string
  feeling?: 'easy' | 'ok' | 'hard'
  discomfort?: 'none' | 'slight' | 'yes'
  note?: string
}

export interface CheckIn {
  id: string
  date: string
  sleepRating?: Rating
  fatigueRating?: Rating
  discomfortAreas: BodyArea[]
  note?: string
}

export interface AppSettings {
  saveImages: boolean
  timerSec: 0 | 3 | 5 | 10
  /** 前回選んだ撮り方（次の測定の初期値） */
  shootStyle: ShootStyle
  onboarded: boolean
}
