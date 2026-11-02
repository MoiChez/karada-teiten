// 指標から「姿勢特徴」を作る。文章は観測された事実だけを書く
import type { BodyArea, ComputedMetric, MetricKey, Plane, PostureTrait, TraitKey } from './types'
import { NOTICEABLE_K } from './constants'
import { fmtAbs, fmtNum } from './format'

interface TraitDef {
  key: TraitKey
  label: string
  plane: Plane
  evidence: MetricKey[]
  /** 特徴の向き。+1 なら値が + のときだけ「差が見られる」。0 は向きを問わない */
  direction: 1 | -1 | 0
  areas: BodyArea[]
  caution: string
  summary: (m: Map<MetricKey, ComputedMetric>) => string
}

const side = (v: number, pos: string, neg: string) => (v >= 0 ? pos : neg)

const TRAIT_DEFS: TraitDef[] = [
  {
    key: 'lateral_lean',
    label: '全身の左右への傾き',
    plane: 'front',
    evidence: ['front_body_lean'],
    direction: 0,
    areas: ['whole_body'],
    caution: 'カメラの傾きや、撮影時に片脚に体重をかけていた影響でも変わります。',
    summary: (m) => {
      const v = m.get('front_body_lean')!.rawValue!
      return `足首の中央から見て、肩の中央が${side(v, '左', '右')}へ約${fmtAbs(v, '°')}傾いています。`
    },
  },
  {
    key: 'shoulder_asymmetry',
    label: '肩の高さの左右差',
    plane: 'front',
    evidence: ['front_shoulder_tilt'],
    direction: 0,
    areas: ['shoulders', 'neck'],
    caution: '肩の点は服・髪・腕の位置で動きます。肩の骨そのものの高さではありません。',
    summary: (m) => {
      const x = m.get('front_shoulder_tilt')!
      return `${side(x.rawValue!, '左', '右')}肩が反対側より約${fmtAbs(x.rawValue!, '°')}（胴の長さの約${fmtAbs(x.normalizedValue ?? 0, '%')}）低い位置にあります。`
    },
  },
  {
    key: 'pelvis_asymmetry',
    label: '骨盤付近の左右差',
    plane: 'front',
    evidence: ['front_pelvis_tilt'],
    direction: 0,
    areas: ['hips', 'lower_back'],
    caution: '股関節の推定位置の差で、骨盤の骨の傾きを測ったものではありません。服装の影響を受けやすい項目です。',
    summary: (m) => {
      const v = m.get('front_pelvis_tilt')!.rawValue!
      return `股関節の推定位置は${side(v, '左', '右')}側が約${fmtAbs(v, '°')}低くなっています。`
    },
  },
  {
    key: 'head_tilt',
    label: '頭部の左右の傾き',
    plane: 'front',
    evidence: ['front_head_tilt'],
    direction: 0,
    areas: ['neck'],
    caution: '髪で耳が隠れていたり、顔が少し横を向いていたりすると値が変わります。',
    summary: (m) => {
      const v = m.get('front_head_tilt')!.rawValue!
      return `頭が${side(v, '左', '右')}へ約${fmtAbs(v, '°')}傾いています。`
    },
  },
  {
    key: 'trunk_shift',
    label: '体幹の左右偏位',
    plane: 'front',
    evidence: ['front_trunk_shift'],
    direction: 0,
    areas: ['upper_back', 'lower_back'],
    caution: '胸郭そのものの点はないため、肩と股関節の中央の差で代用した参考値です。',
    summary: (m) => {
      const v = m.get('front_trunk_shift')!.rawValue!
      return `胸のあたりが骨盤より${side(v, '左', '右')}へ、胴の長さの約${fmtAbs(v, '%')}ずれています。`
    },
  },
  {
    key: 'leg_alignment',
    label: '脚のアライメント（O 脚 / X 脚に関連する特徴）',
    plane: 'front',
    evidence: ['front_knee_left', 'front_knee_right'],
    direction: 0,
    areas: ['knees', 'hips', 'feet'],
    caution: '写真に写った脚の角度で、骨の角度ではありません。膝の向き・曲がり・ゆったりした服で大きく変わります。',
    summary: (m) => {
      const parts: string[] = []
      for (const [k, name] of [
        ['front_knee_left', '左膝'],
        ['front_knee_right', '右膝'],
      ] as const) {
        const x = m.get(k)
        if (!x || x.rawValue === null) continue
        if (Math.abs(x.rawValue) < 0.05) parts.push(`${name}はほぼ線上`)
        else parts.push(`${name}は${side(x.rawValue, '外側', '内側')}へ約${fmtAbs(x.rawValue, '°')}`)
      }
      return parts.length ? `股関節と足首を結ぶ線に対して、${parts.join('、')}の位置にあります。` : ''
    },
  },
  {
    key: 'load_shift',
    label: '左右荷重の傾向（参考）',
    plane: 'front',
    evidence: ['front_load_shift'],
    direction: 0,
    areas: ['feet', 'hips'],
    caution: '体重のかかり方を測ったものではありません。体の位置の偏りから方向を推測した参考値です。',
    summary: (m) => {
      const v = m.get('front_load_shift')!.rawValue!
      return `体の中心が両足の中央より${side(v, '左', '右')}足側へ、股関節の幅の約${fmtAbs(v, '%')}寄っています。`
    },
  },
  {
    key: 'forward_head',
    label: '頭部前方位傾向',
    plane: 'side',
    evidence: ['side_head_forward'],
    direction: 1,
    areas: ['neck', 'shoulders', 'upper_back'],
    caution: '耳と肩の点の位置関係から見た参考指標です。首の骨の形を評価したものではありません。',
    summary: (m) => {
      const x = m.get('side_head_forward')!
      const v = x.rawValue!
      return v >= 0
        ? `耳が肩の真上より前方にあります（耳と肩を結ぶ線の傾き 約${fmtAbs(v, '°')}、胴の長さの約${fmtAbs(x.normalizedValue ?? 0, '%')}）。`
        : `耳が肩の真上より後方にあります（約${fmtAbs(v, '°')}）。`
    },
  },
  {
    key: 'kyphosis_related',
    label: '猫背傾向に関連する特徴',
    plane: 'side',
    evidence: ['composite_kyphosis', 'side_head_forward', 'side_trunk_lean', 'side_arm_forward'],
    direction: 1,
    areas: ['upper_back', 'neck', 'shoulders'],
    caution: '背骨の丸みは写真の点からは見えません。頭・肩・腕の位置関係から計算した、自分の変化を見るためのスコアです。',
    summary: (m) => {
      const v = m.get('composite_kyphosis')!.rawValue!
      return `猫背傾向スコアは ${fmtNum(v, 2)} です（頭の前方位・体幹の前傾・腕の位置から計算）。`
    },
  },
  {
    key: 'rounded_shoulder_related',
    label: '巻き肩に関連する特徴',
    plane: 'side',
    evidence: ['side_arm_forward', 'side_head_forward'],
    direction: 1,
    areas: ['shoulders', 'upper_back'],
    caution: '腕の置き方で簡単に変わる参考特徴です。肩甲骨の位置は測れません。',
    summary: (m) => {
      const v = m.get('side_arm_forward')!.rawValue!
      return v >= 0
        ? `力を抜いた手首が股関節より前方（胴の長さの約${fmtAbs(v, '%')}）にあります。`
        : `手首は股関節より後方（胴の長さの約${fmtAbs(v, '%')}）にあります。`
    },
  },
  {
    key: 'trunk_sagittal',
    label: '体幹の前後傾',
    plane: 'side',
    evidence: ['side_trunk_lean'],
    direction: 0,
    areas: ['lower_back', 'upper_back'],
    caution: '肩と股関節を結ぶ線の傾きです。背骨の形は分かりません。',
    summary: (m) => {
      const v = m.get('side_trunk_lean')!.rawValue!
      return `上半身が股関節に対して${side(v, '前', '後ろ')}へ約${fmtAbs(v, '°')}傾いています。`
    },
  },
  {
    key: 'swayback_related',
    label: '反り腰に関連する特徴',
    plane: 'side',
    evidence: ['composite_swayback', 'side_hip_forward', 'side_knee_extension', 'side_trunk_lean'],
    direction: 1,
    areas: ['lower_back', 'hips', 'knees'],
    caution: '骨盤の傾きや腰の反りの角度は測れません。骨盤帯の位置・膝の伸び・体幹の傾きから計算した参考スコアです。',
    summary: (m) => {
      const v = m.get('composite_swayback')!.rawValue!
      return `反り腰関連スコアは ${fmtNum(v, 2)} です（骨盤帯の前後位置・膝の伸び・体幹の後傾から計算）。`
    },
  },
  {
    key: 'knee_hyperextension',
    label: '膝過伸展傾向',
    plane: 'side',
    evidence: ['side_knee_extension'],
    direction: 1,
    areas: ['knees'],
    caution: '膝の点は服のしわやふくらはぎの形で動きます。',
    summary: (m) => {
      const v = m.get('side_knee_extension')!.rawValue!
      return v >= 0
        ? `膝が股関節と足首を結ぶ線より後ろ側にあり、伸びすぎの方向に約${fmtAbs(v, '°')}です。`
        : `膝は軽く曲がった方向（約${fmtAbs(v, '°')}）にあります。`
    },
  },
]

export const TRAIT_LABELS: Record<TraitKey, string> = Object.fromEntries(
  TRAIT_DEFS.map((d) => [d.key, d.label]),
) as Record<TraitKey, string>

export function traitDef(key: TraitKey) {
  return TRAIT_DEFS.find((d) => d.key === key)!
}

/** 指標がばらつきの何倍の差か（K 倍で 1）。0..3 */
function magnitudeOf(m: ComputedMetric | undefined, dir: 1 | -1 | 0): number {
  if (!m || m.rawValue === null || !m.uncertainty) return 0
  const v = dir === 0 ? Math.abs(m.rawValue) : Math.max(0, m.rawValue * dir)
  return Math.min(3, v / (NOTICEABLE_K * m.uncertainty))
}

export function deriveTraits(metrics: ComputedMetric[], measuredPlanes: Plane[]): PostureTrait[] {
  const map = new Map(metrics.map((m) => [m.key, m]))
  return TRAIT_DEFS.map((def) => {
    const base: PostureTrait = {
      key: def.key,
      label: def.label,
      plane: def.plane,
      status: 'not_measured',
      evidenceMetricKeys: def.evidence,
      summary: '',
      caution: def.caution,
      magnitude: 0,
      relatedAreas: def.areas,
    }
    if (!measuredPlanes.includes(def.plane)) {
      return { ...base, summary: `${def.plane === 'front' ? '正面' : '側面'}の写真がないため、今回は測定していません。` }
    }
    // 主たる根拠（leg_alignment は左右 2 つ、それ以外は先頭の 1 つ）
    const primaryKeys = def.key === 'leg_alignment' ? def.evidence : [def.evidence[0]]
    const primary = primaryKeys.map((k) => map.get(k)).filter((m): m is ComputedMetric => !!m)
    const assessed = primary.filter((m) => m.rawValue !== null)
    if (assessed.length === 0) {
      const note = primary.find((m) => m.qualityNote)?.qualityNote ?? '必要な点を確認できませんでした'
      return { ...base, status: 'unassessable', summary: `評価できませんでした。${note}` }
    }
    const magnitude = Math.max(...assessed.map((m) => magnitudeOf(m, def.direction)))
    const noticeable = assessed.some(
      (m) => m.status === 'noticeable' && (def.direction === 0 || Math.sign(m.rawValue!) === def.direction),
    )
    const fact = def.summary(map)
    if (noticeable) {
      return { ...base, status: 'noticeable', summary: fact, magnitude: Math.round(magnitude * 100) / 100 }
    }
    // 表示上 0.0 になるほど小さい差は、向きを書かずに「ほぼ見られない」とする
    const nearZero = assessed.every((m) => Math.abs(m.rawValue!) < (m.unit === 'score' ? 0.005 : 0.05))
    return {
      ...base,
      status: 'within_noise',
      summary: nearZero ? `${def.label}は、ほぼ見られません。` : `${fact}この差は測定のばらつきの範囲内です。`,
      magnitude: Math.round(magnitude * 100) / 100,
    }
  })
}
