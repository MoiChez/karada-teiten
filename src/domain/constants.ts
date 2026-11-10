// 判定に使う数値をここにまとめる。どれも医学的な基準ではなく、
// 測定の品質や「ばらつきを超える差か」を判断するための工学的な目安（docs/05-analysis-logic.md）

/** 計算ロジックの版。変えたら保存済みセッションは読み込み時に再計算される */
export const ALGORITHM_VERSION = 6

/** ランドマーク位置の想定誤差（体の高さ H に対する割合、1σ） */
export const LANDMARK_SIGMA_FRACTION = 0.005

/**
 * 推測した点（隠れている・写真の外に少し出ている点。MediaPipe が推測した位置をそのまま使う）の想定誤差（H 比、1 方向の 1σ）。
 * 全身が写った写真 20 枚の足元を切り落として測り直すと、推測した膝・足首・かかと・足先は、切る前の位置から
 * H の約 4%（足首の高さで切ったとき）〜 6%（すねの中ほどで切ったとき）ずれた（距離の二乗平均）。1 方向あたりに直して 0.04 とした
 */
export const GUESSED_SIGMA_FRACTION = 0.04

/** 写真の外に出た点を推測として使う範囲（画像の幅・高さに対する比）。これより外の点は使わない */
export const GUESS_FRAME_MARGIN = 0.25

/** 推測した点を使う指標の信頼度の計算で、その点の visibility の代わりに使う上限 */
export const GUESSED_POINT_CONFIDENCE = 0.4

/**
 * 背中の輪郭（人の領域の端）の位置の想定誤差（体の高さ H に対する割合、1σ）。
 * 体の高さが 1,000〜1,500 画素の写真で 3〜5 画素にあたる工学的な目安。真横から撮れている実在の人の写真 4 枚を
 * 左右反転して測り直したときの値の違いが、この目安から求めたばらつきの 0.5 倍（背中上部）〜1.1 倍（腰のくぼみ）に
 * なる大きさにした（以前の 0.002 では腰のくぼみが 1.7 倍あり、小さすぎた）。
 * 服・髪・立ち方の違いによる外形の変化は含まない
 */
export const BACK_EDGE_SIGMA_FRACTION = 0.003

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

/** この visibility 以上で写真の中にある点を「写っている点」とする。未満の点は推測した点として扱う */
export const MIN_VISIBILITY = 0.5

export const QUALITY = {
  frontShoulderRatioMin: 0.45,
  /** 正面: 肩と骨盤の線の奥行きの傾き（度）がこれを超えたら、体が斜めを向いているとみなす。実在の人の写真では、正面は約 31° 以下、斜めは約 52° 以上だった */
  frontYawMaxDeg: 40,
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
  side_back_upper: 0.6,
  side_back_lower: 0.5,
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
  deviceTiltDiffDeg: 5,
  confidenceDiff: 0.2,
} as const

/** 補正: 元の位置に吸着する距離（画像の短辺に対する割合） */
export const SNAP_FRACTION = 0.012

/** 撮影位置を前回に合わせるときの目安（大きさの比と位置のずれ。体の高さに対する割合）。測定値の判定には使わない */
export const FRAMING_TOLERANCE = 0.05

/** 以前の高精度モード（版 0.6 まで）で続けて撮った枚数。古い記録との比較の説明に使う */
export const PRECISE_SHOTS = 5
