// 幾何計算（純粋関数）。座標はピクセル（x 右、y 下）
import type { Landmark, Point } from './types'

export const RAD2DEG = 180 / Math.PI

export function toPx(lm: Landmark, width: number, height: number): Point {
  return { x: lm.x * width, y: lm.y * height }
}

export function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 左右 2 点を結ぶ線の水平からの傾き（度）。a が b より下（y が大きい）なら + */
export function tiltDeg(a: Point, b: Point): number {
  return Math.atan2(a.y - b.y, Math.abs(a.x - b.x)) * RAD2DEG
}

/**
 * from から to へのベクトルの鉛直（上向き）からの角度（度）。
 * forwardSign = +1 なら画像の右へ倒れると +
 */
export function angleFromVerticalDeg(from: Point, to: Point, forwardSign: number): number {
  const v = sub(to, from)
  return Math.atan2(v.x * forwardSign, -v.y) * RAD2DEG
}

/** 3 点 a-b-c の b での内角（度、0..180） */
export function interiorAngleDeg(a: Point, b: Point, c: Point): number {
  const v1 = sub(a, b)
  const v2 = sub(c, b)
  const n1 = Math.hypot(v1.x, v1.y)
  const n2 = Math.hypot(v2.x, v2.y)
  if (n1 === 0 || n2 === 0) return NaN
  const cos = (v1.x * v2.x + v1.y * v2.y) / (n1 * n2)
  return Math.acos(Math.max(-1, Math.min(1, cos))) * RAD2DEG
}

/**
 * 点 p から直線 a→b への垂線ベクトル（p − 直線上の最近点）。
 * 符号の判断は呼び出し側で x 成分などを使う
 */
export function perpendicular(p: Point, a: Point, b: Point): Point {
  const d = sub(b, a)
  const len2 = d.x * d.x + d.y * d.y
  if (len2 === 0) return sub(p, a)
  const t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / len2
  const proj = { x: a.x + d.x * t, y: a.y + d.y * t }
  return sub(p, proj)
}

export function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0
}

export function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length
}

export function std(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1))
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** 決定的な乱数（mulberry32） */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 標準正規乱数（Box-Muller） */
export function gaussian(rand: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rand()
  while (v === 0) v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
