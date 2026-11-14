/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { fuse3D, type Pose3D } from '../src/domain/fusion3d'
import { mannequinKindOf, paintMannequin, poseMannequin, type MannequinKind } from '../src/three/mannequin'
import { frontPose, record, sidePose } from './helpers'

async function load(kind: MannequinKind): Promise<THREE.Object3D> {
  const buf = readFileSync(`public/models/mannequin-v1-${kind}.glb`)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Promise((resolve, reject) => new GLTFLoader().parse(ab, '', (g) => resolve(g.scene), reject))
}

const JOINT_BONE: Record<number, string> = { 11: 'upperarm_l', 12: 'upperarm_r', 13: 'lowerarm_l', 14: 'lowerarm_r', 15: 'hand_l', 16: 'hand_r', 23: 'thigh_l', 24: 'thigh_r', 25: 'calf_l', 26: 'calf_r', 27: 'foot_l', 28: 'foot_r' }

function pointOf(root: THREE.Object3D, i: number) {
  const name = JOINT_BONE[i] ?? `lm_${i}`
  return root.getObjectByName(name)!.getWorldPosition(new THREE.Vector3())
}

const vec = (p: Pose3D, i: number) => new THREE.Vector3(p.points[i]!.x, p.points[i]!.y, p.points[i]!.z)
const mid = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().add(b).multiplyScalar(0.5)
const angleDeg = (a: THREE.Vector3, b: THREE.Vector3) => (a.angleTo(b) * 180) / Math.PI

/** 頭が前に出て、上半身が少し前に傾き、右肩が下がった姿勢 */
function samplePose(): Pose3D {
  const front = record('front', frontPose({ leftShoulderDrop: -15, shoulderShiftX: 10 }))
  const side = record('side', sidePose({ earForward: 90, shoulderForward: 40, hipForward: 15, wristForward: 30 }))
  return fuse3D(front, side)!
}

describe('マネキンを測った姿勢に合わせる', () => {
  it('3 種類のモデルを読み込める（骨と目印がそろっている）', async () => {
    for (const k of ['male', 'female', 'neutral'] as const) {
      const root = await load(k)
      for (const name of ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head', 'upperarm_l', 'calf_r', 'foot_l', 'lm_0', 'lm_7', 'lm_8', 'lm_29', 'lm_32']) {
        expect(root.getObjectByName(name), `${k}: ${name}`).toBeTruthy()
      }
    }
  })

  it('胴・腕・脚の向きが、測った関節の向きに 1° 以内で重なる', async () => {
    const root = await load('neutral')
    const pose = samplePose()
    const fit = poseMannequin(root, pose)
    expect(fit.fitted).toEqual(expect.arrayContaining(['pelvis', 'trunk', 'neck_head', 'upperarm_l', 'lowerarm_r', 'thigh_l', 'calf_r', 'foot_l']))
    const segs: [number, number][] = [
      [11, 13],
      [13, 15],
      [12, 14],
      [14, 16],
      [23, 25],
      [25, 27],
      [24, 26],
      [26, 28],
      [23, 24],
    ]
    for (const [a, b] of segs) {
      const got = pointOf(root, b).sub(pointOf(root, a))
      const want = vec(pose, b).sub(vec(pose, a))
      expect(angleDeg(got, want), `${a}-${b}`).toBeLessThan(1)
    }
    const trunkGot = mid(pointOf(root, 11), pointOf(root, 12)).sub(mid(pointOf(root, 23), pointOf(root, 24)))
    const trunkWant = mid(vec(pose, 11), vec(pose, 12)).sub(mid(vec(pose, 23), vec(pose, 24)))
    expect(angleDeg(trunkGot, trunkWant)).toBeLessThan(1)
    // 首（肩の中点→耳の中点）はくり返しで合わせるので、少しの差を許す
    const neckGot = mid(pointOf(root, 7), pointOf(root, 8)).sub(mid(pointOf(root, 11), pointOf(root, 12)))
    const neckWant = mid(vec(pose, 7), vec(pose, 8)).sub(mid(vec(pose, 11), vec(pose, 12)))
    expect(angleDeg(neckGot, neckWant)).toBeLessThan(3)
  })

  it('体の高さを 1 にそろえ、両足首の中点を測った位置に置く', async () => {
    const root = await load('male')
    const pose = samplePose()
    poseMannequin(root, pose)
    const ankle = mid(pointOf(root, 27), pointOf(root, 28))
    const want = mid(vec(pose, 27), vec(pose, 28))
    expect(ankle.distanceTo(want)).toBeLessThan(1e-6)
    // 耳〜かかとの高さは 1 前後（姿勢で少し縮む）
    const h = mid(pointOf(root, 7), pointOf(root, 8)).y - mid(pointOf(root, 29), pointOf(root, 30)).y
    expect(h).toBeGreaterThan(0.9)
    expect(h).toBeLessThan(1.02)
  })

  it('何度合わせ直しても同じ結果になる（毎回最初の姿勢から曲げる）', async () => {
    const root = await load('female')
    const pose = samplePose()
    poseMannequin(root, pose)
    const first = pointOf(root, 15)
    const other = fuse3D(record('front', frontPose()), record('side', sidePose()))!
    poseMannequin(root, other)
    poseMannequin(root, pose)
    expect(pointOf(root, 15).distanceTo(first)).toBeLessThan(1e-6)
  })

  it('関連する部位だけを色づける（関節はなめらかに）', async () => {
    const root = await load('neutral')
    paintMannequin(root, '#cccccc', '#ff0000', new Set(['knees']))
    let mesh: THREE.SkinnedMesh | undefined
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh
    })
    const color = mesh!.geometry.getAttribute('color')
    const pos = mesh!.geometry.getAttribute('position')
    // 色が付いた頂点は膝の高さのあたりだけ
    const knee = root.getObjectByName('calf_l')!.getWorldPosition(new THREE.Vector3())
    let red = 0
    for (let i = 0; i < color.count; i++) {
      const r = color.getX(i)
      const g = color.getY(i)
      if (r - g > 0.25) {
        red++
        expect(Math.abs(pos.getY(i) - knee.y)).toBeLessThan(0.15)
      }
    }
    expect(red).toBeGreaterThan(50)
  })

  it('座って行う種目は、腰を固定し、骨の長さを保ったまま足首・手首を測った位置に届かせる', async () => {
    const root = await load('male')
    // エルゴのキャッチに近い形: 腰を後ろに、膝を高く、足首を前に、手を前へ
    const p = (x: number, y: number, z: number) => ({ x, y, z })
    const points: Pose3D['points'] = Array.from({ length: 33 }, () => null)
    const set = (l: number, r: number, y: number, z: number, w: number) => {
      points[l] = p(w, y, z)
      points[r] = p(-w, y, z)
    }
    set(7, 8, 0.78, 0.18, 0.06)
    set(11, 12, 0.64, 0.12, 0.11)
    set(13, 14, 0.5, 0.26, 0.13)
    set(15, 16, 0.42, 0.42, 0.13)
    set(23, 24, 0.3, 0, 0.06)
    set(25, 26, 0.52, 0.2, 0.07)
    set(27, 28, 0.28, 0.36, 0.06)
    set(29, 30, 0.26, 0.33, 0.06)
    set(31, 32, 0.24, 0.46, 0.06)
    points[0] = p(0, 0.76, 0.24)
    const pose: Pose3D = { points, depthSource: 'side_photo' }
    for (let k = 0; k < 2; k++) {
      poseMannequin(root, pose, { anchor: 'hips' })
      root.updateMatrixWorld(true)
      // 腰は測った位置に重なる
      expect(mid(pointOf(root, 23), pointOf(root, 24)).distanceTo(mid(vec(pose, 23), vec(pose, 24)))).toBeLessThan(1e-3)
      // 足首は測った位置に届く（届く距離なので）
      for (const i of [27, 28]) expect(pointOf(root, i).distanceTo(vec(pose, i))).toBeLessThan(0.01)
      // 膝は上（測った膝の側）へ曲がる
      expect(pointOf(root, 25).y).toBeGreaterThan(pointOf(root, 23).y + 0.1)
    }
  })

  it('動きの再生で本人の骨の長さがあると、胴は肩の点の向きのまま倒し、耳・肩・ひじ・手首・膝・足首が測った点に重なる', async () => {
    const root = await load('male')
    root.updateMatrixWorld(true)
    const p = (x: number, y: number, z: number) => ({ x, y, z })
    const V = (y: number, z: number) => new THREE.Vector3(0, y, z)
    const dir = (deg: number) => V(Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180))
    const lean = (v: THREE.Vector3) => (Math.atan2(v.z, v.y) * 180) / Math.PI
    // 胴の中ほど（背骨の真ん中の骨の付け根）の、股関節の中点→両肩の中点の線からの角度（最初の姿勢で）
    const thorax = () => root.getObjectByName('spine_03')!.getWorldPosition(new THREE.Vector3()).sub(mid(pointOf(root, 23), pointOf(root, 24)))
    const restOff = lean(thorax()) - lean(mid(pointOf(root, 11), pointOf(root, 12)).sub(mid(pointOf(root, 23), pointOf(root, 24))))
    // エルゴのフィニッシュ: 股関節→肩の点が 35° 後ろに倒れ、頭は起きている（首は胴に対して大きく前へ曲がる）。
    // ひじは後ろ下、手首は胸の前
    const hip = V(0.3, 0)
    const sh = hip.clone().add(dir(-35).multiplyScalar(0.27))
    const ear = sh.clone().add(dir(10).multiplyScalar(0.12))
    const elbow = sh.clone().add(dir(-165).multiplyScalar(0.18))
    const wrist = elbow.clone().add(dir(60).multiplyScalar(0.16))
    const points: Pose3D['points'] = Array.from({ length: 33 }, () => null)
    const set = (l: number, r: number, q: THREE.Vector3, w: number) => {
      points[l] = p(w, q.y, q.z)
      points[r] = p(-w, q.y, q.z)
    }
    set(23, 24, hip, 0.06)
    set(11, 12, sh, 0.11)
    set(7, 8, ear, 0.06)
    points[0] = p(0, ear.y - 0.01, ear.z + 0.07)
    set(13, 14, elbow, 0.125)
    set(15, 16, wrist, 0.13)
    const knee = hip.clone().add(dir(80).multiplyScalar(0.26))
    const ankle = knee.clone().add(dir(110).multiplyScalar(0.26))
    set(25, 26, knee, 0.06)
    set(27, 28, ankle, 0.06)
    set(29, 30, ankle.clone().add(V(-0.04, -0.02)), 0.06)
    set(31, 32, ankle.clone().add(V(0.02, 0.1)), 0.065)
    const pose: Pose3D = { points, depthSource: 'side_photo', bones: { upperArm: 0.18, foreArm: 0.16, thigh: 0.26, shank: 0.26, trunk: 0.25 } }
    for (let k = 0; k < 2; k++) {
      poseMannequin(root, pose, { anchor: 'hips', planarLegs: true })
      root.updateMatrixWorld(true)
      const near = (i: number, want: THREE.Vector3) => {
        const got = pointOf(root, i)
        return Math.hypot(got.y - want.y, got.z - want.z)
      }
      // 首の長さを変えて耳に届かせる
      expect(near(7, ear), 'ear').toBeLessThan(0.01)
      // 肩の関節は鎖骨を回して肩の点へ寄せる（鎖骨の付け根を中心に回るので、少しずれる）
      expect(near(11, sh), 'shoulder').toBeLessThan(0.02)
      expect(near(13, elbow), 'elbow').toBeLessThan(0.03)
      expect(near(15, wrist), 'wrist').toBeLessThan(0.01)
      expect(near(25, knee), 'knee').toBeLessThan(0.01)
      expect(near(27, ankle), 'ankle').toBeLessThan(0.01)
      // 胴は股関節→肩の点の向きに倒れている（耳の側へ起こさない）
      expect(Math.abs(lean(thorax()) - restOff - -35), 'thorax').toBeLessThan(6)
    }
  })

  it('座った姿勢（エルゴ・自転車）は、骨盤を後ろへ起こし（腰の反りを減らす）、関節の位置は変えない', async () => {
    const root = await load('male')
    root.updateMatrixWorld(true)
    const p = (x: number, y: number, z: number) => ({ x, y, z })
    const points: Pose3D['points'] = Array.from({ length: 33 }, () => null)
    const set = (l: number, r: number, y: number, z: number, w: number) => {
      points[l] = p(w, y, z)
      points[r] = p(-w, y, z)
    }
    set(23, 24, 0.3, 0, 0.06)
    set(11, 12, 0.57, -0.05, 0.11)
    set(7, 8, 0.69, -0.02, 0.06)
    set(13, 14, 0.42, -0.1, 0.125)
    set(15, 16, 0.5, 0.15, 0.13)
    set(25, 26, 0.33, 0.25, 0.06)
    set(27, 28, 0.2, 0.48, 0.06)
    set(29, 30, 0.18, 0.46, 0.06)
    set(31, 32, 0.22, 0.58, 0.065)
    const pose: Pose3D = { points, depthSource: 'side_photo', bones: { upperArm: 0.17, foreArm: 0.16, thigh: 0.26, shank: 0.26, trunk: 0.25 } }
    const shot = (seated: boolean) => {
      poseMannequin(root, pose, { anchor: 'hips', planarLegs: true, seated })
      root.updateMatrixWorld(true)
      const q = (n: string) => root.getObjectByName(n)!.getWorldQuaternion(new THREE.Quaternion())
      return { pelvis: q('pelvis'), chest: q('spine_03'), pts: [7, 11, 13, 15, 25, 27].map((i) => pointOf(root, i)) }
    }
    const a = shot(false)
    const b = shot(true)
    const deg = (q1: THREE.Quaternion, q2: THREE.Quaternion) => (q1.angleTo(q2) * 180) / Math.PI
    // 骨盤は後ろへ（体の前 +Z が上へ回る向き）30° 起こす
    expect(deg(a.pelvis, b.pelvis)).toBeCloseTo(30, 0)
    const fwd = (q: THREE.Quaternion) => new THREE.Vector3(0, 0, 1).applyQuaternion(q)
    expect(fwd(b.pelvis).y).toBeGreaterThan(fwd(a.pelvis).y)
    // 腰の骨の付け根が後ろへずれる分だけ、胸から上は少し前へ回って肩を測った線に戻す（骨盤の 30° よりずっと小さい）
    expect(deg(a.chest, b.chest)).toBeLessThan(12)
    // 関節は同じ位置
    a.pts.forEach((v, i) => expect(v.distanceTo(b.pts[i]), `point ${i}`).toBeLessThan(0.01))
  })

  it('エルゴ・自転車の手は順手で握る（手首はまっすぐ、手のひらが下、指と親指が手のひらの側へ曲がる）', async () => {
    const root = await load('male')
    const p = (x: number, y: number, z: number) => ({ x, y, z })
    const points: Pose3D['points'] = Array.from({ length: 33 }, () => null)
    const set = (l: number, r: number, y: number, z: number, w: number) => {
      points[l] = p(w, y, z)
      points[r] = p(-w, y, z)
    }
    // ドライブの途中: 腕はまっすぐ前へ、手首は肩より少し下
    set(23, 24, 0.3, 0, 0.06)
    set(11, 12, 0.57, 0.03, 0.11)
    set(7, 8, 0.69, 0.06, 0.06)
    set(13, 14, 0.52, 0.2, 0.125)
    set(15, 16, 0.48, 0.36, 0.13)
    set(25, 26, 0.38, 0.22, 0.06)
    set(27, 28, 0.2, 0.42, 0.06)
    set(29, 30, 0.18, 0.4, 0.06)
    set(31, 32, 0.22, 0.52, 0.065)
    const pose: Pose3D = { points, depthSource: 'side_photo', bones: { upperArm: 0.17, foreArm: 0.16, thigh: 0.26, shank: 0.26, trunk: 0.25 } }
    poseMannequin(root, pose, { anchor: 'hips', planarLegs: true, seated: true, grip: true })
    root.updateMatrixWorld(true)
    const W = (n: string) => root.getObjectByName(n)!.getWorldPosition(new THREE.Vector3())
    for (const [s, mirror] of [
      ['l', 1],
      ['r', -1],
    ] as const) {
      const fore = W(`hand_${s}`).sub(W(`lowerarm_${s}`)).normalize()
      const knuckles = W(`middle_01_${s}`)
      const a = knuckles.clone().sub(W(`hand_${s}`)).normalize()
      const k = W(`index_01_${s}`).sub(W(`pinky_01_${s}`))
      k.sub(a.clone().multiplyScalar(k.dot(a))).normalize()
      const palm = new THREE.Vector3().crossVectors(a, k).multiplyScalar(mirror).normalize()
      // 手首はまっすぐ（手の向き＝前腕の向き）
      expect(angleDeg(a, fore), `${s} wrist`).toBeLessThan(3)
      // 手のひらは下（前腕に垂直な面の中で、真下に近い向き）
      const down = new THREE.Vector3(0, -1, 0)
      const want = down.clone().sub(fore.clone().multiplyScalar(down.dot(fore))).normalize()
      expect(palm.dot(want), `${s} palm`).toBeGreaterThan(0.95)
      // 中指の先の骨と親指の先の骨は、指の付け根より手のひらの側（下）にある
      expect(W(`middle_03_${s}`).sub(knuckles).dot(palm), `${s} fingers`).toBeGreaterThan(0)
      expect(W(`thumb_03_${s}`).sub(knuckles).dot(palm), `${s} thumb`).toBeGreaterThan(0)
    }
  })

  it('動きの再生では、胴の前後の傾きの多くを骨盤で受け持ち、背骨を反らせすぎない（フィニッシュで腹が前に突き出ない）', async () => {
    const root = await load('male')
    root.updateMatrixWorld(true)
    const pelvis = root.getObjectByName('pelvis')!
    const restQ = pelvis.getWorldQuaternion(new THREE.Quaternion())
    const lean = (v: THREE.Vector3) => (Math.atan2(v.z, v.y) * 180) / Math.PI
    const trunk = () => mid(pointOf(root, 11), pointOf(root, 12)).sub(mid(pointOf(root, 23), pointOf(root, 24)))
    const restLean = lean(trunk())
    // 骨盤が最初の姿勢から前（+）・後ろ（-）へ傾いた角度
    const pelvisTilt = () => {
      const q = pelvis.getWorldQuaternion(new THREE.Quaternion()).multiply(restQ.clone().invert())
      return lean(new THREE.Vector3(0, 1, 0).applyQuaternion(q))
    }
    const p = (x: number, y: number, z: number) => ({ x, y, z })
    // 座って胴を deg だけ前（+）・後ろ（-）へ傾けた姿勢
    const seated = (deg: number): Pose3D => {
      const points: Pose3D['points'] = Array.from({ length: 33 }, () => null)
      const set = (l: number, r: number, y: number, z: number, w: number) => {
        points[l] = p(w, y, z)
        points[r] = p(-w, y, z)
      }
      const a = (deg * Math.PI) / 180
      set(23, 24, 0.3, 0, 0.06)
      set(11, 12, 0.3 + 0.3 * Math.cos(a), 0.3 * Math.sin(a), 0.11)
      set(7, 8, 0.3 + 0.4 * Math.cos(a), 0.4 * Math.sin(a), 0.06)
      set(13, 14, 0.3 + 0.18 * Math.cos(a), 0.18 * Math.sin(a) + 0.1, 0.125)
      set(15, 16, 0.3 + 0.18 * Math.cos(a), 0.18 * Math.sin(a) + 0.3, 0.13)
      set(25, 26, 0.33, 0.25, 0.06)
      set(27, 28, 0.2, 0.48, 0.06)
      set(29, 30, 0.18, 0.46, 0.06)
      set(31, 32, 0.22, 0.58, 0.065)
      return { points, depthSource: 'side_photo' }
    }
    for (const deg of [-30, -15, 0, 20, 40, 60]) {
      poseMannequin(root, seated(deg), { anchor: 'hips', planarLegs: true })
      root.updateMatrixWorld(true)
      const got = lean(trunk())
      // 胴の向きは測った向きのまま
      expect(Math.abs(got - deg), `${deg}°`).toBeLessThan(1.5)
      // 背骨の曲がり（胴の傾きの変化のうち、骨盤の傾きでない分）は、反らせて 5°、丸めて 30° まで
      const bend = got - restLean - pelvisTilt()
      expect(bend, `${deg}°`).toBeGreaterThan(-5.5)
      expect(bend, `${deg}°`).toBeLessThan(30.5)
      if (Math.abs(deg - restLean) > 10) expect(Math.abs(pelvisTilt()), `${deg}°`).toBeGreaterThan(0.5 * Math.abs(deg - restLean))
    }
  })

  it('プロフィールの性別から体のモデルを選ぶ', () => {
    expect(mannequinKindOf('male')).toBe('male')
    expect(mannequinKindOf('female')).toBe('female')
    expect(mannequinKindOf('other')).toBe('neutral')
    expect(mannequinKindOf('no_answer')).toBe('neutral')
    expect(mannequinKindOf(undefined)).toBe('neutral')
  })
})
