// 3D 表示で共通に使う部品（マネキンの読み込み・読み込めなかったときの切り替え・照明）
import { Component, type ReactNode } from 'react'
import { Environment, Lightformer, useProgress } from '@react-three/drei'
import type { MannequinKind } from './mannequin'

export const mannequinUrl = (k: MannequinKind) => `${import.meta.env.BASE_URL}models/mannequin-v1-${k}.glb`

/** マネキンの色（明るいグレー） */
export const BODY_COLOR = '#c9d2d4'

/** 体のモデルを読み込めなかったとき（初回にオフラインなど）、中身を出さずに onError を呼ぶ */
export class LoadBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.onError()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

export function LoadingNote() {
  const { active } = useProgress()
  if (!active) return null
  return <p className="pointer-events-none absolute inset-x-0 top-3 text-center text-sm text-ink-3">体のモデルを読み込んでいます…</p>
}

export function hasWebGL() {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

/** 人体を見せるときの照明（外から画像を読み込まない） */
export function BodyLights() {
  return (
    <>
      <ambientLight intensity={0.3} />
      <directionalLight position={[2, 3, 2]} intensity={1.5} />
      <directionalLight position={[-2, 1.5, -1.5]} intensity={0.55} />
      <Environment resolution={128}>
        <Lightformer form="rect" intensity={1.6} position={[2.5, 3, 3]} scale={[4, 3, 1]} />
        <Lightformer form="rect" intensity={0.7} position={[-3, 1.5, -2]} scale={[3, 2, 1]} />
        <Lightformer form="rect" intensity={0.9} position={[0, 4, 0]} rotation-x={Math.PI / 2} scale={[3, 3, 1]} />
      </Environment>
    </>
  )
}
