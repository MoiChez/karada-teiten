import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { BodyArea, CheckIn } from '../domain/types'
import { AREA_LABELS } from '../domain/format'
import { newId } from '../domain/session'
import { Button, ChipGroup, Field, RatingScale, Screen, inputClass } from '../components/ui'
import { data } from '../data/repo'
import { useToast } from '../state/stores'

export function CheckInScreen() {
  const navigate = useNavigate()
  const toast = useToast((s) => s.show)
  const [c, setC] = useState<CheckIn>({ id: newId('c'), date: new Date().toISOString(), discomfortAreas: [] })
  const [saving, setSaving] = useState(false)
  const empty = !c.fatigueRating && !c.sleepRating && c.discomfortAreas.length === 0 && !c.note

  const save = async () => {
    setSaving(true)
    await data.addCheckin({ ...c, note: c.note?.trim() || undefined })
    toast('今日の調子を記録しました')
    navigate('/')
  }

  return (
    <Screen
      title="今日の調子"
      back="/"
      footer={
        <Button variant="primary" size="lg" block onClick={save} loading={saving} disabled={empty}>
          記録する
        </Button>
      }
    >
      <p className="mt-1 mb-5 text-ink-2">疲れや睡眠の変化は、姿勢の変化と並べて振り返れます。わかる項目だけで大丈夫です。</p>
      <RatingScale legend="疲れ" low="疲れていない" high="とても疲れている" value={c.fatigueRating} onChange={(fatigueRating) => setC({ ...c, fatigueRating })} />
      <RatingScale legend="ゆうべの睡眠" low="よく眠れた" high="眠れなかった" value={c.sleepRating} onChange={(sleepRating) => setC({ ...c, sleepRating })} />
      <ChipGroup
        legend="今、気になるところ"
        options={(Object.keys(AREA_LABELS) as BodyArea[]).map((value) => ({ value, label: AREA_LABELS[value] }))}
        values={c.discomfortAreas}
        onChange={(discomfortAreas) => setC({ ...c, discomfortAreas })}
      />
      <Field label="メモ（任意）" htmlFor="ci-note">
        <input id="ci-note" className={inputClass} value={c.note ?? ''} onChange={(e) => setC({ ...c, note: e.target.value })} />
      </Field>
    </Screen>
  )
}
