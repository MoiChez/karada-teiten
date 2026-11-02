// プロフィールの入力欄（オンボーディングとプロフィール編集で共用）
import type { BodyArea, GoalTag, LifestyleTag, UserProfile } from '../domain/types'
import { AREA_LABELS, GOAL_LABELS, LIFESTYLE_LABELS } from '../domain/format'
import { ChipGroup, Field, RatingScale, Segmented, inputClass } from './ui'

export type ProfileDraft = Omit<UserProfile, 'id' | 'createdAt' | 'updatedAt'>

export const emptyProfile = (): ProfileDraft => ({
  goals: [],
  hasClearGoal: true,
  lifestyle: [],
  concernAreas: [],
})

const RANGES = {
  age: [10, 100, '歳'],
  heightCm: [100, 230, 'cm'],
  weightKg: [25, 250, 'kg'],
} as const

export function validateProfile(p: ProfileDraft): Partial<Record<'age' | 'heightCm' | 'weightKg', string>> {
  const errors: Partial<Record<'age' | 'heightCm' | 'weightKg', string>> = {}
  for (const k of ['age', 'heightCm', 'weightKg'] as const) {
    const v = p[k]
    if (v === undefined) continue
    const [lo, hi, unit] = RANGES[k]
    if (!Number.isFinite(v) || v < lo || v > hi) errors[k] = `${lo}〜${hi}${unit}の範囲で入力してください`
  }
  return errors
}

function NumberInput({
  id,
  value,
  onChange,
  unit,
  invalid,
  step = 1,
}: {
  id: string
  value: number | undefined
  onChange: (v: number | undefined) => void
  unit: string
  invalid?: boolean
  step?: number
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        value={value ?? ''}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        className={`${inputClass} max-w-40 num ${invalid ? 'border-danger' : ''}`}
      />
      <span className="text-ink-2">{unit}</span>
    </div>
  )
}

export function BasicFields({ p, set, errors }: { p: ProfileDraft; set: (p: ProfileDraft) => void; errors: ReturnType<typeof validateProfile> }) {
  return (
    <>
      <Field label="年齢" htmlFor="age" error={errors.age} help="任意">
        <NumberInput id="age" value={p.age} onChange={(age) => set({ ...p, age })} unit="歳" invalid={!!errors.age} />
      </Field>
      <Segmented
        legend="性別（任意）"
        columns={2}
        value={p.sex}
        onChange={(sex) => set({ ...p, sex })}
        options={[
          { value: 'female', label: '女性' },
          { value: 'male', label: '男性' },
          { value: 'other', label: 'その他' },
          { value: 'no_answer', label: '回答しない' },
        ]}
      />
      <Field label="身長" htmlFor="height" error={errors.heightCm} help="任意">
        <NumberInput id="height" value={p.heightCm} onChange={(heightCm) => set({ ...p, heightCm })} unit="cm" invalid={!!errors.heightCm} step={0.1} />
      </Field>
      <Field label="体重" htmlFor="weight" error={errors.weightKg} help="任意。姿勢の計算には使いません">
        <NumberInput id="weight" value={p.weightKg} onChange={(weightKg) => set({ ...p, weightKg })} unit="kg" invalid={!!errors.weightKg} step={0.1} />
      </Field>
    </>
  )
}

const GOAL_OPTIONS = (Object.keys(GOAL_LABELS) as GoalTag[]).map((value) => ({ value, label: GOAL_LABELS[value] }))
const LIFE_OPTIONS = (Object.keys(LIFESTYLE_LABELS) as LifestyleTag[]).map((value) => ({ value, label: LIFESTYLE_LABELS[value] }))
const AREA_OPTIONS = (Object.keys(AREA_LABELS) as BodyArea[]).map((value) => ({ value, label: AREA_LABELS[value] }))

export function GoalFields({ p, set }: { p: ProfileDraft; set: (p: ProfileDraft) => void }) {
  return (
    <>
      <ChipGroup legend="使う目的（いくつでも）" options={GOAL_OPTIONS} values={p.goals} onChange={(goals) => set({ ...p, goals })} />
      {p.goals.includes('other') && (
        <Field label="その他の目的" htmlFor="goalNote">
          <input id="goalNote" className={inputClass} value={p.goalNote ?? ''} onChange={(e) => set({ ...p, goalNote: e.target.value })} />
        </Field>
      )}
      <Segmented
        legend="はっきりした目標はありますか"
        columns={2}
        value={p.hasClearGoal ? 'yes' : 'no'}
        onChange={(v) => set({ ...p, hasClearGoal: v === 'yes' })}
        options={[
          { value: 'yes', label: 'ある' },
          { value: 'no', label: 'まだない', hint: 'まず今の状態を知るところから' },
        ]}
      />
    </>
  )
}

export function LifeFields({ p, set }: { p: ProfileDraft; set: (p: ProfileDraft) => void }) {
  return (
    <>
      <Segmented
        legend="運動の経験"
        value={p.exerciseExperience}
        onChange={(exerciseExperience) => set({ ...p, exerciseExperience })}
        options={[
          { value: 'none', label: 'ほぼない' },
          { value: 'some', label: '少しある' },
          { value: 'regular', label: '習慣がある' },
        ]}
      />
      <Segmented
        legend="ふだんの活動量"
        value={p.activityLevel}
        onChange={(activityLevel) => set({ ...p, activityLevel })}
        options={[
          { value: 'low', label: '少なめ', hint: '座っている時間が長い' },
          { value: 'moderate', label: 'ふつう' },
          { value: 'high', label: '多め', hint: 'よく歩く・動く' },
        ]}
      />
      <ChipGroup legend="仕事・生活のパターン（いくつでも）" options={LIFE_OPTIONS} values={p.lifestyle} onChange={(lifestyle) => set({ ...p, lifestyle })} />
    </>
  )
}

export function ConditionFields({ p, set }: { p: ProfileDraft; set: (p: ProfileDraft) => void }) {
  return (
    <>
      <RatingScale legend="睡眠の自己評価" low="よく眠れている" high="眠れていない" value={p.sleepRating} onChange={(sleepRating) => set({ ...p, sleepRating })} />
      <RatingScale legend="疲れやすさの自己評価" low="疲れにくい" high="とても疲れやすい" value={p.fatigueRating} onChange={(fatigueRating) => set({ ...p, fatigueRating })} />
      <ChipGroup legend="特に気になる部位（いくつでも）" options={AREA_OPTIONS} values={p.concernAreas} onChange={(concernAreas) => set({ ...p, concernAreas })} />
    </>
  )
}
