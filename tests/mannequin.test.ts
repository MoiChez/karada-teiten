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

  it('プロフィールの性別から体のモデルを選ぶ', () => {
    expect(mannequinKindOf('male')).toBe('male')
    expect(mannequinKindOf('female')).toBe('female')
    expect(mannequinKindOf('other')).toBe('neutral')
    expect(mannequinKindOf('no_answer')).toBe('neutral')
    expect(mannequinKindOf(undefined)).toBe('neutral')
  })
})
