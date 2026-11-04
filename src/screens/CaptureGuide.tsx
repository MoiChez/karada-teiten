import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeftRight, Footprints, Ruler, Shirt, Smartphone, Sun, SquareDashed, User } from 'lucide-react'
import type { BodyArea, CaptureMode } from '../domain/types'
import { PRECISE_SHOTS } from '../domain/constants'
import { AREA_LABELS, localDateKey } from '../domain/format'
import { newId } from '../domain/session'
import { Button, ChipGroup, Details, Notice, RatingScale, Screen, SectionTitle, Segmented } from '../components/ui'
import { useSessions } from '../data/hooks'
import { useDraft, useSettings } from '../state/stores'

const CHECKS = [
  { icon: Sun, title: '明るい場所で', text: '顔や体に影が強く出ない、逆光にならない場所を選びます。' },
  { icon: SquareDashed, title: '無地の壁の前で', text: '背景に物が少ないほど、体の位置を正しく推定できます。' },
  { icon: Smartphone, title: 'スマホは腰の高さで、縦にまっすぐ', text: '棚や台に立てかけるのがおすすめです。画面の水準器で傾きを確認できます。' },
  { icon: Ruler, title: '2.5〜3m 離れて全身を入れる', text: '頭からつま先まで入り、上下に少し余白がある距離です。' },
  { icon: Shirt, title: '体の線が分かる服で', text: 'ゆったりした服は肩や膝の位置がずれる原因になります。裸足がおすすめです。' },
  { icon: User, title: 'いつもどおりに立つ', text: '良い姿勢をつくろうとせず、腕は体の横で力を抜きます。' },
  { icon: Footprints, title: '立ち位置に目印を', text: '床にテープなどで足の位置の目印を付けると、毎回同じ距離で撮れます。撮影画面には前回の骨格が重なり、位置のずれを教えてくれます。' },
]

export function CaptureGuide() {
  const navigate = useNavigate()
  const draft = useDraft()
  const timerSec = useSettings((s) => s.settings.timerSec)
  const savedMode = useSettings((s) => s.settings.captureMode)
  const updateSetting = useSettings((s) => s.update)
  const sessions = useSessions()
  const last = sessions?.[0]
  const hasDraft = !!(draft.front || draft.side) && !draft.editingSessionId
  // 前回選んだモードが初期値。撮影の続きでは、そのときのモードのまま
  const [mode, setMode] = useState<CaptureMode>(hasDraft ? draft.mode : (savedMode ?? 'precise'))
  const chooseMode = (m: CaptureMode) => {
    setMode(m)
    updateSetting('captureMode', m)
  }
  const checkin = draft.checkin ?? { id: newId('c'), date: new Date().toISOString(), discomfortAreas: [] as BodyArea[] }

  const start = () => {
    if (!hasDraft) draft.clear()
    draft.setMode(mode)
    if (!draft.checkin || draft.checkin.date.slice(0, 10) !== localDateKey()) draft.setCheckin({ ...checkin, date: new Date().toISOString() })
    navigate('/measure/capture/front')
  }

  return (
    <Screen
      title="測る"
      back="/"
      footer={
        <>
          {hasDraft ? (
            <>
              <Button variant="primary" size="lg" block onClick={() => navigate(draft.side ? '/measure/review/side' : draft.front ? '/measure/review/front' : '/measure/capture/front')}>
                撮影の続きから
              </Button>
              <Button variant="quiet" block onClick={() => { draft.clear(); navigate('/measure/capture/front') }}>
                最初から撮り直す
              </Button>
            </>
          ) : (
            <Button variant="primary" size="lg" block onClick={start}>
              正面の撮影を始める
            </Button>
          )}
        </>
      }
    >
      {hasDraft ? (
        <p className="mt-2 font-medium">測り方: {mode === 'precise' ? '高精度' : 'シンプル'}（撮影の続き）</p>
      ) : (
        <div className="mt-2">
          <Segmented
            legend="測り方"
            columns={2}
            value={mode}
            onChange={chooseMode}
            options={[
              { value: 'simple', label: 'シンプル', hint: '1 枚ずつ・手早く' },
              { value: 'precise', label: '高精度', hint: `${PRECISE_SHOTS} 枚の平均・意識した姿勢も` },
            ]}
          />
        </div>
      )}
      <p className="mt-2 text-ink-2">
        {mode === 'precise'
          ? `正面と横向きを、それぞれ ${PRECISE_SHOTS} 枚続けて撮って平均します（約 2 秒、動かずに立つだけ）。続けて、自分が良いと思う姿勢でも同じように撮り、いつもの姿勢と比べます。`
          : '正面と横向きを 1 枚ずつ撮ります。横向きは省略もできます。意識した姿勢は、あとで結果画面から撮れます。'}
      </p>
      <p className="mt-1 text-sm text-ink-3">どちらも同じ高精度の推定モデルを使います。毎回同じ条件で撮ると、変化を比べやすくなります。</p>
      {last && (
        <Notice tone="info" title="前回と条件をそろえましょう">
          前回は {new Date(last.createdAt).getHours()} 時台に測りました。近い時間帯・同じ服装・同じ場所がおすすめです。
        </Notice>
      )}

      <SectionTitle>撮影の条件</SectionTitle>
      <ul className="divide-y divide-line">
        {CHECKS.map(({ icon: Icon, title, text }) => (
          <li key={title} className="flex gap-3 py-3">
            <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-measure" />
            <div>
              <p className="font-medium">{title}</p>
              <p className="text-[15px] text-ink-2">{text}</p>
            </div>
          </li>
        ))}
        <li className="flex gap-3 py-3">
          <ArrowLeftRight aria-hidden className="mt-0.5 size-5 shrink-0 text-measure" />
          <div>
            <p className="font-medium">一人で撮るときはタイマーを使う</p>
            <p className="text-[15px] text-ink-2">セルフタイマーは {timerSec ? `${timerSec} 秒` : 'オフ'} に設定されています（撮影画面で変えられます）。</p>
          </div>
        </li>
      </ul>

      <SectionTitle sub="任意。比較のときに、体調の変化と並べて見られます">今日のコンディション</SectionTitle>
      <RatingScale
        legend="疲れ"
        low="疲れていない"
        high="とても疲れている"
        value={checkin.fatigueRating}
        onChange={(fatigueRating) => draft.setCheckin({ ...checkin, fatigueRating })}
      />
      <RatingScale
        legend="ゆうべの睡眠"
        low="よく眠れた"
        high="眠れなかった"
        value={checkin.sleepRating}
        onChange={(sleepRating) => draft.setCheckin({ ...checkin, sleepRating })}
      />
      <ChipGroup
        legend="今、気になるところ"
        options={(Object.keys(AREA_LABELS) as BodyArea[]).map((value) => ({ value, label: AREA_LABELS[value] }))}
        values={checkin.discomfortAreas}
        onChange={(discomfortAreas) => draft.setCheckin({ ...checkin, discomfortAreas })}
      />

      <Details summary="写真の扱いについて">
        写真は端末の中で骨格の推定に使い、外部には送信しません。設定で「写真を保存する」をオンにしていない場合、写真は分析後にアプリを閉じると消え、骨格の点と数値だけが残ります。
      </Details>
    </Screen>
  )
}
