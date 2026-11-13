// マネキン（MPFB の標準の人体、tools/blender/make_mannequins.py で作ったもの）を、
// 正面と横向きの写真から合成した関節の位置（fusion3d）の「向き」に合わせて曲げる。
// 骨の長さと体の形は標準のまま（体型は推定しない）。docs/07 の 3 章
import * as THREE from 'three'
import type { Pose3D, Vec3 } from '../domain/fusion3d'
import type { BodyArea, UserProfile } from '../domain/types'
import type { MuscleKey } from '../domain/motionSports'

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

/** 各マネキンの最初の姿勢（骨ごとの回転） */
const REST = new WeakMap<THREE.Object3D, Map<string, THREE.Quaternion>>()
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
 * anchor = 'hips'（座って行う種目）: 両股関節の中点を pose に重ね、脚と腕は骨の長さを保ったまま、
 * 足首・手首が pose の位置に届くように曲げる（膝・ひじは pose の膝・ひじの側へ曲げる）。腰が浮き沈みしないように
 */
export function poseMannequin(root: THREE.Object3D, pose: Pose3D, opts: { anchor?: 'ankles' | 'hips'; planarLegs?: boolean } = {}): PoseFit {
  const bones = new Map<string, THREE.Object3D>()
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone || o.name.startsWith('lm_')) bones.set(o.name, o)
  })
  // 最初の姿勢を覚えておき、毎回そこから曲げる
  let rest = REST.get(root)
  if (!rest) REST.set(root, (rest = new Map()))
  for (const [name, b] of bones) {
    if (!rest.has(name)) rest.set(name, b.quaternion.clone())
    b.quaternion.copy(rest.get(name)!)
  }
  // 胴の長さの合わせ（動きの再生で使う）を戻す
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

  // 胴: 股関節の中点→肩の中点の向きと、肩の線。背骨の 3 本に分けて少しずつ曲げる
  if (has(11, 12, 23, 24)) {
    const tUp = mid(T(11)!, T(12)!).sub(mid(T(23)!, T(24)!))
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
    fitted.push('trunk')
  }

  // 首と頭: 肩の中点→耳の中点の向き、耳の線と鼻の向き（首と頭の付け根がずれているので数回くり返す）
  if (has(7, 8, 11, 12)) {
    let tNeck = mid(T(7)!, T(8)!).sub(mid(T(11)!, T(12)!))
    // 動きの再生では、首を胴に対して 30° より大きく曲げない。ハンドルを引き切ると肩甲骨が寄って、推定の肩の点が
    // 背骨より後ろへずれ、首が大きく前へ折れて見える（頭が胸に落ちる）ため
    if (opts.anchor === 'hips' && has(23, 24)) tNeck = limitAngle(tNeck, mid(T(11)!, T(12)!).sub(mid(T(23)!, T(24)!)), NECK_LIMIT_DEG)
    for (let k = 0; k < 3; k++) {
      rotateWorld(B('neck_01'), swing(mid(P(7), P(8)).sub(mid(P(11), P(12))), tNeck))
      if (has(0)) {
        const tEar = T(7)!.sub(T(8)!)
        const tFwd = T(0)!.sub(mid(T(7)!, T(8)!))
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
    // 胴の長さを合わせる（股関節の中点〜肩の中点を、測った長さにする。標準の体と人の胴の長さの違いで、
    // 肩や頭が動画からずれないように）。背骨の付け根から上をまとめて大きさを変えるので、腕と頭も同じ割合で変わる
    if (has(11, 12)) {
      const cur = mid(P(11), P(12)).distanceTo(mid(P(23), P(24)))
      const want = mid(T(11)!, T(12)!).distanceTo(mid(T(23)!, T(24)!))
      if (cur > 1e-6) {
        B('spine_01').scale.setScalar(Math.min(1.35, Math.max(0.8, want / cur)))
        root.updateMatrixWorld(true)
      }
    }
    // 手首が胴の高さ（股関節〜肩の 85% まで）にあって、胸の前の面より後ろにあるときは、水平に前へ出して胸の前の面に置く。
    // フィニッシュでハンドルを胸に引くと、推定の手首が胴の線（股関節の中点〜肩の中点）の上に来て、手を脇腹に
    // 当てたように見えるため（利用者のエルゴの動画では、ハンドルは胸の前にあり、斜め前寄りから撮った画面の上で、
    // カメラ側の手首が胴の線に重なっていた）。胴の線は、合わせた後の 3D の体で、手首と同じ高さで測る。
    // 肩の高さの手（背中にかつぐバー）は動かさない。範囲の端では出す量を徐々に減らす（手が跳ばないように）
    const hipMid = mid(P(23), P(24))
    const shMid = has(11, 12) ? mid(P(11), P(12)) : null
    const handInFront = (w: THREE.Vector3) => {
      if (!shMid || shMid.y - hipMid.y < 0.5 * shMid.distanceTo(hipMid)) return w
      const u = (w.y - hipMid.y) / (shMid.y - hipMid.y)
      const k = Math.min(1, Math.max(0, (u + 0.1) / 0.1), Math.max(0, (0.85 - u) / 0.1))
      const d = w.z - (hipMid.z + (shMid.z - hipMid.z) * u)
      return d >= HAND_FRONT || k <= 0 ? w : w.clone().setZ(w.z + (HAND_FRONT - d) * k)
    }
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
      reach(B(upper), B(lower), P(a), P(b), P(c), T(b)!, c === 15 || c === 16 ? handInFront(T(c)!) : T(c)!, planar, prefer)
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

  // 大きさと位置: 体の高さを 1 にし、両足首の中点を合わせる
  const scale = 1 / Hm
  const ankle = mid(P(27), P(28))
  const target = has(27, 28) ? mid(T(27)!, T(28)!) : new THREE.Vector3()
  root.scale.setScalar(scale)
  root.position.copy(target.sub(ankle.multiplyScalar(scale)))
  root.updateMatrixWorld(true)
  return { scale, fitted }
}

/** 動きの再生で、首を胴に対して曲げる最大の角度（度） */
const NECK_LIMIT_DEG = 30
/** 胴の高さにある手首を、胴の線から水平に前へ出す最小の距離（体の高さを 1 として）。
 *  標準の体の胸の前の面は、胴の線から 0.08 ほど前（胴が 25° 傾くと水平に 0.09 ほど） */
const HAND_FRONT = 0.09

/** v の向きを、base の向きから max 度以内にする（base との角度が大きいときだけ、二つを含む面の中で回す） */
function limitAngle(v: THREE.Vector3, base: THREE.Vector3, maxDeg: number) {
  const a = v.angleTo(base)
  const max = (maxDeg * Math.PI) / 180
  if (a <= max || base.lengthSq() < 1e-12) return v
  const axis = new THREE.Vector3().crossVectors(base, v)
  if (axis.lengthSq() < 1e-12) return v
  axis.normalize()
  const len = v.length()
  return base.clone().normalize().applyAxisAngle(axis, max).multiplyScalar(len)
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
