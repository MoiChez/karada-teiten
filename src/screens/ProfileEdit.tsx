import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, Screen, SectionTitle } from '../components/ui'
import { BasicFields, ConditionFields, GoalFields, LifeFields, emptyProfile, validateProfile, type ProfileDraft } from '../components/ProfileFields'
import { data } from '../data/repo'
import { useToast } from '../state/stores'

export function ProfileEdit() {
  const navigate = useNavigate()
  const toast = useToast((s) => s.show)
  const [p, setP] = useState<ProfileDraft | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    data.getProfile().then((prof) => {
      if (!prof) return setP(emptyProfile())
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = prof
      void _id
      void _c
      void _u
      setP(rest)
    })
  }, [])

  if (!p) return <Screen title="プロフィール" back="/settings">{null}</Screen>
  const errors = validateProfile(p)
  const save = async () => {
    setSaving(true)
    await data.saveProfile(p)
    toast('プロフィールを保存しました')
    navigate('/settings')
  }

  return (
    <Screen
      title="プロフィール"
      back="/settings"
      footer={
        <Button variant="primary" size="lg" block onClick={save} loading={saving} disabled={Object.keys(errors).length > 0}>
          保存する
        </Button>
      }
    >
      <SectionTitle>基本情報</SectionTitle>
      <BasicFields p={p} set={setP} errors={errors} />
      <SectionTitle>目的</SectionTitle>
      <GoalFields p={p} set={setP} />
      <SectionTitle>生活と運動</SectionTitle>
      <LifeFields p={p} set={setP} />
      <SectionTitle>体の調子</SectionTitle>
      <ConditionFields p={p} set={setP} />
    </Screen>
  )
}
