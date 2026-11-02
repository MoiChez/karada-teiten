// 判定に使う数値をここにまとめる。どれも医学的な基準ではなく、
// 測定の品質や「ばらつきを超える差か」を判断するための工学的な目安（docs/05-analysis-logic.md）

/** 計算ロジックの版。変えたら保存済みセッションは読み込み時に再計算される */
export const ALGORITHM_VERSION = 2

/** ランドマーク位置の想定誤差（体の高さ H に対する割合、1σ） */
export const LANDMARK_SIGMA_FRACTION = 0.005

/** 不確かさを求める乱数摂動の回数 */
export const PERTURBATION_SAMPLES = 150

/**
 * 体の高さ H（耳〜かかとの点の縦の距離）が身長の何割にあたるか。cm の目安の換算に使う。
 * 身体寸法比の文献値（目の高さ ≈ 身長の 93.6%、Drillis & Contini）から、耳はそれより少し下、
 * かかとの点は床より少し上として概算した値。数 % の誤差を含む
 */
export const H_TO_STATURE = 0.91

/** 「差が見られる」とみなす倍率（|値| > K × σ） */
export const NOTICEABLE_K = 2

/** この visibility 未満の点は使わない */
export const MIN_VISIBILITY = 0.5

export const QUALITY = {
  frontShoulderRatioMin: 0.45,
  sideShoulderRatioMax: 0.35,
  extremeTiltDeg: 10,
  tooSmallRatio: 0.45,
  minShortSidePx: 480,
  darkLuma: 60,
  brightLuma: 215,
  lowContrastStd: 25,
  blurLaplacianVar: 25,
  deviceRollDeg: 3,
  devicePitchFromVerticalDeg: 10,
  secondPersonScale: 0.5,
} as const

/** 品質フラグごとの信頼度係数 */
export const QUALITY_CONFIDENCE_FACTOR: Partial<Record<string, number>> = {
  orientation_front: 0.6,
  orientation_side: 0.6,
  device_tilt: 0.8,
  blurry: 0.8,
  too_dark: 0.85,
  too_bright: 0.85,
  low_contrast: 0.9,
  too_small: 0.85,
  multiple_people: 0.9,
  extreme_tilt: 0.7,
}

/** 指標ごとの信頼度の上限（推定の性質上、高くなりえないもの） */
export const CONFIDENCE_CAP: Partial<Record<string, number>> = {
  front_pelvis_tilt: 0.7,
  front_knee_left: 0.7,
  front_knee_right: 0.7,
  front_load_shift: 0.6,
  side_arm_forward: 0.5,
  side_hip_forward: 0.7,
  side_knee_extension: 0.7,
  composite_kyphosis: 0.7,
  composite_swayback: 0.6,
}

/** 複合指標の表示用スケール（単位をそろえるための値。基準値ではない） */
export const COMPOSITE_SCALE = {
  kyphosis: { headForwardDeg: 10, trunkLeanDeg: 5, armForwardPct: 20 },
  swayback: { hipForwardPct: 3, kneeExtensionDeg: 5, trunkBackDeg: 5 },
} as const

/** 比較で撮影条件の違いを注意する閾値 */
export const COMPARE_WARN = {
  yawDiffDeg: 5,
  deviceTiltDiffDeg: 5,
  confidenceDiff: 0.2,
} as const

/** 補正: 元の位置に吸着する距離（画像の短辺に対する割合） */
export const SNAP_FRACTION = 0.012
