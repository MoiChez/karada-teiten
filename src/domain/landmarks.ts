// MediaPipe Pose の 33 点の定義と、このアプリで使う点の情報

export const LM = {
  nose: 0,
  leftEyeInner: 1,
  leftEye: 2,
  leftEyeOuter: 3,
  rightEyeInner: 4,
  rightEye: 5,
  rightEyeOuter: 6,
  leftEar: 7,
  rightEar: 8,
  mouthLeft: 9,
  mouthRight: 10,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftThumb: 21,
  rightThumb: 22,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
} as const

export const LANDMARK_COUNT = 33

export const LANDMARK_NAMES_JA: Record<number, string> = {
  0: '鼻',
  2: '左目',
  3: '左目尻',
  5: '右目',
  6: '右目尻',
  7: '左耳',
  8: '右耳',
  11: '左肩',
  12: '右肩',
  13: '左ひじ',
  14: '右ひじ',
  15: '左手首',
  16: '右手首',
  23: '左股関節',
  24: '右股関節',
  25: '左膝',
  26: '右膝',
  27: '左足首',
  28: '右足首',
  29: '左かかと',
  30: '右かかと',
  31: '左足先',
  32: '右足先',
}

/** 手動補正の対象（14 点） */
export const CORRECTABLE: number[] = [7, 8, 11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]

export const LEFT_SIDE_CORRECTABLE = [7, 11, 23, 25, 27, 29, 31]
export const RIGHT_SIDE_CORRECTABLE = [8, 12, 24, 26, 28, 30, 32]

/** 骨格線（表示用）。顔の細かい点は省き、耳と鼻で頭を表す */
export const SKELETON_EDGES: [number, number][] = [
  [7, 0],
  [0, 8],
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [27, 29],
  [29, 31],
  [27, 31],
  [24, 26],
  [26, 28],
  [28, 30],
  [30, 32],
  [28, 32],
]

/** 表示する点（顔の細かい点は除く） */
export const DISPLAY_POINTS: number[] = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]

/** 側面のカメラ側の半身の点 */
export function sidePoints(side: 'left' | 'right') {
  const L = side === 'left'
  return {
    ear: L ? LM.leftEar : LM.rightEar,
    shoulder: L ? LM.leftShoulder : LM.rightShoulder,
    wrist: L ? LM.leftWrist : LM.rightWrist,
    hip: L ? LM.leftHip : LM.rightHip,
    knee: L ? LM.leftKnee : LM.rightKnee,
    ankle: L ? LM.leftAnkle : LM.rightAnkle,
    heel: L ? LM.leftHeel : LM.rightHeel,
    foot: L ? LM.leftFootIndex : LM.rightFootIndex,
  }
}

export function landmarkName(index: number): string {
  return LANDMARK_NAMES_JA[index] ?? `点 ${index}`
}
