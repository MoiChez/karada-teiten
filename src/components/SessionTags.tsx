// 記録に札（施術の前後・時間帯など）とメモを付ける。履歴と比較で見分けるため
import { useState } from 'react'
import type { AssessmentSession, SessionTag } from '../domain/types'
import { SESSION_TAG_LABELS } from '../domain/format'
import { data } from '../data/repo'
import { useToast } from '../state/stores'
import { Button, ChipGroup, inputClass } from './ui'

const OPTIONS = (Object.keys(SESSION_TAG_LABELS) as SessionTag[]).map((value) => ({ value, label: SESSION_TAG_LABELS[value] }))

export function SessionTags({ s }: { s: AssessmentSession }) {
  const toast = useToast((t) => t.show)
  const [tags, setTags] = useState<SessionTag[]>(s.tags ?? [])
  const [note, setNote] = useState(s.note ?? '')
  const [saving, setSaving] = useState(false)
  const dirty = note !== (s.note ?? '') || tags.slice().sort().join() !== (s.tags ?? []).slice().sort().join()
  const save = async () => {
    setSaving(true)
    try {
      await data.updateSession({ ...s, tags: tags.length ? tags : undefined, note: note.trim() || undefined })
      toast('札とメモを保存しました')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div>
      <ChipGroup legend="札" help="施術の前後などを付けておくと、履歴と比較で見分けられます" options={OPTIONS} values={tags} onChange={setTags} />
      <label htmlFor={`note-${s.id}`} className="mb-1.5 block font-medium">
        メモ
      </label>
      <textarea
        id={`note-${s.id}`}
        rows={3}
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="例: 整体の前。朝から首が重い"
        className={`${inputClass} py-2.5`}
      />
      <Button variant="secondary" block className="mt-3" onClick={save} loading={saving} disabled={!dirty}>
        保存する
      </Button>
    </div>
  )
}
