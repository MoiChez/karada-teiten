// 動きの記録の書き出し（CSV: コマごと / 1 回ごと、JSON: 記録そのもの）。端末の中で作り、どこにも送らない
import { landmarkName, sidePoints } from './landmarks'
import {
  MOTION_ALGORITHM_VERSION,
  PROFILES,
  motionMetric,
  packLandmarks,
  prepareRecord,
  segmentsOf,
  type MotionCycle,
  type MotionMetric,
  type MotionRecord,
  type PreparedMotion,
} from './motion'
import { metricDoc } from './motionSports'
import type { ConstraintNote } from './motionConstraints'
import type { CameraView } from './motionFrontal'

type Cell = string | number | null | undefined

const csvCell = (v: Cell) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
// Excel で文字化けしないよう BOM を付ける
const toCsv = (rows: Cell[][]) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
const round = (v: number, d: number): number | '' => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : '')
const isoDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toISOString()
}

const SIDE_LABEL = { left: '左', right: '右' } as const
const VIEW_LABEL: Record<CameraView, string> = { side: '横', front: '正面', rear: '後ろ', oblique: '斜め' }
const CONSTRAINT_LABEL: Record<ConstraintNote['key'], string> = {
  footplate: '足首をフットプレートの上で動かないものとして置く',
  rail: '腰をレールに沿ってまっすぐ動くものとして置く',
  knee: '膝を太ももとすねの長さから置き直す',
}

/** 計算に使った点の番号。横から: カメラ側の耳・肩・ひじ・手首・股関節・膝・足首・かかと・足先。正面・後ろから: 左右の肩・股関節・膝・足首 */
function usedPoints(prep: PreparedMotion): number[] {
  if (PROFILES[prep.kind].frontal) return [11, 12, 23, 24, 25, 26, 27, 28]
  const s = sidePoints(prep.nearSide)
  return [s.ear, s.shoulder, s.wrist - 2, s.wrist, s.hip, s.knee, s.ankle, s.heel, s.foot]
}

/** コマごとの CSV の先頭に置く、計算の条件（# で始まる行。記録に持っている値だけ） */
function framesMeta(rec: MotionRecord, prep: PreparedMotion): Cell[][] {
  const profile = PROFILES[prep.kind]
  const rows: Cell[][] = []
  const add = (k: string, v: Cell) => {
    if (v !== null && v !== undefined && v !== '') rows.push([`# ${k}`, v])
  }
  add('アプリの版', rec.appVersion)
  add('計算の版', MOTION_ALGORITHM_VERSION)
  add('推定モデルの版', rec.modelVersion)
  add('種目', profile.label)
  add('撮った日時（ISO 8601）', isoDate(rec.createdAt))
  add('コマ数/秒', round(rec.video.fps, 2))
  add('画像の幅・高さ（ピクセル）', `${rec.video.width} × ${rec.video.height}`)
  if (prep.view) add('撮った向き', VIEW_LABEL[prep.view.view])
  if (!profile.frontal) {
    add('カメラ側の半身', SIDE_LABEL[prep.nearSide])
    add('顔の向き', prep.f === 1 ? '画面の右' : '画面の左')
  }
  add('映像を時計回りに 90° 回した回数', rec.video.quarterTurns)
  if (rec.video.rollDeg !== undefined) add('傾きの補正（°。画像の中心のまわりに、時計回りにこの角度だけ回して戻した）', round(rec.video.rollDeg, 2))
  add('なめらか化の σ（コマ。ガウスの重みで前後 2σ まで、区間の中だけ）', profile.smoothing)
  if (prep.constraints.length) add('使った器具の前提', prep.constraints.map((c) => `${CONSTRAINT_LABEL[c.key]}: ${c.applied ? '使った' : '使わなかった'}`).join(' / '))
  if (profile.load) {
    const b = prep.body
    const as = (assumed: boolean) => (assumed ? '（仮定）' : '')
    add('重心と負担に使った身長・体重・持つ重さ', `${b.heightCm} cm${as(b.assumed.height)}・${b.weightKg} kg${as(b.assumed.weight)}・${b.loadKg} kg${as(b.assumed.load)}`)
  }
  add('点の座標', '傾きを戻した後のピクセル（画像の左上が原点、x は右、y は下が +）。なめらか化・手で直した点・器具の前提を当てた後の、計算に使った位置')
  add('区間', '250 ミリ秒より長く体を検出できなかったところで区間を分け、なめらか化と区切りは区間をまたがない')
  add(
    '角度の符号の決まり',
    prep.angles3d
      ? '真横ではない向きから撮ったため、膝・股関節・上体・すね・太もも・深さは、向きによらない 3D の推定から求めた。前は体の正面の向き。それぞれの列の決まりは次の行'
      : '横から見た見かけの角度。前は顔の向き。それぞれの列の決まりは次の行',
  )
  for (const d of profile.series) add(`${d.label}（${d.unit}）`, metricDoc(d, prep.angles3d))
  return rows
}

/** コマごとの値（なめらかにした点から求めた値）。回の番号と、そのコマで起きた出来事（底・キャッチなど）を付ける */
export function motionFramesCsv(rec: MotionRecord, prep: PreparedMotion, cycles: MotionCycle[]): string {
  const profile = PROFILES[rec.kind]
  const extra: [string, (i: number) => number][] = []
  for (const d of profile.series) if (d.band) extra.push([`${d.label}の幅の下限（${d.unit}）`, (i) => prep.series[d.band![0]][i]], [`${d.label}の幅の上限（${d.unit}）`, (i) => prep.series[d.band![1]][i]])
  if (prep.crank) extra.push(['クランクの角度（°、上死点 0）', (i) => prep.crank!.angle[i]])
  if (prep.bar) extra.push(['バーの前後（m、足の真ん中から前が +）', (i) => prep.bar!.x[i]], ['バーの高さ（m）', (i) => prep.bar!.y[i]], ['バーの上下の速さ（m/秒）', (i) => prep.bar!.v[i]])
  const points = usedPoints(prep)
  const header = [
    '時刻（ミリ秒）',
    ...profile.series.map((d) => `${d.label}（${d.unit}）`),
    ...extra.map(([h]) => h),
    `何${profile.unitLabel}目`,
    '出来事',
    '手で直した点',
    // あとから足した列（前の列の順は変えず、後ろに足す）
    '区間の番号',
    '器具の前提で置き直した点',
    ...points.flatMap((i) => [`${landmarkName(i)}の x（ピクセル）`, `${landmarkName(i)}の y（ピクセル）`]),
  ]
  const seg = segmentsOf(prep.frames.length, prep.breaks)
  const rows: Cell[][] = [...framesMeta(rec, prep), header]
  prep.frames.forEach((fr, i) => {
    const k = cycles.findIndex((c) => i >= c.startIndex && i <= c.endIndex)
    const ev = cycles.flatMap((c) => c.events.filter((e) => e.index === i).map((e) => e.label)).join(' / ')
    rows.push([
      fr.t,
      ...profile.series.map((d) => round(prep.series[d.key][i], 2)),
      ...extra.map(([, f]) => round(f(i), 3)),
      k >= 0 ? k + 1 : '',
      ev,
      fr.edited.join(' '),
      seg[i] + 1,
      fr.constrained.join(' '),
      ...points.flatMap((p) => [round(fr.px[p].x, 1), round(fr.px[p].y, 1)]),
    ])
  })
  return toCsv(rows)
}

/** 1 回ごとの値。最後に、すべての回の平均・標準偏差・比べるときの幅の行を付ける */
export function motionCyclesCsv(rec: MotionRecord): string {
  const profile = PROFILES[rec.kind]
  const header = [`何${profile.unitLabel}目`, '始め（ミリ秒）', '終わり（ミリ秒）', ...profile.metrics.map((m) => `${m.label}（${m.unit}）`)]
  const rows: Cell[][] = [header]
  rec.analysis.cycles.forEach((c, k) => {
    rows.push([k + 1, c.start, c.end, ...profile.metrics.map((m) => (c.values[m.key] === null || c.values[m.key] === undefined ? '' : round(c.values[m.key]!, 3)))])
  })
  if (rec.analysis.cycles.length) {
    const summary: [string, (m: MotionMetric) => number | null][] = [
      ['平均', (m) => m.value],
      ['標準偏差', (m) => m.sd],
      ['比べるときの幅（標準偏差 ÷ √回数。目安の下限込み）', (m) => m.uncertainty],
    ]
    for (const [label, pick] of summary) {
      rows.push([
        label,
        '',
        '',
        ...profile.metrics.map((d) => {
          const m = motionMetric(rec.analysis, d.key)
          const v = m ? pick(m) : null
          return v === null ? '' : round(v, 3)
        }),
      ])
    }
  }
  return toCsv(rows)
}

/** 処理した後の点（なめらか化・手で直した点・器具の前提を当てた後。計算に使ったコマだけ） */
function processedOf(prep: PreparedMotion) {
  const seg = segmentsOf(prep.frames.length, prep.breaks)
  return {
    kind: prep.kind,
    nearSide: prep.nearSide,
    facing: prep.f === 1 ? 'right' : 'left',
    smoothingSigma: PROFILES[prep.kind].smoothing,
    constraints: prep.constraints,
    frames: prep.frames.map((fr, i) => ({
      t: fr.t,
      segment: seg[i] + 1,
      p: packLandmarks(fr.lm),
      px: fr.px.flatMap((q) => [round(q.x, 1), round(q.y, 1)]),
      ...(fr.edited.length ? { edited: fr.edited } : {}),
      ...(fr.constrained.length ? { constrained: fr.constrained } : {}),
    })),
  }
}

/** 記録そのもの（推定した点・手で直した点・計算の結果）と、処理した後の点。動画は含めない */
export function motionJson(rec: MotionRecord): string {
  const built = rec.frames.length ? prepareRecord(rec) : null
  return JSON.stringify(
    {
      app: 'karada-teiten',
      type: 'motion',
      schemaVersion: 1,
      algorithmVersion: MOTION_ALGORITHM_VERSION,
      coordinates:
        'frames[].p: 33 点 × [x, y, 見えている度合い]（画像の幅・高さに対する比、左上が原点）。frames[].w: 33 点 × [x, y, z]（推定モデルの 3D、メートル、腰の中心が原点、y は下向き。校正した実測ではない）。点の番号は MediaPipe Pose Landmarker と同じ。' +
        'processed.frames[]: 計算に使ったコマだけの、処理した後の点。p は frames[].p と同じ決まりで、なめらか化・手で直した点（edited）・器具の前提で置き直した点（constrained）を当てた後の位置。px は p を傾きの補正（video.rollDeg）で戻したピクセル座標 33 点 × [x, y]で、角度などの計算に使った位置。segment は区間の番号（途切れのあとで 1 つ増える）',
      record: { ...rec, videoSaved: false },
      processed: built ? processedOf(built.prep) : null,
    },
    null,
    1,
  )
}
