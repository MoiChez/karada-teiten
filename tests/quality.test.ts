import { describe, expect, it } from 'vitest'
import { assessQuality, detectSideOrientation, hasBlocking } from '../src/domain/quality'
import { buildSession } from '../src/domain/session'
import { H, W, frontPose, record, sidePose } from './helpers'

describe('品質チェック', () => {
  it('人物がいなければ分析不可', () => {
    const flags = assessQuality({ plane: 'front', landmarks: null, width: W, height: H })
    expect(hasBlocking(flags)).toBe(true)
    expect(flags[0].key).toBe('no_pose')
  })

  it('よい写真では重大なフラグが出ない', () => {
    const flags = assessQuality({ plane: 'front', landmarks: frontPose(), width: W, height: H })
    expect(flags.filter((f) => f.severity !== 'minor')).toEqual([])
  })

  it('足先が少し画像の外なら、推測した位置で計算したと軽く知らせる', () => {
    const lms = frontPose()
    lms[31] = { ...lms[31], y: 1.02 }
    const flags = assessQuality({ plane: 'front', landmarks: lms, width: W, height: H })
    const f = flags.find((x) => x.key === 'body_cut_off')!
    expect(f.severity).toBe('minor')
    expect(f.message).toContain('足先が写真の外に出ているため、位置を推測して計算しました')
  })

  it('かかとが隠れているときは「かかと」と伝え、推測した位置で計算する', () => {
    const flags = assessQuality({ plane: 'front', landmarks: frontPose({ vis: { 29: 0.3, 30: 0.3 } }), width: W, height: H })
    const f = flags.find((x) => x.key === 'body_cut_off')!
    expect(f.severity).toBe('minor')
    expect(f.message).toContain('かかとがはっきり写っていないため、位置を推測して計算しました')
    expect(f.message).toContain('ズボンの裾')
    expect(f.message).not.toContain('足先')
    expect(hasBlocking(flags)).toBe(false)
  })

  it('足元が写真の少し外なら、推測した位置で値を出す（撮り直しは求めない）', () => {
    const lms = frontPose({ leftShoulderDrop: 30 })
    for (const i of [27, 28, 29, 30, 31, 32]) lms[i] = { ...lms[i], y: lms[i].y + 0.12 }
    const flags = assessQuality({ plane: 'front', landmarks: lms, width: W, height: H })
    const f = flags.find((x) => x.key === 'body_cut_off')!
    expect(f.severity).toBe('minor')
    expect(f.message).toContain('かかと・足先が写真の外に出ているため')
    expect(flags.filter((x) => x.severity !== 'minor')).toEqual([])
    const s = buildSession({ front: record('front', lms), imagesSaved: false, modelVersion: 'test' })
    const tilt = s.computedMetrics.find((m) => m.key === 'front_shoulder_tilt')!
    expect(tilt.rawValue).not.toBeNull()
    expect(s.computedMetrics.find((m) => m.key === 'front_body_lean')!.qualityNote).toContain('推測')
  })

  it('足元が写真の外に大きく出て推測もできないときは、分析できないと先に伝える', () => {
    const lms = frontPose()
    for (const i of [25, 26, 27, 28, 29, 30, 31, 32]) lms[i] = { ...lms[i], y: 1.4 }
    const flags = assessQuality({ plane: 'front', landmarks: lms, width: W, height: H })
    const f = flags.find((x) => x.key === 'body_cut_off')!
    expect(f.severity).toBe('blocking')
    expect(f.message).toContain('写真に入っていないため、分析できません')
    expect(f.message).not.toContain('ドラッグ')
    // そのまま進めても、どの値も出ない
    const s = buildSession({ front: record('front', lms), imagesSaved: false, modelVersion: 'test' })
    expect(s.computedMetrics.filter((m) => m.plane === 'front' && m.rawValue !== null)).toEqual([])
  })

  it('頭が写真の中にあっても、はっきり写っていなければ、隠れや暗さを確かめるよう伝える', () => {
    const flags = assessQuality({ plane: 'front', landmarks: frontPose({ vis: { 7: 0.2 } }), width: W, height: H })
    const f = flags.find((x) => x.key === 'body_cut_off')!
    expect(f.message).toContain('頭がはっきり写っていないため')
    expect(f.message).not.toContain('足先')
  })

  it('肩幅が見えていても、奥行きから体が斜めなら向きの注意', () => {
    const turned = frontPose().map((l, i) => ({ ...l, z: [11, 23].includes(i) ? -0.2 : [12, 24].includes(i) ? 0.2 : 0 }))
    const slight = frontPose().map((l, i) => ({ ...l, z: [11, 23].includes(i) ? -0.05 : [12, 24].includes(i) ? 0.05 : 0 }))
    const keys = (lms: typeof turned) => assessQuality({ plane: 'front', landmarks: lms, width: W, height: H }).map((f) => f.key)
    expect(keys(turned)).toContain('orientation_front')
    expect(keys(slight)).not.toContain('orientation_front')
  })

  it('体の向きが合っていない写真では、値を出さず「評価できない」にする', () => {
    const turned = frontPose({ leftShoulderDrop: 30 }).map((l, i) => ({ ...l, z: [11, 23].includes(i) ? -0.2 : [12, 24].includes(i) ? 0.2 : 0 }))
    const s = buildSession({ front: record('front', turned), side: record('side', frontPose()), imagesSaved: false, modelVersion: 'test' })
    const assessed = s.computedMetrics.filter((m) => m.status !== 'unsupported' && m.status !== 'unassessable')
    expect(assessed).toEqual([])
    expect(s.computedMetrics.find((m) => m.key === 'front_shoulder_tilt')!.qualityNote).toContain('斜め')
    expect(s.computedMetrics.find((m) => m.key === 'side_head_forward')!.qualityNote).toContain('真横')
    expect(s.postureTraits.filter((t) => t.status === 'noticeable' || t.status === 'recorded')).toEqual([])
    // 向きが合っていれば、同じ肩の差は判定される
    const ok = buildSession({ front: record('front', frontPose({ leftShoulderDrop: 30 })), imagesSaved: false, modelVersion: 'test' })
    expect(ok.computedMetrics.find((m) => m.key === 'front_shoulder_tilt')!.status).toBe('noticeable')
  })

  it('傾きセンサーの値がなければ、軽い注意として知らせる（信頼度は下げない）', () => {
    const without = assessQuality({ plane: 'front', landmarks: frontPose(), width: W, height: H })
    const withTilt = assessQuality({ plane: 'front', landmarks: frontPose(), width: W, height: H, deviceTilt: { rollDeg: 0.5, pitchDeg: 89 } })
    expect(without.find((f) => f.key === 'tilt_unknown')!.severity).toBe('minor')
    expect(withTilt.map((f) => f.key)).not.toContain('tilt_unknown')
  })

  it('正面なのに肩幅が狭い → 向きの注意', () => {
    const flags = assessQuality({ plane: 'front', landmarks: frontPose({ shoulderHalfWidth: 60 }), width: W, height: H })
    expect(flags.map((f) => f.key)).toContain('orientation_front')
  })

  it('側面として正面の写真を使うと向きの注意', () => {
    const flags = assessQuality({ plane: 'side', landmarks: frontPose(), width: W, height: H, nearSide: 'left' })
    expect(flags.map((f) => f.key)).toContain('orientation_side')
  })

  it('暗い・ぶれ・端末の傾き・解像度', () => {
    const flags = assessQuality({
      plane: 'front',
      landmarks: frontPose(),
      width: 400,
      height: 800,
      imageStats: { meanLuma: 40, stdLuma: 50, laplacianVar: 5 },
      deviceTilt: { rollDeg: 6, pitchDeg: 88 },
    })
    const keys = flags.map((f) => f.key)
    expect(keys).toEqual(expect.arrayContaining(['too_dark', 'blurry', 'device_tilt', 'low_resolution']))
  })

  it('品質の注意は信頼度を下げる', () => {
    const good = buildSession({ front: record('front', frontPose()), imagesSaved: false, modelVersion: 't' })
    const tilted = buildSession({
      front: record('front', frontPose(), { deviceTilt: { rollDeg: 8, pitchDeg: 90 } }),
      imagesSaved: false,
      modelVersion: 't',
    })
    expect(tilted.confidenceScores.overall).toBeLessThan(good.confidenceScores.overall)
  })
})

describe('側面の向きの推定', () => {
  it('顔が画像の右を向き、右半身がカメラ側', () => {
    expect(detectSideOrientation(sidePose())).toEqual({ nearSide: 'right', facing: 'right' })
  })
  it('顔が画像の左を向いている', () => {
    expect(detectSideOrientation(sidePose({ facing: 'left' })).facing).toBe('left')
  })
})

describe('位置が不確かな点', () => {
  it('信頼度の低い補正対象の点を名前つきで知らせる', () => {
    const flags = assessQuality({ plane: 'front', landmarks: frontPose({ vis: { 25: 0.3 } }), width: W, height: H })
    const f = flags.find((x) => x.key === 'uncertain_points')
    expect(f?.severity).toBe('minor')
    expect(f?.message).toContain('左膝')
  })
  it('補正した点は知らせない', () => {
    const flags = assessQuality({ plane: 'front', landmarks: frontPose({ vis: { 25: 0.3 } }), width: W, height: H, correctedIdx: new Set([25]) })
    expect(flags.some((x) => x.key === 'uncertain_points')).toBe(false)
  })
})
