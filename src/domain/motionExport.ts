// 動きの記録の書き出し（CSV: コマごと / 1 回ごと、JSON: 記録そのもの）。端末の中で作り、どこにも送らない
import { MOTION_ALGORITHM_VERSION, PROFILES, type MotionCycle, type MotionRecord, type PreparedMotion } from './motion'

const csvCell = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
// Excel で文字化けしないよう BOM を付ける
const toCsv = (rows: (string | number | null | undefined)[][]) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d

/** コマごとの値（なめらかにした点から求めた値）。回の番号と、そのコマで起きた出来事（底・キャッチなど）を付ける */
export function motionFramesCsv(rec: MotionRecord, prep: PreparedMotion, cycles: MotionCycle[]): string {
  const profile = PROFILES[rec.kind]
  const header = ['時刻（ミリ秒）', ...profile.series.map((d) => `${d.label}（${d.unit}）`), `何${profile.unitLabel}目`, '出来事', '手で直した点']
  const rows: (string | number | null)[][] = [header]
  prep.frames.forEach((fr, i) => {
    const k = cycles.findIndex((c) => i >= c.startIndex && i <= c.endIndex)
    const ev = cycles.flatMap((c) => c.events.filter((e) => e.index === i).map((e) => e.label)).join(' / ')
    rows.push([fr.t, ...profile.series.map((d) => round(prep.series[d.key][i], 2)), k >= 0 ? k + 1 : '', ev, fr.edited.join(' ')])
  })
  return toCsv(rows)
}

/** 1 回ごとの値 */
export function motionCyclesCsv(rec: MotionRecord): string {
  const profile = PROFILES[rec.kind]
  const header = [`何${profile.unitLabel}目`, '始め（ミリ秒）', '終わり（ミリ秒）', ...profile.metrics.map((m) => `${m.label}（${m.unit}）`)]
  const rows: (string | number | null)[][] = [header]
  rec.analysis.cycles.forEach((c, k) => {
    rows.push([k + 1, c.start, c.end, ...profile.metrics.map((m) => (c.values[m.key] === null || c.values[m.key] === undefined ? '' : round(c.values[m.key]!, 3)))])
  })
  return toCsv(rows)
}

/** 記録そのもの（推定した点・手で直した点・計算の結果）。動画は含めない */
export function motionJson(rec: MotionRecord): string {
  return JSON.stringify(
    {
      app: 'karada-teiten',
      type: 'motion',
      schemaVersion: 1,
      algorithmVersion: MOTION_ALGORITHM_VERSION,
      coordinates:
        'frames[].p: 33 点 × [x, y, 見えている度合い]（画像の幅・高さに対する比、左上が原点）。frames[].w: 33 点 × [x, y, z]（推定モデルの 3D、メートル、腰の中心が原点、y は下向き。校正した実測ではない）。点の番号は MediaPipe Pose Landmarker と同じ',
      record: { ...rec, videoSaved: false },
    },
    null,
    1,
  )
}

