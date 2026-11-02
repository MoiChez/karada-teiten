// 生活習慣との関連仮説。断定せず「可能性」として書く
import type { Hypothesis, LifestyleTag, PostureTrait, TraitKey, UserProfile } from './types'
import { LIFESTYLE_LABELS } from './format'

interface Rule {
  id: string
  traits: TraitKey[]
  lifestyle: LifestyleTag[]
  text: string
}

const RULES: Rule[] = [
  {
    id: 'screen_forward_head',
    traits: ['forward_head', 'kyphosis_related'],
    lifestyle: ['desk_work', 'smartphone_long', 'driving'],
    text: '画面を見る・運転するなど、前を向いて座る時間が長いと、頭が前に出た姿勢が続きやすいと言われています。今回の特徴と関係しているかもしれません。',
  },
  {
    id: 'arms_front_rounded',
    traits: ['rounded_shoulder_related'],
    lifestyle: ['desk_work', 'smartphone_long'],
    text: 'パソコンやスマホで腕を体の前で使う時間が長いと、肩が前に入りやすいと考えられます。',
  },
  {
    id: 'bag_shoulder',
    traits: ['shoulder_asymmetry', 'head_tilt'],
    lifestyle: ['bag_one_side'],
    text: 'いつも同じ側でかばんを持つ習慣が、肩の高さの左右差に関係している可能性があります。',
  },
  {
    id: 'childcare_side',
    traits: ['shoulder_asymmetry', 'trunk_shift', 'load_shift'],
    lifestyle: ['housework_childcare'],
    text: '子どもを抱っこする・物を持つ側が決まっていると、左右差に関係する可能性があります。',
  },
  {
    id: 'crossed_legs',
    traits: ['pelvis_asymmetry', 'load_shift', 'lateral_lean', 'trunk_shift'],
    lifestyle: ['crossed_legs', 'standing_work'],
    text: '脚を組む・片脚に体重をかけて立つクセが、左右差に関係している可能性があります。',
  },
  {
    id: 'standing_lock_knee',
    traits: ['swayback_related', 'knee_hyperextension'],
    lifestyle: ['standing_work'],
    text: '長く立っているときに、膝を伸ばしきって腰を前に出す立ち方が続くと、このような特徴が出やすいと言われています。',
  },
  {
    id: 'bending_work',
    traits: ['trunk_sagittal', 'kyphosis_related'],
    lifestyle: ['physical_work', 'housework_childcare'],
    text: '前かがみの作業が多いと、立ったときにも上半身が前に傾きやすくなることがあります。',
  },
]

export function deriveHypotheses(traits: PostureTrait[], profile: UserProfile | undefined): Hypothesis[] {
  if (!profile) return []
  const noticeable = traits.filter((t) => t.status === 'noticeable')
  const out: Hypothesis[] = []
  const used = new Set<string>()
  for (const rule of RULES) {
    const trait = noticeable.find((t) => rule.traits.includes(t.key))
    const hit = rule.lifestyle.filter((l) => profile.lifestyle.includes(l))
    if (!trait || hit.length === 0 || used.has(rule.id)) continue
    used.add(rule.id)
    out.push({
      id: rule.id,
      traitKey: trait.key,
      text: rule.text,
      basis: `「${trait.label}」と、生活パターン「${hit.map((h) => LIFESTYLE_LABELS[h]).join('」「')}」の組み合わせから`,
    })
  }
  if (noticeable.length > 0 && profile.activityLevel === 'low') {
    out.push({
      id: 'low_activity',
      traitKey: noticeable[0].key,
      text: '日中に体を動かす時間が少ないと、同じ姿勢が長く続きやすくなります。こまめに立ち上がるだけでも変化があるかもしれません。',
      basis: '日常の活動量「少なめ」から',
    })
  }
  if (noticeable.length > 0 && (profile.fatigueRating ?? 0) >= 4) {
    out.push({
      id: 'fatigue_posture',
      traitKey: noticeable[0].key,
      text: '疲れているときは、片脚に体重をかけるなど楽な立ち方になりやすく、測定時の疲れが結果に影響している可能性もあります。',
      basis: '疲れやすさの自己評価から',
    })
  }
  return out
}
