import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeftRight, Eye, Footprints, Ruler, Shirt, Smartphone, Sun, SquareDashed, User } from 'lucide-react'
import type { BodyArea, ShootStyle } from '../domain/types'
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
  { icon: Shirt, title: '体の線が分かる服で', text: 'ゆったりした服は肩や膝の位置がずれ、横向きの背中の輪郭も変わります。長い髪は背中にかからないようまとめます。裸足がおすすめです。' },
  { icon: User, title: 'いつもどおりに立つ', text: '良い姿勢をつくろうとせず、腕は体の横で力を抜きます。腕や手が背中・お尻より後ろに出ると、背中の輪郭を測れません。' },
  { icon: Footprints, title: '立ち位置に目印を', text: '床にテープなどで足の位置の目印を付けると、毎回同じ距離で撮れます。撮影画面には前回の骨格が重なり、位置のずれを教えてくれます。' },
]

/** 鏡の前で自撮りするときの条件 */
const MIRROR_CHECKS = [
  { icon: SquareDashed, title: '全身が映る、まっすぐな鏡で', text: '壁に掛けた姿見がおすすめです。立てかけて傾いた鏡だと、体が傾いて写ります。' },
  { icon: Ruler, title: '鏡から 1.2〜1.5m 離れる', text: '鏡に映った姿は、鏡までの距離の 2 倍の位置にあるように写ります。頭からつま先まで入る距離に立ちます。' },
  { icon: Smartphone, title: 'スマホは胸の前で、縦にまっすぐ', text: 'あごより下で持ち、顔を隠さないようにします。画面の水準器で傾きを確認できます。' },
  { icon: Eye, title: 'タイマーを使い、撮る瞬間は前を見る', text: '正面は鏡の中の自分の目を、横向きはまっすぐ前を見ます。画面を見ていると頭が下を向きます。' },
  { icon: User, title: 'スマホを持たない腕は体の横に', text: '力を抜いて下ろします。スマホを持つ腕の位置は評価しません。' },
  { icon: Shirt, title: '体の線が分かる服で', text: 'ゆったりした服は肩や膝の位置がずれ、横向きの背中の輪郭も変わります。長い髪は背中にかからないようまとめます。' },
  { icon: Footprints, title: '立ち位置に目印を', text: '床にテープなどで足の位置の目印を付けると、毎回同じ距離で撮れます。' },
]

const STYLE_LABEL: Record<ShootStyle, string> = { placed: 'スマホを置いて撮る', mirror: '鏡の前で自撮り' }

export function CaptureGuide() {
  const navigate = useNavigate()
  const draft = useDraft()
  const timerSec = useSettings((s) => s.settings.timerSec)
  const savedStyle = useSettings((s) => s.settings.shootStyle)
  const updateSetting = useSettings((s) => s.update)
  const sessions = useSessions()
  const last = sessions?.[0]
  const hasDraft = !!(draft.front || draft.side) && !draft.editingSessionId
  // 前回選んだ撮り方が初期値。撮影の続きでは、そのときの撮り方のまま
  const [style, setStyle] = useState<ShootStyle>(hasDraft ? draft.style : (savedStyle ?? 'placed'))
  const chooseStyle = (s: ShootStyle) => {
    setStyle(s)
    updateSetting('shootStyle', s)
  }
  const checks = style === 'mirror' ? MIRROR_CHECKS : CHECKS
  const checkin = draft.checkin ?? { id: newId('c'), date: new Date().toISOString(), discomfortAreas: [] as BodyArea[] }

  const start = () => {
    if (!hasDraft) draft.clear()
    draft.setStyle(style)
    if (!draft.checkin || localDateKey(new Date(draft.checkin.date)) !== localDateKey()) draft.setCheckin({ ...checkin, date: new Date().toISOString() })
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
        <p className="mt-2 font-medium">撮り方: {STYLE_LABEL[style]}（撮影の続き）</p>
      ) : (
        <div className="mt-2">
          <Segmented
            legend="撮り方"
            columns={2}
            value={style}
            onChange={chooseStyle}
            options={[
              { value: 'placed', label: 'スマホを置いて', hint: 'タイマーで撮る' },
              { value: 'mirror', label: '鏡の前で自撮り', hint: '姿見に映して撮る' },
            ]}
          />
        </div>
      )}
      <p className="mt-2 text-ink-2">
        正面と横向きを 1 枚ずつ撮ります。
        {style === 'mirror' && '鏡に映った姿は左右が反対なので、アプリが左右を戻して記録します。'}
      </p>
      <p className="mt-1 text-sm text-ink-3">毎回同じ撮り方・同じ条件で撮ると、変化を比べやすくなります。自分が良いと思う姿勢との比較は、あとで結果画面から撮れます。</p>
      {last && (
        <Notice tone="info" title="前回と条件をそろえましょう">
          前回は {new Date(last.createdAt).getHours()} 時台に測りました。近い時間帯・同じ服装・同じ場所がおすすめです。
        </Notice>
      )}

      <SectionTitle>撮影の条件</SectionTitle>
      <ul className="divide-y divide-line">
        {checks.map(({ icon: Icon, title, text }) => (
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
            <p className="font-medium">{style === 'mirror' ? 'タイマーは 3 秒がおすすめ' : '一人で撮るときはタイマーを使う'}</p>
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
