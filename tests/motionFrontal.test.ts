import { describe, expect, it } from 'vitest'
import { frontalValues, leftDirOf, viewOf } from '../src/domain/motionFrontal'
import { kindForView } from '../src/domain/motion'
import type { Landmark, Point } from '../src/domain/types'

/** 画面の上の点（ピクセル）。sl = 画面の左側の点、sr = 画面の右側の点 */
function screenPose(o: { hipShiftPx?: number; kneeInLeftScreen?: number; shoulderDropLeftScreen?: number }): Point[] {
  const p: Point[] = Array.from({ length: 33 }, () => ({ x: 200, y: 300 }))
  const put = (l: number, r: number, sl: Point, sr: Point) => {
    p[l] = sl
    p[r] = sr
  }
  // 推定モデルの「左」の番号を、画面の左に置く（後ろから撮ったときの並び）
  put(27, 28, { x: 150, y: 600 }, { x: 250, y: 600 })
  put(29, 30, { x: 150, y: 610 }, { x: 250, y: 610 })
  put(31, 32, { x: 150, y: 615 }, { x: 250, y: 615 })
  put(25, 26, { x: 150 + (o.kneeInLeftScreen ?? 0), y: 480 }, { x: 250, y: 480 })
  const h = o.hipShiftPx ?? 0
  put(23, 24, { x: 170 + h, y: 400 }, { x: 230 + h, y: 400 })
  put(11, 12, { x: 160 + h, y: 200 + (o.shoulderDropLeftScreen ?? 0) }, { x: 240 + h, y: 200 })
  put(7, 8, { x: 190 + h, y: 150 }, { x: 210 + h, y: 150 })
  return p
}

describe('正面・後ろから見た値', () => {
  it('後ろから撮ると、画面の左を体の左として、腰のずれ・膝の開き・肩の傾きを求める', () => {
    const v = frontalValues(screenPose({ hipShiftPx: -10, kneeInLeftScreen: 20, shoulderDropLeftScreen: 8 }), leftDirOf('rear'))!
    expect(v.hipShift).toBeCloseTo(10, 6) // 体の左（画面の左）へ 10 px、足首の間隔 100 px
    expect(v.kneeRatio).toBeCloseTo(0.8, 6)
    expect(v.kneeLOut).toBeCloseTo(-20, 6) // 左の膝が内側へ
    expect(v.kneeROut).toBeCloseTo(0, 6)
    expect(v.shoulderTilt).toBeLessThan(-5) // 体の左の肩が下がる
  })

  it('正面から撮ると、画面の右を体の左とする（同じ体を鏡に映した画面で、同じ値になる）', () => {
    const rear = screenPose({ hipShiftPx: -10, kneeInLeftScreen: 20, shoulderDropLeftScreen: 8 })
    const mirrored = rear.map((q) => ({ x: 400 - q.x, y: q.y }))
    const a = frontalValues(rear, leftDirOf('rear'))!
    const b = frontalValues(mirrored, leftDirOf('front'))!
    for (const k of ['hipShift', 'kneeRatio', 'kneeLOut', 'kneeROut', 'shoulderTilt'] as const) expect(b[k]).toBeCloseTo(a[k], 6)
  })

  it('推定モデルが左右の番号を取り違えても、画面の位置で左右を決める', () => {
    const p = screenPose({ hipShiftPx: -10, kneeInLeftScreen: 20 })
    const swapped = [...p]
    for (const [l, r] of [
      [23, 24],
      [25, 26],
      [27, 28],
      [11, 12],
    ]) {
      swapped[l] = p[r]
      swapped[r] = p[l]
    }
    const a = frontalValues(p, -1)!
    const b = frontalValues(swapped, -1)!
    expect(b.hipShift).toBeCloseTo(a.hipShift, 6)
    expect(b.kneeLOut).toBeCloseTo(a.kneeLOut, 6)
  })
})

describe('撮った向き', () => {
  /** 横向き（股関節の線が奥行きの向き）か、正面・後ろ（画面の横向き）の、1 コマの点 */
  function frame(kind: 'side' | 'front' | 'rear'): { lm: Landmark[]; world: Landmark[] } {
    const W = 400
    const H = 800
    const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
    const world: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }))
    const set = (i: number, px: number, py: number, w: [number, number, number]) => {
      lm[i] = { x: px / W, y: py / H, z: 0, visibility: 1 }
      world[i] = { x: w[0], y: w[1], z: w[2], visibility: 1 }
    }
    const wide = kind === 'side' ? 4 : 50
    set(11, 200 - wide, 200, kind === 'side' ? [0, -0.5, -0.15] : [0.18, -0.5, 0])
    set(12, 200 + wide, 200, kind === 'side' ? [0, -0.5, 0.15] : [-0.18, -0.5, 0])
    set(23, 200 - wide, 400, kind === 'side' ? [0, 0, -0.1] : [0.1, 0, 0])
    set(24, 200 + wide, 400, kind === 'side' ? [0, 0, 0.1] : [-0.1, 0, 0])
    // 鼻: 正面は耳より手前（z が小さい）、後ろは奥
    const nz = kind === 'front' ? -0.1 : kind === 'rear' ? 0.1 : 0
    set(0, 200, 140, [0, -0.7, nz])
    set(7, 190, 145, [0.07, -0.68, 0])
    set(8, 210, 145, [-0.07, -0.68, 0])
    return { lm, world }
  }
  const frames = (k: 'side' | 'front' | 'rear') => Array.from({ length: 10 }, () => frame(k))

  it('横・正面・後ろを見分ける', () => {
    expect(viewOf(frames('side'), 400, 800).view).toBe('side')
    expect(viewOf(frames('front'), 400, 800).view).toBe('front')
    expect(viewOf(frames('rear'), 400, 800).view).toBe('rear')
  })

  it('スクワットは、正面・後ろから撮ると左右の差の計算に切り替える（ほかの種目はそのまま）', () => {
    const input = (k: 'side' | 'front' | 'rear') => ({ frames: frames(k).map((f, i) => ({ t: i * 33, lm: f.lm, world: f.world })), width: 400, height: 800 })
    expect(kindForView(input('rear'), 'squat')).toBe('squat_front')
    expect(kindForView(input('side'), 'squat_front')).toBe('squat')
    expect(kindForView(input('rear'), 'erg')).toBe('erg')
  })
})
