// 撮影品質の判定と、側面の向きの推定
import type { DeviceTilt, ImageStats, Landmark, Plane, QualityFlag } from './types'
import { MIN_VISIBILITY, QUALITY } from './constants'
import { angleFromVerticalDeg, dist, mid, RAD2DEG } from './geometry'
import { CORRECTABLE, LEFT_SIDE_CORRECTABLE, LM, RIGHT_SIDE_CORRECTABLE, landmarkName, sidePoints } from './landmarks'
import { bodyHeightPx, visibilityOf } from './metrics'

export interface QualityInput {
  plane: Plane
  landmarks: Landmark[] | null
  worldLandmarks?: Landmark[] | null
  width: number
  height: number
  imageStats?: ImageStats
  deviceTilt?: DeviceTilt
  secondPersonScale?: number
  nearSide?: 'left' | 'right'
  /** 手動補正した点（visibility を 1 とみなす） */
  correctedIdx?: Set<number>
}

const flag = (
  plane: Plane,
  key: QualityFlag['key'],
  severity: QualityFlag['severity'],
  message: string,
  value?: number,
): QualityFlag => ({ key, plane, severity, message, value })

export function assessQuality(input: QualityInput): QualityFlag[] {
  const { plane, landmarks, width, height } = input
  const flags: QualityFlag[] = []

  // 画像そのものの品質（ランドマークがなくても判定できる）
  if (Math.min(width, height) < QUALITY.minShortSidePx) {
    flags.push(flag(plane, 'low_resolution', 'minor', '画像の解像度が低いため、点の位置が粗くなります', Math.min(width, height)))
  }
  const st = input.imageStats
  if (st) {
    if (st.meanLuma < QUALITY.darkLuma) flags.push(flag(plane, 'too_dark', 'minor', '写真が暗めです。明るい場所で撮ると精度が上がります', st.meanLuma))
    if (st.meanLuma > QUALITY.brightLuma) flags.push(flag(plane, 'too_bright', 'minor', '写真が明るすぎます。逆光や強い照明を避けてください', st.meanLuma))
    if (st.stdLuma < QUALITY.lowContrastStd) flags.push(flag(plane, 'low_contrast', 'minor', '体と背景の明暗差が小さいようです。背景と違う色の服がおすすめです', st.stdLuma))
    if (st.laplacianVar < QUALITY.blurLaplacianVar) flags.push(flag(plane, 'blurry', 'minor', 'ぶれ・ピンぼけの可能性があります（目安）', st.laplacianVar))
  }
  const tilt = input.deviceTilt
  if (tilt) {
    const pitchOff = Math.abs(90 - Math.abs(tilt.pitchDeg))
    if (Math.abs(tilt.rollDeg) > QUALITY.deviceRollDeg || pitchOff > QUALITY.devicePitchFromVerticalDeg) {
      flags.push(
        flag(plane, 'device_tilt', 'minor', `撮影時に端末が傾いていました（左右 ${tilt.rollDeg.toFixed(1)}°）。角度の値に影響します`, tilt.rollDeg),
      )
    }
  }

  if (!landmarks || landmarks.length < 33) {
    flags.push(flag(plane, 'no_pose', 'blocking', '人物を検出できませんでした。全身が写った写真で撮り直してください'))
    return flags
  }

  const corrected = input.correctedIdx ?? new Set<number>()
  const vis = (i: number) => (corrected.has(i) ? 1 : visibilityOf(landmarks[i]))
  const inFrame = (i: number) => {
    const l = landmarks[i]
    return l.x >= 0 && l.x <= 1 && l.y >= 0 && l.y <= 1
  }
  const ok = (i: number) => inFrame(i) && vis(i) >= MIN_VISIBILITY
  const px = (i: number) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height })

  if (input.secondPersonScale !== undefined && input.secondPersonScale >= QUALITY.secondPersonScale) {
    flags.push(flag(plane, 'multiple_people', 'minor', '複数の人が写っています。分析は一番大きく写った人で行います', input.secondPersonScale))
  }

  const near = sidePoints(input.nearSide ?? 'left')
  const extremities =
    plane === 'front'
      ? [LM.leftEar, LM.rightEar, LM.leftHeel, LM.rightHeel, LM.leftFootIndex, LM.rightFootIndex]
      : [near.ear, near.heel, near.foot]
  const cut = extremities.filter((i) => !ok(i))
  if (cut.length > 0) {
    const isHead = (i: number) => i === LM.leftEar || i === LM.rightEar
    const isHeel = (i: number) => i === LM.leftHeel || i === LM.rightHeel
    const part = [cut.some(isHead) && '頭', cut.some(isHeel) && 'かかと', cut.some((i) => !isHead(i) && !isHeel(i)) && '足先']
      .filter(Boolean)
      .join('・')
    const hiders = cut.every(isHead) ? '髪や物' : cut.some(isHead) ? '髪・ズボンの裾・物' : 'ズボンの裾や物'
    // 頭（耳か鼻）と足元（かかとか足首）の両方がないと体の高さ H が決まらず、どの値も計算できない。
    // そのまま進めると全項目が「評価できません」の記録になるため、先に分析できないと伝える
    const noScale = bodyHeightPx(plane, px, ok, input.nearSide) === null
    const message = cut.some((i) => !inFrame(i))
      ? noScale
        ? `${part}が写真の外に出ていて、頭から足元までの長さを測れないため、数値を出せません。頭からつま先まで入るように撮り直してください`
        : `${part}が写真の外に出ています。頭からつま先まで入るように撮ってください`
      : noScale
        ? `${part}がはっきり写っていないため、頭から足元までの長さを測れず、数値を出せません。${hiders}で隠れていないか、暗すぎないかを確かめてください。写っている場合は、点をドラッグして位置を合わせると計算できます`
        : `${part}がはっきり写っていません。${hiders}で隠れていないか、暗すぎないかを確かめてください`
    flags.push(flag(plane, 'body_cut_off', noScale ? 'blocking' : 'major', message, cut.length))
  }

  const core =
    plane === 'front' ? [LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip] : [near.shoulder, near.hip]
  const hidden = core.filter((i) => !ok(i))
  if (hidden.length > 0) {
    flags.push(flag(plane, 'occluded', 'major', '肩か股関節の位置が確認できません。腕や物で体が隠れていないか確認してください', hidden.length))
  }

  // 位置が不確かな点（補正の候補）。全身欠け・遮蔽で既に知らせた点は除く
  const editable = plane === 'front' ? CORRECTABLE : input.nearSide === 'right' ? RIGHT_SIDE_CORRECTABLE : LEFT_SIDE_CORRECTABLE
  const reported = new Set<number>([...cut, ...hidden])
  const uncertain = editable.filter((i) => !ok(i) && !reported.has(i))
  if (uncertain.length > 0) {
    flags.push(
      flag(plane, 'uncertain_points', 'minor', `${uncertain.map(landmarkName).join('・')}の位置が不確かです。写真と見比べて、ずれていれば直してください`, uncertain.length),
    )
  }

  // 向きの確認（肩幅 / 胴の長さ）
  if (ok(LM.leftShoulder) && ok(LM.rightShoulder) && ok(LM.leftHip) && ok(LM.rightHip)) {
    const shoulderW = dist(px(LM.leftShoulder), px(LM.rightShoulder))
    const torso = dist(mid(px(LM.leftShoulder), px(LM.rightShoulder)), mid(px(LM.leftHip), px(LM.rightHip)))
    const ratio = torso > 0 ? shoulderW / torso : 0
    // 奥行き（z）から見た肩・骨盤の線の向き。肩幅が十分に見えていても、体が斜めなら左右の高さの差に奥行きが混ざる
    const yawOf = (l: number, r: number) =>
      Math.atan2((landmarks[l].z ?? 0) - (landmarks[r].z ?? 0), Math.abs(landmarks[l].x - landmarks[r].x)) * RAD2DEG
    const yaw = Math.abs((yawOf(LM.leftShoulder, LM.rightShoulder) + yawOf(LM.leftHip, LM.rightHip)) / 2)
    if (plane === 'front' && (ratio < QUALITY.frontShoulderRatioMin || yaw > QUALITY.frontYawMaxDeg)) {
      flags.push(flag(plane, 'orientation_front', 'major', '体が斜めを向いているようです。この写真では左右の差を評価しません。カメラに対して正面を向いて撮り直してください', ratio))
    }
    if (plane === 'side' && ratio > QUALITY.sideShoulderRatioMax) {
      flags.push(flag(plane, 'orientation_side', 'major', '体が真横を向いていないようです。この写真では前後の位置を記録しません。カメラに対して真横を向いて撮り直してください', ratio))
    }
  }

  // 体全体の傾き（足首の中点 → 耳の中点）
  const earA = plane === 'front' ? [LM.leftEar, LM.rightEar] : [near.ear]
  const ankA = plane === 'front' ? [LM.leftAnkle, LM.rightAnkle] : [near.ankle]
  if ([...earA, ...ankA].every(ok)) {
    const top = earA.length === 2 ? mid(px(earA[0]), px(earA[1])) : px(earA[0])
    const bottom = ankA.length === 2 ? mid(px(ankA[0]), px(ankA[1])) : px(ankA[0])
    const lean = Math.abs(angleFromVerticalDeg(bottom, top, 1))
    if (lean > QUALITY.extremeTiltDeg) {
      flags.push(flag(plane, 'extreme_tilt', 'major', `体全体かカメラが大きく傾いています（約 ${lean.toFixed(0)}°）`, lean))
    }
  }

  // 写っている大きさ
  const H = bodyHeightPx(plane, px, ok, input.nearSide)
  if (H !== null && H / height < QUALITY.tooSmallRatio) {
    flags.push(flag(plane, 'too_small', 'minor', '体が小さく写っています。もう少し近づくと精度が上がります', H / height))
  }

  // 傾きセンサーの値がない写真（選んだ写真、センサーを使えない端末）は、スマホの傾きを差し引けない
  if (!tilt) {
    flags.push(flag(plane, 'tilt_unknown', 'minor', '撮影時のスマホの傾きを確認できませんでした。スマホが傾いていた場合、その分が角度の値に含まれます'))
  }

  return flags
}

export function hasBlocking(flags: QualityFlag[]): boolean {
  return flags.some((f) => f.severity === 'blocking')
}

export function hasMajor(flags: QualityFlag[]): boolean {
  return flags.some((f) => f.severity === 'major' || f.severity === 'blocking')
}

/**
 * 側面の向き: カメラ側の半身（visibility が高い方）と、顔が画像の左右どちらを向いているか
 */
export function detectSideOrientation(landmarks: Landmark[]): { nearSide: 'left' | 'right'; facing: 'left' | 'right' } {
  const leftSet = [7, 11, 23, 25, 27, 29, 31]
  const rightSet = [8, 12, 24, 26, 28, 30, 32]
  const avgVis = (set: number[]) => set.reduce((s, i) => s + visibilityOf(landmarks[i]), 0) / set.length
  const avgZ = (set: number[]) => set.reduce((s, i) => s + (landmarks[i]?.z ?? 0), 0) / set.length
  const vl = avgVis(leftSet)
  const vr = avgVis(rightSet)
  let nearSide: 'left' | 'right'
  if (Math.abs(vl - vr) > 0.05) nearSide = vl > vr ? 'left' : 'right'
  else nearSide = avgZ(leftSet) <= avgZ(rightSet) ? 'left' : 'right'

  const s = sidePoints(nearSide)
  const x = (i: number) => landmarks[i]?.x ?? 0
  const cue = x(LM.nose) - x(s.ear) + (x(s.foot) - x(s.heel))
  return { nearSide, facing: cue >= 0 ? 'right' : 'left' }
}
