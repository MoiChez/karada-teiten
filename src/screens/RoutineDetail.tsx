import { useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { Ban, CircleAlert } from 'lucide-react'
import type { RoutineLog, TargetTag } from '../domain/types'
import { routineById } from '../domain/recommend/routines'
import { AREA_LABELS } from '../domain/format'
import { TRAIT_LABELS } from '../domain/traits'
import { newId } from '../domain/session'
import { categoryLabel } from '../components/RoutineItem'
import { Badge, Button, Dialog, Field, Screen, SectionTitle, Segmented, inputClass } from '../components/ui'
import { data } from '../data/repo'
import { useToast } from '../state/stores'

function tagLabel(t: TargetTag): string | null {
  if (t in TRAIT_LABELS) return TRAIT_LABELS[t as keyof typeof TRAIT_LABELS]
  if (t in AREA_LABELS) return AREA_LABELS[t as keyof typeof AREA_LABELS]
  return null
}

export function RoutineDetail() {
  const { routineId } = useParams()
  const navigate = useNavigate()
  const toast = useToast((s) => s.show)
  const r = routineId ? routineById(routineId) : undefined
  const [open, setOpen] = useState(false)
  const [log, setLog] = useState<Partial<RoutineLog>>({})
  const [saving, setSaving] = useState(false)
  if (!r) return <Navigate to="/move" replace />

  const save = async () => {
    setSaving(true)
    await data.addLog({ id: newId('l'), date: new Date().toISOString(), routineId: r.id, feeling: log.feeling, discomfort: log.discomfort, note: log.note?.trim() || undefined })
    setOpen(false)
    toast('記録しました。おつかれさまでした')
    navigate(-1)
  }

  const targets = r.targetTags.map(tagLabel).filter((x): x is string => !!x)

  return (
    <Screen
      title={r.name}
      back="/move"
      footer={
        <Button variant="primary" size="lg" block onClick={() => setOpen(true)}>
          やった
        </Button>
      }
    >
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="level">{r.durationMin} 分</Badge>
        <Badge>{categoryLabel(r.category)}</Badge>
        <Badge>難易度 {'●'.repeat(r.difficulty)}{'○'.repeat(3 - r.difficulty)}</Badge>
      </div>
      <p className="mt-3 text-[17px]">{r.summary}</p>
      {targets.length > 0 && <p className="mt-2 text-sm text-ink-3">関係する傾向・部位: {targets.join('・')}</p>}

      <SectionTitle>やり方</SectionTitle>
      <ol className="space-y-3">
        {r.instructions.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-sm font-bold text-paper num">{i + 1}</span>
            <span className="pt-0.5">{s}</span>
          </li>
        ))}
      </ol>

      <SectionTitle>注意すること</SectionTitle>
      <ul className="space-y-2">
        {r.cautions.map((c) => (
          <li key={c} className="flex gap-2">
            <CircleAlert aria-hidden className="mt-1 size-4 shrink-0 text-attention" />
            {c}
          </li>
        ))}
      </ul>

      <SectionTitle>やらないほうがよいとき</SectionTitle>
      <ul className="space-y-2 rounded-[var(--radius-control)] bg-danger-soft p-3">
        {r.contraindications.map((c) => (
          <li key={c} className="flex gap-2">
            <Ban aria-hidden className="mt-1 size-4 shrink-0 text-danger" />
            {c}
          </li>
        ))}
      </ul>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="やってみてどうでしたか"
        actions={
          <>
            <Button variant="primary" block onClick={save} loading={saving}>
              記録する
            </Button>
            <Button variant="quiet" block onClick={() => setOpen(false)}>
              やめる
            </Button>
          </>
        }
      >
        <div className="text-ink">
          {r.logFields.includes('feeling') && (
            <Segmented
              legend="きつさ"
              value={log.feeling}
              onChange={(feeling) => setLog({ ...log, feeling })}
              options={[
                { value: 'easy', label: '楽' },
                { value: 'ok', label: 'ちょうど' },
                { value: 'hard', label: 'きつい' },
              ]}
            />
          )}
          {r.logFields.includes('discomfort') && (
            <Segmented
              legend="痛みや違和感"
              value={log.discomfort}
              onChange={(discomfort) => setLog({ ...log, discomfort })}
              options={[
                { value: 'none', label: 'なし' },
                { value: 'slight', label: '少し' },
                { value: 'yes', label: 'あった' },
              ]}
            />
          )}
          {log.discomfort === 'yes' && (
            <p className="-mt-3 mb-4 text-sm text-attention">痛みや違和感が続く場合は、このメニューを控えて医療機関に相談してください。</p>
          )}
          <Field label="メモ（任意）" htmlFor="log-note">
            <input id="log-note" className={inputClass} value={log.note ?? ''} onChange={(e) => setLog({ ...log, note: e.target.value })} />
          </Field>
        </div>
      </Dialog>
    </Screen>
  )
}
