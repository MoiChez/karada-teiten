// 端末の傾き（DeviceOrientation の beta, gamma）から、画面の面内での傾きと、画面の起き具合を求める。
// gamma は端末を立てると（beta が 90° 付近）値が大きく振れるので、そのままでは左右の傾きに使えない
import type { DeviceTilt } from './types'
import { RAD2DEG } from './geometry'

/** 端末の座標（右が +x、上が +y、画面の手前が +z）で見た、鉛直上向きのベクトル */
export function upVector(betaDeg: number, gammaDeg: number) {
  const b = betaDeg / RAD2DEG
  const g = gammaDeg / RAD2DEG
  return { x: -Math.cos(b) * Math.sin(g), y: Math.sin(b), z: Math.cos(b) * Math.cos(g) }
}

/**
 * rollDeg: 画面の面内での傾き。縦に持って水平なら 0、右側が下がると +。横向きに持つと ±90 付近
 * pitchDeg: 画面の起き具合。垂直に立てると 90、画面を上にして寝かせると 0
 */
export function tiltFromOrientation(betaDeg: number, gammaDeg: number): DeviceTilt {
  const u = upVector(betaDeg, gammaDeg)
  return {
    rollDeg: Math.atan2(-u.x, u.y) * RAD2DEG,
    pitchDeg: Math.acos(Math.max(-1, Math.min(1, u.z))) * RAD2DEG,
  }
}

/** -180..180 にそろえる */
export function wrapDeg(d: number) {
  return ((((d + 180) % 360) + 360) % 360) - 180
}

/**
 * 画面（＝カメラの映像）から見た傾き。screenAngle は screen.orientation.angle
 * （端末を反時計回りに 90° 回して横にした画面なら 90）。映像は画面の向きに合わせて回して届く
 */
export function screenRollDeg(deviceRollDeg: number, screenAngle: number) {
  return wrapDeg(deviceRollDeg + screenAngle)
}

/** 映像を時計回りに何回 90° 回せば、上が上になるか（-1, 0, 1, 2）と、残りの小さな傾き */
export function quarterTurnsOf(rollDeg: number) {
  const k = Math.round(rollDeg / 90)
  const turns = (((k % 4) + 5) % 4) - 1
  return { turns, residualDeg: wrapDeg(rollDeg - 90 * k) }
}
