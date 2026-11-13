// 立ち姿勢の人体（標準の体を、正面と横向きの写真から合成した関節の向きに合わせて曲げたもの）。3D ビューと結果の画面で使う
import { useMemo } from 'react'
import { useLoader } from '@react-three/fiber'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { Pose3D } from '../domain/fusion3d'
import type { BodyArea } from '../domain/types'
import { paintMannequin, poseMannequin, type MannequinKind } from './mannequin'
import { BODY_COLOR, mannequinUrl } from './common'

/** 関連が考えられる部位の色 */
export const HIGHLIGHT_COLOR = '#e3a13b'
/** 前回の姿勢の色 */
export const PAST_COLOR = '#7c8d93'

export function BodyModel({ kind, pose, highlight, tone }: { kind: MannequinKind; pose: Pose3D; highlight: Set<BodyArea>; tone: 'current' | 'past' }) {
  const gltf = useLoader(GLTFLoader, mannequinUrl(kind))
  const root = useMemo(() => {
    const r = cloneSkinned(gltf.scene)
    r.traverse((o) => {
      const m = o as THREE.SkinnedMesh
      if (!m.isSkinnedMesh) return
      // 曲げた後の形が元の範囲からはみ出しても消えないように
      m.frustumCulled = false
      m.geometry = m.geometry.clone()
      m.material =
        tone === 'current'
          ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 })
          : new THREE.MeshStandardMaterial({ color: PAST_COLOR, roughness: 0.8, transparent: true, opacity: 0.28, depthWrite: false })
    })
    return r
  }, [gltf, tone])
  useMemo(() => poseMannequin(root, pose), [root, pose])
  useMemo(() => {
    if (tone === 'current') paintMannequin(root, BODY_COLOR, HIGHLIGHT_COLOR, highlight)
  }, [root, highlight, tone])
  return <primitive object={root} />
}
