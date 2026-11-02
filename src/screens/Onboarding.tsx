import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ShieldCheck, Smartphone, Stethoscope } from 'lucide-react'
import { Button, ProgressSteps, Screen } from '../components/ui'
import { BasicFields, ConditionFields, GoalFields, LifeFields, emptyProfile, validateProfile, type ProfileDraft } from '../components/ProfileFields'
import { data } from '../data/repo'
import { useSettings } from '../state/stores'

const STEPS = ['はじめに', '基本情報', '目的', '生活と運動', '体の調子'] as const

export function Onboarding() {
  const navigate = useNavigate()
  const update = useSettings((s) => s.update)
  const [step, setStep] = useState(0)
  const [p, setP] = useState<ProfileDraft>(emptyProfile)
  const [saving, setSaving] = useState(false)
  const errors = validateProfile(p)
  const blocked = step === 1 && Object.keys(errors).length > 0

  const finish = async () => {
    setSaving(true)
    await data.saveProfile(p)
    await update('onboarded', true)
    navigate('/', { replace: true })
  }
  const next = () => (step === STEPS.length - 1 ? finish() : setStep(step + 1))

  return (
    <Screen
      title={STEPS[step]}
      footer={
        <>
          <Button variant="primary" size="lg" block onClick={next} loading={saving} disabled={blocked}>
            {step === 0 ? 'はじめる' : step === STEPS.length - 1 ? '入力を終えて進む' : '次へ'}
          </Button>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="quiet" block onClick={() => setStep(step - 1)}>
                戻る
              </Button>
            )}
            {step > 0 && (
              <Button variant="quiet" block onClick={() => (step === STEPS.length - 1 ? finish() : setStep(step + 1))} disabled={saving}>
                あとで入力する
              </Button>
            )}
          </div>
        </>
      }
    >
      {step > 0 && <ProgressSteps total={STEPS.length - 1} current={step} label="入力の進み具合" />}

      {step === 0 && (
        <div className="pt-4">
          <p className="text-[26px] leading-snug font-bold">
            同じ場所から、
            <br />
            からだを定点観測する。
          </p>
          <p className="mt-4 text-ink-2">
            正面と横向きの写真 2 枚から、姿勢の特徴を数値で記録します。前回と比べて、次にやることを一緒に決めていきます。
          </p>
          <ul className="mt-8 space-y-5">
            <li className="flex gap-3">
              <Smartphone aria-hidden className="mt-0.5 size-6 shrink-0 text-measure" />
              <div>
                <p className="font-bold">写真はこの端末の中だけで処理します</p>
                <p className="text-[15px] text-ink-2">どこにも送信しません。写真を残すかどうかは、あとから選べます（初期設定は残さない）。</p>
              </div>
            </li>
            <li className="flex gap-3">
              <Stethoscope aria-hidden className="mt-0.5 size-6 shrink-0 text-measure" />
              <div>
                <p className="font-bold">医療的な診断ではありません</p>
                <p className="text-[15px] text-ink-2">
                  写真から推定した目印の位置関係を示すもので、病気やけがの判断はできません。痛みやしびれがある場合は医療機関に相談してください。
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <ShieldCheck aria-hidden className="mt-0.5 size-6 shrink-0 text-measure" />
              <div>
                <p className="font-bold">質問はすべて任意です</p>
                <p className="text-[15px] text-ink-2">答えるほど提案が合いやすくなります。目標がまだなくても大丈夫です。</p>
              </div>
            </li>
          </ul>
        </div>
      )}
      {step === 1 && <BasicFields p={p} set={setP} errors={errors} />}
      {step === 2 && <GoalFields p={p} set={setP} />}
      {step === 3 && <LifeFields p={p} set={setP} />}
      {step === 4 && <ConditionFields p={p} set={setP} />}
    </Screen>
  )
}
