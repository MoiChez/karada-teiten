// マネキン（MPFB の標準の人体、tools/blender/make_mannequins.py で作ったもの）を、
// 正面と横向きの写真から合成した関節の位置（fusion3d）の「向き」に合わせて曲げる。
// 骨の長さと体の形は標準のまま（体型は推定しない）。docs/07 の 3 章
import * as THREE from 'three'
import type { BoneLengths, Pose3D, Vec3 } from '../domain/fusion3d'
import type { BodyArea, UserProfile } from '../domain/types'
import type { MuscleKey } from '../domain/motionSports'
import { TORSO_ROWS } from '../domain/torsoDepth'

export type MannequinKind = 'male' | 'female' | 'neutral'

export const MANNEQUIN_LABELS: Record<MannequinKind, string> = {
  male: '標準の男性の体',
  female: '標準の女性の体',
  neutral: '男女の中間の標準の体',
}

/** プロフィールの性別から体のモデルを選ぶ（未回答・その他は中間） */
export function mannequinKindOf(sex: UserProfile['sex'] | undefined): MannequinKind {
  return sex === 'male' ? 'male' : sex === 'female' ? 'female' : 'neutral'
}

/** MediaPipe の点と、その関節が付け根になる骨 */
const JOINT_BONE: Record<number, string> = {
  11: 'upperarm_l',
  12: 'upperarm_r',
  13: 'lowerarm_l',
  14: 'lowerarm_r',
  15: 'hand_l',
  16: 'hand_r',
  23: 'thigh_l',
  24: 'thigh_r',
  25: 'calf_l',
  26: 'calf_r',
  27: 'foot_l',
  28: 'foot_r',
}
/** 骨の子として置いた目印（鼻・耳・かかと・つま先） */
const MARKERS = [0, 7, 8, 29, 30, 31, 32]

export interface PoseFit {
  /** 体の高さ（耳〜かかと）を 1 にする倍率 */
  scale: number
  /** 向きを合わせた部位（説明・テスト用） */
  fitted: string[]
}

const v = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z)

/** 各マネキンの最初の姿勢（骨ごとの回転と、親から見た位置） */
const REST = new WeakMap<THREE.Object3D, Map<string, { q: THREE.Quaternion; p: THREE.Vector3 }>>()
const mid = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().add(b).multiplyScalar(0.5)

/** 骨を、ワールド座標での回転 dq だけ回す */
function rotateWorld(bone: THREE.Object3D, dq: THREE.Quaternion) {
  const parentQ = new THREE.Quaternion()
  bone.parent?.getWorldQuaternion(parentQ)
  const worldQ = bone.getWorldQuaternion(new THREE.Quaternion())
  bone.quaternion.copy(parentQ.invert().multiply(dq.clone().multiply(worldQ)))
  bone.updateMatrixWorld(true)
}

function swing(from: THREE.Vector3, to: THREE.Vector3) {
  return new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize())
}

/** 主軸 a（正規化）と副軸 b（a に直交化）から作る正規直交基底 */
function frame(a: THREE.Vector3, b: THREE.Vector3) {
  const x = a.clone().normalize()
  const y = b.clone().sub(x.clone().multiplyScalar(b.dot(x))).normalize()
  const z = new THREE.Vector3().crossVectors(x, y)
  return new THREE.Matrix4().makeBasis(x, y, z)
}

/** 基底 cur を基底 tgt に重ねる回転 */
function frameRotation(curA: THREE.Vector3, curB: THREE.Vector3, tgtA: THREE.Vector3, tgtB: THREE.Vector3) {
  const c = frame(curA, curB)
  const t = frame(tgtA, tgtB)
  return new THREE.Quaternion().setFromRotationMatrix(t.multiply(c.transpose()))
}

/**
 * root（GLB の scene の複製）を pose に合わせる。何度呼んでもよい（毎回、最初の姿勢に戻してから曲げる）。
 * anchor = 'ankles'（既定）: 腕と脚は関節の向きだけを合わせ、両足首の中点が pose の両足首の中点に重なるように置く。
 * anchor = 'hips'（動きの再生）: 両股関節の中点を pose に重ね、脚と腕は骨の長さを保ったまま、
 * 足首・手首が pose の位置に届くように曲げる（膝・ひじは pose の膝・ひじの側へ曲げる）。腰が浮き沈みしないように。
 * seated（エルゴ・自転車）: 座った姿勢の腰（腰の反りを戻す）。grip（エルゴ・自転車）: 手を順手でハンドルを握る形にする
 */
export function poseMannequin(
  root: THREE.Object3D,
  pose: Pose3D,
  opts: { anchor?: 'ankles' | 'hips'; planarLegs?: boolean; seated?: boolean; grip?: boolean } = {},
): PoseFit {
  const bones = new Map<string, THREE.Object3D>()
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone || o.name.startsWith('lm_')) bones.set(o.name, o)
  })
  // 最初の姿勢を覚えておき、毎回そこから曲げる
  let rest = REST.get(root)
  if (!rest) REST.set(root, (rest = new Map()))
  for (const [name, b] of bones) {
    if (!rest.has(name)) rest.set(name, { q: b.quaternion.clone(), p: b.position.clone() })
    const r = rest.get(name)!
    b.quaternion.copy(r.q)
    // 手足の長さの合わせ（動きの再生で、骨の付け根の位置を動かす）も戻す
    b.position.copy(r.p)
  }
  // 胴の長さの合わせ（背骨の付け根から上の大きさ）を戻す
  bones.get('spine_01')?.scale.setScalar(1)
  root.position.set(0, 0, 0)
  root.scale.setScalar(1)
  root.quaternion.identity()
  root.updateMatrixWorld(true)

  const P = (i: number) => {
    const name = JOINT_BONE[i] ?? (MARKERS.includes(i) ? `lm_${i}` : null)
    const o = name ? bones.get(name) : undefined
    if (!o) throw new Error(`mannequin: point ${i} not found`)
    return o.getWorldPosition(new THREE.Vector3())
  }
  const T = (i: number) => (pose.points[i] ? v(pose.points[i]!) : null)
  const has = (...ids: number[]) => ids.every((i) => pose.points[i])
  const B = (name: string) => {
    const b = bones.get(name)
    if (!b) throw new Error(`mannequin: bone ${name} not found`)
    return b
  }
  const fitted: string[] = []

  // 体の高さ（耳の中点〜かかとの中点）。最初の姿勢で測る
  const Hm = mid(P(7), P(8)).y - mid(P(29), P(30)).y

  // 骨盤: 左右の股関節を結ぶ線（前後の傾きは測れないので変えない）
  if (has(23, 24)) {
    rotateWorld(B('pelvis'), swing(P(23).sub(P(24)), T(23)!.sub(T(24)!)))
    fitted.push('pelvis')
  }

  // 動きの再生での、胴の上の端（両肩の関節の中点）の目標。ふだんは両肩の点の中点。
  // 本人の胴の長さがあるときは、股関節の中点から両肩の点の中点へ向かう線の上の、胴の長さのところに置く
  // （肩の点は肩甲骨の動きで胴に対して上下・前後に動くので、肩の関節は下で鎖骨を回して肩の点へ寄せる）。
  // 胴の向きは肩の点の向きのまま変えない。横から撮った動画の人の背中の輪郭は、この線に沿ってまっすぐ倒れていた
  let tShoulder = has(11, 12) ? mid(T(11)!, T(12)!) : null
  const len = opts.anchor === 'hips' ? pose.bones?.trunk : undefined
  /** 胴の向き（股関節の中点→両肩の点の中点。動きの再生で使う） */
  let trunkDir: THREE.Vector3 | null = null
  if (len && tShoulder && has(23, 24)) {
    const hipT = mid(T(23)!, T(24)!)
    const u = tShoulder.clone().sub(hipT)
    if (u.lengthSq() > 1e-12) {
      trunkDir = u.normalize()
      tShoulder = hipT.add(trunkDir.clone().multiplyScalar(len))
    }
  }

  // 動きの再生では、胴の前後の傾きの多くを骨盤の傾きで受け持ち、背骨は傾きの 35% だけ曲げる（反らせるのは 5°、
  // 丸めるのは 30° まで）。骨盤を立てたまま背骨だけで傾けると、エルゴのフィニッシュで腰が大きく反って腹と胸が前へ
  // 突き出し、人の体ではありえない形になっていたため（実際は骨盤ごと後ろへ倒れる。キャッチ・自転車・スクワットの前傾も同じ）
  if (opts.anchor === 'hips' && tShoulder && has(23, 24)) {
    const left = P(23).sub(P(24)).normalize()
    const fwd = new THREE.Vector3().crossVectors(left, new THREE.Vector3(0, 1, 0)).normalize()
    const up = new THREE.Vector3().crossVectors(fwd, left)
    const lean = (u: THREE.Vector3) => Math.atan2(u.dot(fwd), u.dot(up))
    let d = lean(tShoulder.clone().sub(mid(T(23)!, T(24)!))) - lean(mid(P(11), P(12)).sub(mid(P(23), P(24))))
    d = Math.atan2(Math.sin(d), Math.cos(d))
    const bend = Math.min(SPINE_FLEX_MAX, Math.max(-SPINE_EXT_MAX, SPINE_SHARE * d))
    rotateWorld(B('pelvis'), new THREE.Quaternion().setFromAxisAngle(left, d - bend))
    // 座った姿勢: 骨盤を後ろへ起こし、同じだけ腰の骨（背骨のいちばん下）を前へ曲げて、胸から上の向きはそのままにする。
    // 標準の体は立った姿勢の腰の反りを持っていて、エルゴで背中をまっすぐにして座る人に重ねると、腰のところだけ
    // 3D の背中が内側に入って曲がって見えたため（座ると骨盤が後ろへ傾き、腰の反りが減る）
    if (opts.seated) {
      rotateWorld(B('pelvis'), new THREE.Quaternion().setFromAxisAngle(left, -SEATED_PELVIS))
      rotateWorld(B('spine_01'), new THREE.Quaternion().setFromAxisAngle(left, SEATED_PELVIS))
    }
    // 胴の長さを合わせる（股関節の中点〜両肩の関節の中点を、本人の長さにする）。背骨の付け根から上をまとめて
    // 大きさを変えるので、腕と頭も同じ割合で変わる（腕は下で本人の長さに合わせ直す）。
    // 背骨の付け根を中心に大きさが変わり、股関節から見た胴の向きが少しずれるので、胴の向きを合わせる前に行う
    // 本人の胴の長さがあるときは、大きさが背骨の付け根を中心に変わる分も、股関節の中点からの長さが合うまで数回くり返す
    const want = len ?? tShoulder.distanceTo(mid(T(23)!, T(24)!))
    for (let k = 0; k < (len ? 3 : 1); k++) {
      const cur = mid(P(11), P(12)).distanceTo(mid(P(23), P(24))) / Hm
      if (!(cur > 1e-6)) break
      B('spine_01').scale.setScalar(Math.min(1.35, Math.max(0.8, (B('spine_01').scale.x * want) / cur)))
      root.updateMatrixWorld(true)
    }
  }

  // 胴: 股関節の中点→肩の中点の向きと、肩の線。背骨の 3 本に分けて少しずつ曲げる
  if (tShoulder && has(11, 12, 23, 24)) {
    const tUp = tShoulder.clone().sub(mid(T(23)!, T(24)!))
    const tSide = T(11)!.sub(T(12)!)
    const parts: [string, number][] = [
      ['spine_01', 1 / 3],
      ['spine_02', 1 / 2],
      ['spine_03', 1],
    ]
    for (const [name, frac] of parts) {
      const cUp = mid(P(11), P(12)).sub(mid(P(23), P(24)))
      const cSide = P(11).sub(P(12))
      const q = frameRotation(cUp, cSide, tUp, tSide)
      rotateWorld(B(name), new THREE.Quaternion().slerp(q, frac))
    }
    // 背骨の骨はそれぞれの付け根で回るので、股関節の中点から見た胴の向きが少しずれる（前へ 40° 倒すと 3° ほど）。
    // いちばん上の骨で数回合わせ直す
    for (let k = 0; k < 3; k++) {
      rotateWorld(B('spine_03'), frameRotation(mid(P(11), P(12)).sub(mid(P(23), P(24))), P(11).sub(P(12)), tUp, tSide))
    }
    fitted.push('trunk')
  }

  // 首と頭: 肩の中点→耳の中点の向き、耳の線と鼻の向き（首と頭の付け根がずれているので数回くり返す）。
  // 動きの再生で本人の胴の長さがあるときは、首の付け根から耳へ向け、首の骨の長さも耳に届くように変える（0.8〜1.7 倍）。
  // 胴を後ろへ倒して頭を起こすフィニッシュでは、首が胴に対して大きく前へ曲がるため
  if (tShoulder && has(7, 8, 11, 12)) {
    const tEarMid = mid(T(7)!, T(8)!)
    const head0 = B('head').position.clone()
    for (let k = 0; k < 3; k++) {
      if (len) {
        const base = B('neck_01').getWorldPosition(new THREE.Vector3())
        // 首の付け根の目標の位置（体の高さを 1 にした座標）。胴は合わせ終わっているので、股関節の中点（重ねる点）からの差で求める
        const baseT = mid(T(23)!, T(24)!).add(base.clone().sub(mid(P(23), P(24))).divideScalar(Hm))
        const want = tEarMid.clone().sub(baseT)
        rotateWorld(B('neck_01'), swing(mid(P(7), P(8)).sub(base), want))
        const short = want.length() * Hm - mid(P(7), P(8)).distanceTo(base)
        const h = Math.min(NECK_MAX * head0.length(), Math.max(0.8 * head0.length(), B('head').position.length() + short / B('spine_01').scale.x))
        B('head').position.copy(head0).setLength(h)
        root.updateMatrixWorld(true)
        rotateWorld(B('neck_01'), swing(mid(P(7), P(8)).sub(base), want))
      } else {
        rotateWorld(B('neck_01'), swing(mid(P(7), P(8)).sub(mid(P(11), P(12))), tEarMid.clone().sub(tShoulder)))
      }
      if (has(0)) {
        const tEar = T(7)!.sub(T(8)!)
        const tFwd = T(0)!.sub(tEarMid)
        rotateWorld(B('head'), frameRotation(P(7).sub(P(8)), P(0).sub(mid(P(7), P(8))), tEar, tFwd))
      }
    }
    fitted.push(has(0) ? 'neck_head' : 'neck')
  }

  // 動きの再生: 先に大きさと位置（両股関節の中点）を決め、脚と腕を届かせる
  if (opts.anchor === 'hips' && has(23, 24)) {
    const scale = 1 / Hm
    root.scale.setScalar(scale)
    root.updateMatrixWorld(true)
    root.position.add(mid(T(23)!, T(24)!).sub(mid(P(23), P(24))))
    root.updateMatrixWorld(true)
    // 肩の関節: 推定の肩の点へ、鎖骨を回して寄せる（30° まで。前後・上下だけで、左右は動かさない）。
    // 胴の長さは耳から決めた本人の値で、肩の点は肩甲骨の動きで胴に対して動く（キャッチでは前と上、フィニッシュでは後ろ）ため
    if (trunkDir && has(11, 12)) {
      for (const [clav, i] of [
        ['clavicle_l', 11],
        ['clavicle_r', 12],
      ] as const) {
        const c = bones.get(clav)
        if (!c) continue
        const C = c.getWorldPosition(new THREE.Vector3())
        const cur = P(i)
        const d = T(i)!.sub(cur).setX(0)
        const q = swing(cur.clone().sub(C), cur.clone().add(d).sub(C))
        const ang = 2 * Math.acos(Math.min(1, Math.abs(q.w)))
        rotateWorld(c, ang > CLAVICLE_MAX ? new THREE.Quaternion().slerp(q, CLAVICLE_MAX / ang) : q)
      }
    }
    // 手足の長さを、本人の骨の長さ（動きの記録から 1 つに決めた値）にする。標準の体の長さのままだと、
    // ひじ・膝が動画の点からずれるため。骨の先の関節を骨に沿って動かすので、太さは変わらない（0.75〜1.35 倍）
    const L = pose.bones
    if (L) {
      // 骨の先の関節（子の骨の付け根）を、骨の向きに沿って動かす
      const fit = (child: string, a: number, b: number, want: number) => {
        const cur = P(a).distanceTo(P(b))
        if (!(cur > 1e-6) || !(want > 0)) return
        B(child).position.multiplyScalar(Math.min(1.35, Math.max(0.75, want / cur)))
        root.updateMatrixWorld(true)
      }
      for (const [lower, end, a, b, c, lu, ll] of [
        ['calf_l', 'foot_l', 23, 25, 27, L.thigh, L.shank],
        ['calf_r', 'foot_r', 24, 26, 28, L.thigh, L.shank],
        ['lowerarm_l', 'hand_l', 11, 13, 15, L.upperArm, L.foreArm],
        ['lowerarm_r', 'hand_r', 12, 14, 16, L.upperArm, L.foreArm],
      ] as const) {
        fit(lower, a, b, lu)
        fit(end, b, c, ll)
      }
    }
    // 胴の前後の厚みを、動画の人の輪郭から測った厚みに合わせる（腰・背中の中ほど・胸の高さごと。0.75〜1.75 倍）
    setTorsoDepth(root, len && L?.torsoDepth && has(11, 12) ? torsoScales(root, L, mid(T(23)!, T(24)!), mid(T(11)!, T(12)!)) : null)
    // 曲げる向きの好み（体の左が +X、前が +Z）: 膝は前と上、ひじは後ろと下と少し外。
    // 脚が伸び切る・腕が伸び切るときは、目標の膝・ひじが一直線の上に来て、曲げる向きがコマごとに反転しやすいため
    const KNEE = new THREE.Vector3(0, 0.4, 1)
    const elbow = (side: 1 | -1) => new THREE.Vector3(0.45 * side, -1, -0.5)
    for (const [upper, lower, a, b, c, prefer, planar] of [
      ['thigh_l', 'calf_l', 23, 25, 27, KNEE, !!opts.planarLegs],
      ['thigh_r', 'calf_r', 24, 26, 28, KNEE, !!opts.planarLegs],
      ['upperarm_l', 'lowerarm_l', 11, 13, 15, elbow(1), false],
      ['upperarm_r', 'lowerarm_r', 12, 14, 16, elbow(-1), false],
    ] as const) {
      if (!has(b, c)) continue
      reach(B(upper), B(lower), P(a), P(b), P(c), T(b)!, T(c)!, planar, prefer)
      // 曲げた後の位置で次の骨を合わせるので、上の P は曲げる前の値。下で付け根から測り直す
      fitted.push(upper, lower)
    }
    for (const [bone, heel, toe] of [
      ['foot_l', 29, 31],
      ['foot_r', 30, 32],
    ] as const) {
      if (!has(heel, toe)) continue
      rotateWorld(B(bone), swing(P(toe).sub(P(heel)), T(toe)!.sub(T(heel)!)))
      fitted.push(bone)
    }
    if (opts.grip) {
      gripHand(bones, 'l', 1)
      gripHand(bones, 'r', -1)
      fitted.push('grip')
    }
    return { scale, fitted }
  }

  // 腕と脚: 関節から次の関節への向き
  const limb = (bone: string, a: number, b: number, fallback: THREE.Vector3) => {
    const dir = has(a, b) ? T(b)!.sub(T(a)!) : fallback
    rotateWorld(B(bone), swing(P(b).sub(P(a)), dir))
    if (has(a, b)) fitted.push(bone)
  }
  const down = new THREE.Vector3(0, -1, 0)
  limb('upperarm_l', 11, 13, down)
  limb('lowerarm_l', 13, 15, down)
  limb('upperarm_r', 12, 14, down)
  limb('lowerarm_r', 14, 16, down)
  limb('thigh_l', 23, 25, down)
  limb('calf_l', 25, 27, down)
  limb('thigh_r', 24, 26, down)
  limb('calf_r', 26, 28, down)
  // 足: かかと→つま先の向き
  for (const [bone, heel, toe] of [
    ['foot_l', 29, 31],
    ['foot_r', 30, 32],
  ] as const) {
    if (!has(heel, toe)) continue
    rotateWorld(B(bone), swing(P(toe).sub(P(heel)), T(toe)!.sub(T(heel)!)))
    fitted.push(bone)
  }

  setTorsoDepth(root, null)
  // 大きさと位置: 体の高さを 1 にし、両足首の中点を合わせる
  const scale = 1 / Hm
  const ankle = mid(P(27), P(28))
  const target = has(27, 28) ? mid(T(27)!, T(28)!) : new THREE.Vector3()
  root.scale.setScalar(scale)
  root.position.copy(target.sub(ankle.multiplyScalar(scale)))
  root.updateMatrixWorld(true)
  return { scale, fitted }
}

/** 動きの再生で、胴の前後の傾きのうち背骨で曲げる割合と、背骨を反らせる・丸める最大の角度（残りは骨盤の傾き） */
const SPINE_SHARE = 0.35
const SPINE_EXT_MAX = (5 * Math.PI) / 180
const SPINE_FLEX_MAX = (30 * Math.PI) / 180
/**
 * 座った姿勢で、立った姿勢より骨盤を後ろへ起こす角度（同じだけ腰の骨を前へ曲げる）。利用者のエルゴの動画で、人の背中の輪郭と
 * 3D の背中（腕を除く）の差が、股関節から肩までの高さのどこでもほぼ同じ（まっすぐ）になる角度（0・10・20・30° で比べた）
 */
const SEATED_PELVIS = (30 * Math.PI) / 180
/** 動きの再生で、肩の関節を肩の点へ寄せるときに鎖骨を回す最大の角度 */
const CLAVICLE_MAX = (30 * Math.PI) / 180
/**
 * 動きの再生で、首の骨（首の付け根〜頭の付け根）を耳に届かせるときの最大の倍率。エルゴのフィニッシュで胴を 35° 後ろへ倒して
 * 頭を起こすと、首の付け根から耳までが標準の体の 1.6 倍ほどになったため
 */
const NECK_MAX = 1.7
/** 胴を前後に厚くする形の、影響 1 のときの増え方（1 + TORSO_GAIN 倍）と、影響の範囲 */
const TORSO_GAIN = 0.5
const TORSO_INFLUENCE: [number, number] = [-0.5, 1.5]
/** 胴の前後の位置の形の、影響 1 のときのずれ（メッシュの元の単位。影響は -1〜1） */
const TORSO_SHIFT = 0.08
/**
 * 厚みを合わせる高さの帯（股関節の中点〜両肩の関節の中点の割合）。帯の形はこの高さで一番強く、隣の帯の高さで 0 になる
 * （腰の帯は股関節の高さ 0.1 で 0、胸の帯は 0.8 より上でも同じ強さ）。高さで分けるのは、標準の体は胸が厚く、
 * 腰と同じ倍率で厚くすると胸だけ外にはみ出したため（利用者のエルゴで、肩に近い高さで 2% 外）。股関節の高さは厚くしない
 * （座面に乗ったお尻が外にはみ出したため）
 */
const TORSO_BANDS = [0.4, 0.6, 0.8]
/** 帯ごとの、厚みを測る高さ（TORSO_ROWS の値） */
const TORSO_BAND_ROWS = [
  [0.35, 0.4, 0.45],
  [0.5, 0.55, 0.6],
  [0.65, 0.7, 0.75, 0.8],
]
/** 胴の頂点とみなす骨（重みの合計が胴の頂点の度合い） */
const TORSO_BONES = new Set(['pelvis', 'spine_01', 'spine_02', 'spine_03', 'clavicle_l', 'clavicle_r'])

/** 胴の形の、帯（腰・背中の中ほど・胸）ごとの値。thick は厚みの倍率、shift は前後の位置のずれ（体の単位、前が +） */
interface TorsoFit {
  thick: number[]
  shift: number[]
}

interface TorsoMorph {
  /** 形の番号（厚み・前後の位置、帯ごと） */
  index: { thick: number[]; shift: number[] }
  /** 胴の頂点（胴の骨の重みが半分以上）の番号。曲げた後の胴の厚みを測るのに使う */
  verts: number[]
}

/**
 * 胴を前後に厚くする形を、メッシュの形に足す（同じ形を使う複製どうしで 1 回だけ作る）。胴の骨の重みの頂点を、
 * その高さの胴の前後の中心から、前後へ離す（重みが小さい首・腕・脚の付け根ほど少なく）。最初の姿勢の胴の厚みも測っておく
 */
function torsoMorphOf(mesh: THREE.SkinnedMesh): TorsoMorph | null {
  const g = mesh.geometry
  if (g.userData.torsoMorph !== undefined) return g.userData.torsoMorph
  const pos = g.getAttribute('position')
  const si = g.getAttribute('skinIndex')
  const sw = g.getAttribute('skinWeight')
  const names = mesh.skeleton.bones.map((b) => b.name)
  const jointAt = (name: string) => {
    const i = names.indexOf(name)
    return i < 0 ? null : new THREE.Vector3().setFromMatrixPosition(mesh.skeleton.boneInverses[i].clone().invert())
  }
  const parts = ['thigh_l', 'thigh_r', 'upperarm_l', 'upperarm_r'].map(jointAt)
  if (!pos || !si || !sw || parts.some((p) => !p)) return (g.userData.torsoMorph = null)
  const hipY = (parts[0]!.y + parts[1]!.y) / 2
  const shY = (parts[2]!.y + parts[3]!.y) / 2
  const n = pos.count
  const w = new Float32Array(n)
  const p = new Float32Array(n * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < n; i++) {
    let t = 0
    for (let k = 0; k < 4; k++) if (TORSO_BONES.has(names[si.getComponent(i, k)])) t += sw.getComponent(i, k)
    w[i] = Math.min(1, t)
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix)
    p[i * 3] = v.x
    p[i * 3 + 1] = v.y
    p[i * 3 + 2] = v.z
  }
  // 高さ 1 cm ごとの、胴の前後の中心（体の真ん中付近の胴の頂点の、上下 2.5 cm の中の前後の端の中点）。
  // メッシュの頂点の段は粗く、1 cm の幅だと前側の頂点しかない段があり、中心がずれて背中の頂点が大きく飛び出したため。
  // 前後の幅が 10 cm に満たない段は、近い段の中心を使う
  const BAND = 0.01
  const WIN = 2.5
  const lo = Math.floor((hipY - 0.4) / BAND)
  const hi = Math.ceil((shY + 0.4) / BAND)
  const minZ = new Array(hi - lo + 1).fill(Infinity)
  const maxZ = new Array(hi - lo + 1).fill(-Infinity)
  for (let i = 0; i < n; i++) {
    if (w[i] < 0.9 || Math.abs(p[i * 3]) > 0.08) continue
    const c = p[i * 3 + 1] / BAND - lo
    for (let b = Math.max(0, Math.ceil(c - WIN)); b <= Math.min(minZ.length - 1, Math.floor(c + WIN)); b++) {
      minZ[b] = Math.min(minZ[b], p[i * 3 + 2])
      maxZ[b] = Math.max(maxZ[b], p[i * 3 + 2])
    }
  }
  const center: number[] = minZ.map((m, b) => (Number.isFinite(m) && maxZ[b] - m > 0.1 ? (m + maxZ[b]) / 2 : NaN))
  const known = center.map((c, b) => (Number.isFinite(c) ? b : -1)).filter((b) => b >= 0)
  if (!known.length) return (g.userData.torsoMorph = null)
  for (let b = 0; b < center.length; b++) {
    if (Number.isFinite(center[b])) continue
    const nearest = known.reduce((a, c) => (Math.abs(c - b) < Math.abs(a - b) ? c : a))
    center[b] = center[nearest]
  }
  // 形の向きは、メッシュの元の座標で表す（bindMatrixInverse は、体の大きさを変えると three.js が今の位置から作り直すので使わない）
  const toLocal = new THREE.Matrix3().setFromMatrix4(mesh.bindMatrix.clone().invert())
  // 帯の強さ（高さ t の折れ線）
  const bandWeight = (j: number, t: number) => {
    const c = TORSO_BANDS[j]
    const below = j === 0 ? 0.1 : TORSO_BANDS[j - 1]
    const above = TORSO_BANDS[j + 1]
    if (t <= below || (above !== undefined && t >= above)) return 0
    if (t <= c) return (t - below) / (c - below)
    return above === undefined ? 1 : (above - t) / (above - c)
  }
  // 厚み（中心から前後へ広げる）と、前後の位置（胴をそのまま前へずらす）の形。人の胴は、推定の股関節と肩の点を結ぶ線に対して、
  // 3D より後ろ寄りにあったため（利用者のエルゴで、線から背中までは前までの 2〜3 倍）
  const thick = TORSO_BANDS.map(() => new Float32Array(n * 3))
  const shift = TORSO_BANDS.map(() => new Float32Array(n * 3))
  const d = new THREE.Vector3()
  const e = new THREE.Vector3()
  for (let i = 0; i < n; i++) {
    if (w[i] <= 0) continue
    const b = Math.min(center.length - 1, Math.max(0, Math.round(p[i * 3 + 1] / BAND) - lo))
    const t = (p[i * 3 + 1] - hipY) / (shY - hipY)
    d.set(0, 0, (p[i * 3 + 2] - center[b]) * TORSO_GAIN * w[i]).applyMatrix3(toLocal)
    e.set(0, 0, TORSO_SHIFT * w[i]).applyMatrix3(toLocal)
    TORSO_BANDS.forEach((_, j) => {
      const k = bandWeight(j, t)
      if (k <= 0) return
      thick[j].set([d.x * k, d.y * k, d.z * k], i * 3)
      shift[j].set([e.x * k, e.y * k, e.z * k], i * 3)
    })
  }
  const morphs = g.morphAttributes.position ?? []
  g.morphAttributes.position = [...morphs, ...[...thick, ...shift].map((a) => new THREE.BufferAttribute(a, 3))]
  g.morphTargetsRelative = true
  const verts: number[] = []
  for (let i = 0; i < n; i++) if (w[i] >= 0.5) verts.push(i)
  const nb = TORSO_BANDS.length
  return (g.userData.torsoMorph = {
    index: { thick: TORSO_BANDS.map((_, j) => morphs.length + j), shift: TORSO_BANDS.map((_, j) => morphs.length + nb + j) },
    verts,
  })
}

/**
 * 胴の形を、帯（腰・背中の中ほど・胸）ごとに、厚みを fit.thick 倍にし、前後の位置を fit.shift（メッシュの元の単位）だけずらす
 * （null で元の形）
 */
function setTorsoDepth(root: THREE.Object3D, fit: TorsoFit | null) {
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    const m = torsoMorphOf(mesh)
    if (!m) return
    const last = Math.max(...m.index.thick, ...m.index.shift)
    if (!mesh.morphTargetInfluences || mesh.morphTargetInfluences.length <= last) mesh.updateMorphTargets()
    m.index.thick.forEach((idx, j) => {
      const f = fit?.thick[j] ?? 1
      mesh.morphTargetInfluences![idx] = Math.min(TORSO_INFLUENCE[1], Math.max(TORSO_INFLUENCE[0], (f - 1) / TORSO_GAIN))
    })
    m.index.shift.forEach((idx, j) => {
      const v = (fit?.shift[j] ?? 0) / TORSO_SHIFT
      mesh.morphTargetInfluences![idx] = Math.min(1, Math.max(-1, v))
    })
  })
}

/** 記録（骨の長さ）ごと・体のモデルごとの胴の形（最初に合わせたコマで 1 回だけ決める） */
const TORSO_SCALES = new WeakMap<BoneLengths, WeakMap<THREE.BufferGeometry, TorsoFit | null>>()

/**
 * 帯ごとの胴の厚みと前後の位置。今の姿勢（形を足す前）の 3D の胴を、動画と同じ測り方で測る: 股関節の中点→両肩の点の中点の線
 * （hip→sh、体の高さを 1 とした座標）の上の高さごとに、線に垂直な前後・上下の面の上で、胴の頂点の前と後ろの端の位置。
 * 動画の人の前と後ろの輪郭（脚の長さに対する比 × 体の高さの単位の脚の長さ）と比べて、
 * 厚み = 人の前後の幅 / 3D の前後の幅（前も後ろも測れた高さだけ。なければ標準の厚み）、
 * 前後の位置 = 厚みを合わせた後の 3D の背中から人の背中まで（背中を測れた高さ。背中が見えないときは前で）。
 * 帯の高さで 1 つも測れなかったときは、いちばん近い測れた帯の値の半分だけ変える（ゆったりした服の人で、胸の高さが外に
 * はみ出したため）。立った姿勢の 3D と比べると、座って骨盤を起こした胴では 1 割ほど食い違ったため、曲げた後で測る
 */
function torsoScales(root: THREE.Object3D, L: BoneLengths, hip: THREE.Vector3, sh: THREE.Vector3): TorsoFit | null {
  const depth = L.torsoDepth
  let mesh: THREE.SkinnedMesh | undefined
  root.traverse((o) => {
    if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh
  })
  const m = mesh && torsoMorphOf(mesh)
  if (!depth || !mesh || !m) return null
  let byGeom = TORSO_SCALES.get(L)
  if (!byGeom) TORSO_SCALES.set(L, (byGeom = new WeakMap()))
  const hit = byGeom.get(mesh.geometry)
  if (hit !== undefined) return hit
  setTorsoDepth(root, null)
  root.updateMatrixWorld(true)
  const axis = new THREE.Vector3(0, sh.y - hip.y, sh.z - hip.z)
  const len = axis.length()
  if (!(len > 1e-6)) return null
  axis.divideScalar(len)
  // 体の前（+Z）の側を + にする、線に垂直な向き
  const normal = new THREE.Vector3(0, -axis.z, axis.y)
  if (normal.z < 0) normal.negate()
  const lo = TORSO_ROWS.map(() => Infinity)
  const hi = TORSO_ROWS.map(() => -Infinity)
  const v = new THREE.Vector3()
  for (const i of m.verts) {
    mesh.getVertexPosition(i, v)
    v.applyMatrix4(mesh.matrixWorld)
    const dy = v.y - hip.y
    const dz = v.z - hip.z
    const f = (dy * axis.y + dz * axis.z) / len
    const nrm = dy * normal.y + dz * normal.z
    TORSO_ROWS.forEach((row, j) => {
      if (Math.abs(f - row) > 0.025) return
      lo[j] = Math.min(lo[j], nrm)
      hi[j] = Math.max(hi[j], nrm)
    })
  }
  // 3D の胴の単位（メッシュの元の長さ）と、体の高さの単位の比（背骨の付け根から上の大きさ × 全体の大きさ）
  const toPose = root.scale.x * (root.getObjectByName('spine_01')?.scale.x ?? 1)
  const legLen = L.leg ?? L.thigh + L.shank
  const ok = (x: number | null | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x)
  const rowsOf = (band: number[]) => band.map((f) => TORSO_ROWS.indexOf(f)).filter((j) => j >= 0 && hi[j] - lo[j] > 1e-4)
  const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null)
  const fill = (vals: (number | null)[], neutral: number) => {
    const known = vals.map((k, j) => (k === null ? -1 : j)).filter((j) => j >= 0)
    if (!known.length) return null
    return vals.map((k, j) => k ?? neutral + (vals[known.reduce((a, c) => (Math.abs(c - j) < Math.abs(a - j) ? c : a))]! - neutral) / 2)
  }
  const thick = fill(
    TORSO_BAND_ROWS.map((band) =>
      median(rowsOf(band).filter((j) => ok(depth.front[j]) && ok(depth.back[j])).map((j) => ((depth.front[j]! + depth.back[j]!) * legLen) / (hi[j] - lo[j]))),
    ),
    1,
  ) ?? TORSO_BANDS.map(() => 1)
  const shift = fill(
    TORSO_BAND_ROWS.map((band, b) =>
      median(
        rowsOf(band).flatMap((j) => {
          const c = (hi[j] + lo[j]) / 2
          const k = thick[b]
          if (ok(depth.back[j])) return [-depth.back[j]! * legLen - (c + (lo[j] - c) * k)]
          if (ok(depth.front[j])) return [depth.front[j]! * legLen - (c + (hi[j] - c) * k)]
          return []
        }),
      ),
    ),
    0,
  )
  const out = shift ? { thick, shift: shift.map((x) => x / toPose) } : null
  byGeom.set(mesh.geometry, out)
  return out
}

/** 順手でハンドルを握るときの、指の付け根・中・先の関節の曲げ（度）と、親指を人さし指の中ほどへ寄せる割合（付け根から先へ） */
const GRIP_FINGER = [50, 95, 65]
const GRIP_THUMB = [0.4, 0.6, 0.7]

/**
 * 手を順手（手のひらを下、手の甲を上）にして、指を曲げてハンドルを握る形にする。手首はまっすぐ（前腕の向き）。
 * mirror: 左手 1・右手 -1（手のひらの向きを、指の付け根の並びと手の向きから決めるときの符号）
 */
function gripHand(bones: Map<string, THREE.Object3D>, side: 'l' | 'r', mirror: 1 | -1) {
  const get = (n: string) => bones.get(`${n}_${side}`)
  const pos = (n: string) => get(n)?.getWorldPosition(new THREE.Vector3())
  const hand = get('hand')
  const elbow = pos('lowerarm')
  const wrist = pos('hand')
  if (!hand || !elbow || !wrist || !get('middle_01') || !get('index_01') || !get('pinky_01')) return
  // 今の手の向き（手首→中指の付け根）と手のひらの向き
  const palmOf = () => {
    const a = pos('middle_01')!.sub(pos('hand')!).normalize()
    const k = pos('index_01')!.sub(pos('pinky_01')!)
    k.sub(a.clone().multiplyScalar(k.dot(a))).normalize()
    return { a, n: new THREE.Vector3().crossVectors(a, k).multiplyScalar(mirror).normalize() }
  }
  const fore = wrist.clone().sub(elbow).normalize()
  const n = new THREE.Vector3(0, -1, 0)
  n.sub(fore.clone().multiplyScalar(n.dot(fore)))
  if (n.lengthSq() < 1e-6) n.set(0, 0, -1).sub(fore.clone().multiplyScalar(-fore.z))
  const cur = palmOf()
  rotateWorld(hand, frameRotation(cur.a, cur.n, fore, n.normalize()))
  // 指を手のひらの側へ曲げる（付け根から順に。曲げると先の骨の向きが変わるので、骨ごとに向きを測り直す）
  const curl = (names: string[], angles: number[]) => {
    names.forEach((name, j) => {
      const b = get(name)
      if (!b) return
      const next = j + 1 < names.length ? get(names[j + 1]) : undefined
      const p0 = b.getWorldPosition(new THREE.Vector3())
      const dir = next ? next.getWorldPosition(new THREE.Vector3()).sub(p0) : new THREE.Vector3(0, 1, 0).applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()))
      const axis = new THREE.Vector3().crossVectors(dir, palmOf().n)
      if (axis.lengthSq() < 1e-10) return
      rotateWorld(b, new THREE.Quaternion().setFromAxisAngle(axis.normalize(), (angles[j] * Math.PI) / 180))
    })
  }
  for (const f of ['index', 'middle', 'ring', 'pinky']) curl([`${f}_01`, `${f}_02`, `${f}_03`], GRIP_FINGER)
  // 親指はハンドルの下を回して、人さし指の中ほどへ向ける（付け根から順に、向きの一部だけ寄せる）
  const meet = get('index_02')
  if (!meet) return
  ;['thumb_01', 'thumb_02', 'thumb_03'].forEach((name, j, names) => {
    const b = get(name)
    if (!b) return
    const p0 = b.getWorldPosition(new THREE.Vector3())
    const next = j + 1 < names.length ? get(names[j + 1]) : undefined
    const dir = next ? next.getWorldPosition(new THREE.Vector3()).sub(p0) : new THREE.Vector3(0, 1, 0).applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()))
    const to = meet.getWorldPosition(new THREE.Vector3()).sub(p0)
    if (dir.lengthSq() < 1e-12 || to.lengthSq() < 1e-12) return
    rotateWorld(b, new THREE.Quaternion().slerp(swing(dir, to), GRIP_THUMB[j]))
  })
}



/**
 * 2 本の骨（上と下）を、長さを保ったまま、先端が target に届くように曲げる（届かなければ target の向きにまっすぐ伸ばす）。
 * 曲げる向きは、真ん中の関節の目標 mid の側。a・b・c は今の関節の位置（ワールド）
 */
function reach(
  upper: THREE.Object3D,
  lower: THREE.Object3D,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  midTarget: THREE.Vector3,
  target: THREE.Vector3,
  planar = false,
  prefer?: THREE.Vector3,
) {
  const l1 = b.distanceTo(a)
  const l2 = c.distanceTo(b)
  const d = target.clone().sub(a)
  const u = d.lengthSq() > 1e-12 ? d.clone().normalize() : new THREE.Vector3(0, -1, 0)
  const dist = Math.min(Math.max(d.length(), Math.abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4)
  const x = (dist * dist + l1 * l1 - l2 * l2) / (2 * dist)
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x))
  const pole = midTarget.clone().sub(a)
  pole.sub(u.clone().multiplyScalar(pole.dot(u)))
  // 横から撮った種目は、膝・ひじを前後・上下の面の中で曲げる（左右の推定の揺れで、膝が横に揺れないように）
  if (planar) {
    const side = new THREE.Vector3(1, 0, 0)
    const inPlane = pole.clone().sub(side.multiplyScalar(pole.x))
    if (inPlane.lengthSq() > 1e-10) pole.copy(inPlane.sub(u.clone().multiplyScalar(inPlane.dot(u))))
  }
  // 曲げる向きの好みの側にそろえる（目標がほぼ一直線の上なら、好みの向きそのものにする）
  if (prefer) {
    const pref = prefer.clone().sub(u.clone().multiplyScalar(prefer.dot(u)))
    if (pref.lengthSq() > 1e-10) {
      pref.normalize()
      if (pole.length() < 0.15 * l1) pole.copy(pref)
      else if (pole.dot(pref) < 0) pole.negate()
    }
  }
  if (pole.lengthSq() < 1e-12) pole.copy(new THREE.Vector3(0, 0, 1).sub(u.clone().multiplyScalar(u.z)))
  pole.normalize()
  const knee = a.clone().add(u.clone().multiplyScalar(x)).add(pole.multiplyScalar(h))
  rotateWorld(upper, swing(b.clone().sub(a), knee.clone().sub(a)))
  const b1 = lower.getWorldPosition(new THREE.Vector3())
  const tip = lower.children.find((o) => (o as THREE.Bone).isBone)
  const c1 = tip ? tip.getWorldPosition(new THREE.Vector3()) : c
  rotateWorld(lower, swing(c1.clone().sub(b1), a.clone().add(u.multiplyScalar(dist)).sub(b1)))
}

/** 部位ごとの色の重み（各頂点の骨の重みから求める。関節は隣り合う 2 本の骨の重みの重なり） */
const AREA_WEIGHT: Partial<Record<BodyArea, (w: (bone: string) => number) => number>> = {
  neck: (w) => w('neck_01'),
  shoulders: (w) => w('clavicle_l') + w('clavicle_r') + 4 * w('upperarm_l') * w('clavicle_l') + 4 * w('upperarm_r') * w('clavicle_r'),
  upper_back: (w) => w('spine_03') + w('spine_02'),
  lower_back: (w) => w('spine_01'),
  hips: (w) => w('pelvis') + 4 * w('pelvis') * (w('thigh_l') + w('thigh_r')),
  knees: (w) => 4 * (w('thigh_l') * w('calf_l') + w('thigh_r') * w('calf_r')),
  feet: (w) => w('foot_l') + w('foot_r') + w('ball_l') + w('ball_r'),
}

/** 色づけの最大の濃さ（体の陰影が見えるように、部位の色で塗りつぶさない） */
const ACCENT_MAX = 0.75

/**
 * 頂点ごとの色づけの重み weight(骨の重み, 前向きの度合い, 後ろ向きの度合い) で、体の色を塗る。
 * 前向き・後ろ向きは、最初の姿勢の頂点の法線の前後（+Z が体の前）から求める（太ももの前と裏などを分けるため）
 */
function paintBy(root: THREE.Object3D, base: string, accent: string, weight: ((w: (bone: string) => number, front: number, back: number) => number) | null) {
  const c0 = new THREE.Color(base)
  const c1 = new THREE.Color(accent)
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    const g = mesh.geometry
    const idx = g.getAttribute('skinIndex')
    const wt = g.getAttribute('skinWeight')
    const nrm = g.getAttribute('normal')
    const n = g.getAttribute('position').count
    const names = mesh.skeleton.bones.map((b) => b.name)
    let color = g.getAttribute('color') as THREE.BufferAttribute | undefined
    if (!color || color.count !== n) {
      color = new THREE.BufferAttribute(new Float32Array(n * 3), 3)
      g.setAttribute('color', color)
    }
    const weights = new Map<string, number>()
    const w = (bone: string) => weights.get(bone) ?? 0
    const c = new THREE.Color()
    const ramp = (v: number) => Math.min(1, Math.max(0, (v - 0.05) / 0.35))
    for (let i = 0; i < n; i++) {
      let h = 0
      if (weight) {
        weights.clear()
        for (let k = 0; k < 4; k++) {
          const wk = wt.getComponent(i, k)
          if (wk > 0) weights.set(names[idx.getComponent(i, k)], (weights.get(names[idx.getComponent(i, k)]) ?? 0) + wk)
        }
        const nz = nrm ? nrm.getZ(i) : 0
        h = weight(w, ramp(nz), ramp(-nz))
      }
      c.copy(c0).lerp(c1, ACCENT_MAX * Math.min(1, h))
      color.setXYZ(i, c.r, c.g, c.b)
    }
    color.needsUpdate = true
  })
}

/** 体の色を頂点ごとに付ける（highlight の部位をなめらかに色づける） */
export function paintMannequin(root: THREE.Object3D, base: string, accent: string, highlight: Set<BodyArea>) {
  const fns = [...highlight].map((a) => AREA_WEIGHT[a]).filter((f): f is NonNullable<typeof f> => !!f)
  paintBy(root, base, accent, fns.length ? (w) => Math.max(0, ...fns.map((f) => f(w))) : null)
}

/** 筋肉のある場所（色づけの重み）。骨の重みと、体の前・後ろ側で分ける。教育用の大まかな場所で、筋肉の形そのものではない */
export const MUSCLE_WEIGHT: Record<MuscleKey, (w: (bone: string) => number, front: number, back: number) => number> = {
  quads: (w, f) => (w('thigh_l') + w('thigh_r')) * f,
  hamstrings: (w, _f, b) => (w('thigh_l') + w('thigh_r')) * b * (1 - Math.min(1, 3 * w('pelvis'))),
  glutes: (w, _f, b) => (w('pelvis') + 3 * w('pelvis') * (w('thigh_l') + w('thigh_r'))) * b,
  calves: (w, _f, b) => (w('calf_l') + w('calf_r')) * b,
  erectors: (w, _f, b) => (w('spine_01') + w('spine_02')) * b,
  lats: (w, _f, b) => (w('spine_02') + w('spine_03')) * b + (w('clavicle_l') + w('clavicle_r')) * b * 0.5,
  biceps: (w, f) => (w('upperarm_l') + w('upperarm_r')) * f,
}

/**
 * 筋肉ごとの濃さ（0〜1）で色づける関数を返す。頂点ごとの筋肉の重みは最初に一度だけ求め、
 * 呼ぶたびに色だけを塗り直す（再生中に、推定の要求度に合わせて濃さを変えるため）
 */
export function muscleShader(root: THREE.Object3D, base: string, accent: string) {
  const c0 = new THREE.Color(base)
  const c1 = new THREE.Color(accent)
  const keys = Object.keys(MUSCLE_WEIGHT) as MuscleKey[]
  const ramp = (v: number) => Math.min(1, Math.max(0, (v - 0.05) / 0.35))
  const meshes: { color: THREE.BufferAttribute; w: Float32Array[]; n: number }[] = []
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    const g = mesh.geometry
    const idx = g.getAttribute('skinIndex')
    const wt = g.getAttribute('skinWeight')
    const nrm = g.getAttribute('normal')
    const n = g.getAttribute('position').count
    const names = mesh.skeleton.bones.map((b) => b.name)
    let color = g.getAttribute('color') as THREE.BufferAttribute | undefined
    if (!color || color.count !== n) {
      color = new THREE.BufferAttribute(new Float32Array(n * 3), 3)
      g.setAttribute('color', color)
    }
    const w = keys.map(() => new Float32Array(n))
    const bw = new Map<string, number>()
    const get = (bone: string) => bw.get(bone) ?? 0
    for (let i = 0; i < n; i++) {
      bw.clear()
      for (let k = 0; k < 4; k++) {
        const wk = wt.getComponent(i, k)
        if (wk > 0) bw.set(names[idx.getComponent(i, k)], (bw.get(names[idx.getComponent(i, k)]) ?? 0) + wk)
      }
      const nz = nrm ? nrm.getZ(i) : 0
      keys.forEach((key, j) => (w[j][i] = Math.min(1, MUSCLE_WEIGHT[key](get, ramp(nz), ramp(-nz)))))
    }
    meshes.push({ color, w, n })
  })
  const c = new THREE.Color()
  return (levels: Partial<Record<MuscleKey, number>>) => {
    const lv = keys.map((k) => levels[k] ?? 0)
    for (const m of meshes) {
      for (let i = 0; i < m.n; i++) {
        let h = 0
        for (let j = 0; j < lv.length; j++) if (lv[j] > 0) h = Math.max(h, m.w[j][i] * lv[j])
        c.copy(c0).lerp(c1, ACCENT_MAX * Math.min(1, h))
        m.color.setXYZ(i, c.r, c.g, c.b)
      }
      m.color.needsUpdate = true
    }
  }
}

/** 選んだ筋肉のある場所を色づける（なしなら色を戻す） */
export function paintMuscles(root: THREE.Object3D, base: string, accent: string, keys: MuscleKey[]) {
  const fns = keys.map((k) => MUSCLE_WEIGHT[k])
  paintBy(root, base, accent, fns.length ? (w, f, b) => Math.max(0, ...fns.map((fn) => fn(w, f, b))) : null)
}
