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

  it('足先が画像の外なら全身欠け', () => {
    const lms = frontPose()
    lms[31] = { ...lms[31], y: 1.02 }
    const flags = assessQuality({ plane: 'front', landmarks: lms, width: W, height: H })
    expect(flags.map((f) => f.key)).toContain('body_cut_off')
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
    expect(detectSideOrientation(sidePose(), W, H)).toEqual({ nearSide: 'right', facing: 'right' })
  })
  it('顔が画像の左を向いている', () => {
    expect(detectSideOrientation(sidePose({ facing: 'left' }), W, H).facing).toBe('left')
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
