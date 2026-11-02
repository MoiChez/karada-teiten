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
}

export interface CorrectionEntry {
  index: number
  from: Point
  to: Point
  at: string
}

export interface PlaneRecord {
  plane: Plane
  imageMetadata: ImageMetadata
  landmarksRaw: Landmark[]
  worldLandmarksRaw: Landmark[]
  landmarksCorrected: Landmark[]
  correctionLog: CorrectionEntry[]
  qualityFlags: QualityFlag[]
}

// ---------- 指標 ----------

export type MetricKey =
  | 'front_body_lean'
  | 'front_shoulder_tilt'
  | 'front_pelvis_tilt'
  | 'front_head_tilt'
  | 'front_trunk_shift'
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
  | 'side_pelvis_tilt'
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
}

// ---------- 姿勢特徴 ----------

export type TraitKey =
  | 'lateral_lean'
  | 'shoulder_asymmetry'
  | 'pelvis_asymmetry'
  | 'head_tilt'
  | 'trunk_shift'
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
  model: 'full' | 'heavy'
  timerSec: 0 | 3 | 5 | 10
  onboarded: boolean
}
