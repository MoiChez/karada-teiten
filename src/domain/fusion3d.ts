// 正面と側面の 2D ランドマークから、簡易的な 3D 座標を作る（docs/07 の 3 章）
// 単位は「体の高さ（耳〜かかと）に対する比率」。X: 被写体の左が +、Y: 上が +、Z: 前が +
import type { Landmark, PlaneRecord } from './types'
import { LM } from './landmarks'
import { pointState } from './metrics'
import { correctedSet } from './session'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Pose3D {
  points: (Vec3 | null)[]
  depthSource: 'side_photo' | 'model_estimate'
  /** 本人の骨の長さ（体の高さを 1 として。動きの記録から 1 つに決めた値）。あれば 3D の手足と胴をこの長さにする */
  bones?: BoneLengths
  /**
   * 胴の向きに使う、胴の上の端の位置（両肩の中点の代わり）。肩の点が肩甲骨と一緒に背中側へずれたと見て、
   * 寄せ直したもの。ないときは両肩の中点を使う
   */
  trunkTop?: Vec3
}

export interface BoneLengths {
  upperArm: number
  foreArm: number
  thigh: number
  shank: number
  /** 股関節の中点〜両肩の関節の中点（耳の点と股関節の点から見積もる。推定の肩の点は肩先で、関節より高いため） */
  trunk?: number
}

/** 左右で対になる点（側面ではカメラ側の値を両側に使う） */
const PAIR: Record<number, [number, number]> = {
  7: [7, 8], 8: [7, 8],
  11: [11, 12], 12: [11, 12],
  13: [13, 14], 14: [13, 14],
  15: [15, 16], 16: [15, 16],
  23: [23, 24], 24: [23, 24],
  25: [25, 26], 26: [25, 26],
  27: [27, 28], 28: [27, 28],
  29: [29, 30], 30: [29, 30],
  31: [31, 32], 32: [31, 32],
}

const USED = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]

function validFn(rec: PlaneRecord, lms: Landmark[]) {
  const corrected = correctedSet(rec)
  return (i: number) => {
    const l = lms[i]
    return pointState(l, corrected.has(i)) !== 'none'
  }
}

export function fuse3D(front: PlaneRecord | undefined, side: PlaneRecord | undefined, useCorrected = true): Pose3D | null {
  if (!front || front.landmarksRaw.length < 33) return null
  const fl = useCorrected ? front.landmarksCorrected : front.landmarksRaw
  const fw = front.imageMetadata.width
  const fh = front.imageMetadata.height
  const fOk = validFn(front, fl)
  const fpx = (i: number) => ({ x: fl[i].x * fw, y: fl[i].y * fh })
  if (![LM.leftAnkle, LM.rightAnkle, LM.leftShoulder, LM.rightShoulder].every(fOk)) return null

  const ankleMid = { x: (fpx(27).x + fpx(28).x) / 2, y: (fpx(27).y + fpx(28).y) / 2 }
  const topY = fOk(7) && fOk(8) ? (fpx(7).y + fpx(8).y) / 2 : fpx(0).y
  const bottomY = fOk(29) && fOk(30) ? (fpx(29).y + fpx(30).y) / 2 : ankleMid.y
  const Hf = bottomY - topY
  if (Hf <= 0) return null
  const sLat = fpx(11).x - fpx(12).x + (fpx(23).x - fpx(24).x) >= 0 ? 1 : -1

  // 奥行き Z
  let zOf: (i: number) => number | null
  let depthSource: Pose3D['depthSource']
  const sl = side ? (useCorrected ? side.landmarksCorrected : side.landmarksRaw) : null
  if (side && sl && sl.length >= 33) {
    const sw = side.imageMetadata.width
    const sh = side.imageMetadata.height
    const sOk = validFn(side, sl)
    const near = side.imageMetadata.nearSide ?? 'left'
    const f = side.imageMetadata.facing === 'left' ? -1 : 1
    const nearIdx = (i: number) => {
      const pair = PAIR[i]
      if (!pair) return i
      return near === 'left' ? pair[0] : pair[1]
    }
    const ankle = near === 'left' ? 27 : 28
    const ear = near === 'left' ? 7 : 8
    const heel = near === 'left' ? 29 : 30
    const Hs = ((sOk(heel) ? sl[heel].y : sl[ankle].y) - sl[ear].y) * sh
    if (sOk(ankle) && sOk(ear) && Hs > 0) {
      depthSource = 'side_photo'
      zOf = (i) => {
        const j = nearIdx(i)
        if (!sOk(j)) return null
        return ((sl[j].x - sl[ankle].x) * sw * f) / Hs
      }
    } else {
      depthSource = 'model_estimate'
      zOf = worldDepth(front)
    }
  } else {
    depthSource = 'model_estimate'
    zOf = worldDepth(front)
  }

  const points: (Vec3 | null)[] = Array.from({ length: 33 }, () => null)
  for (const i of USED) {
    if (!fOk(i)) continue
    const p = fpx(i)
    const z = zOf(i)
    points[i] = {
      x: ((p.x - ankleMid.x) * sLat) / Hf,
      y: (ankleMid.y - p.y) / Hf,
      z: z ?? 0,
    }
  }
  return { points, depthSource }
}

/** 側面がない時: MediaPipe のワールド座標 z（カメラに近いほど小さい）を体の高さでそろえる */
function worldDepth(front: PlaneRecord): (i: number) => number | null {
  const w = front.worldLandmarksRaw
  if (!w || w.length < 33) return () => null
  const earY = (w[7].y + w[8].y) / 2
  const heelY = (w[29].y + w[30].y) / 2
  const Hw = Math.abs(heelY - earY)
  const ankleZ = (w[27].z + w[28].z) / 2
  if (Hw === 0) return () => null
  return (i) => -(w[i].z - ankleZ) / Hw
}
