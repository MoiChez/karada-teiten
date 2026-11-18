import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeftRight, Eye, Footprints, Hand, Ruler, Shirt, Smartphone, Sun, SquareDashed, User, Users } from 'lucide-react'
import type { BodyArea, ShootStyle } from '../domain/types'
import { AREA_LABELS, localDateKey } from '../domain/format'
import { newId } from '../domain/session'
import { ChipGroup, Button, Fold, Notice, RatingScale, Screen, Segmented } from '../components/ui'
import { useSessions } from '../data/hooks'
import { IOS_NOTE, isIOS } from '../data/persist'
import { useDraft, useSettings } from '../state/stores'

type Check = { icon: typeof Sun; title: string; text: string }

/** いちばん失敗しやすい 3 つ（初めから見せる） */
const KEY_CHECKS: Check[] = [
  {
    icon: Users,
    title: '人に撮ってもらうのがおすすめ',
    text: 'スマホを縦にまっすぐ、腰の高さで持ってもらいます。置き場所を探さずにすみ、高さと距離もそろえやすくなります。1 人のときは、下のように台に立ててタイマーで撮ります。',
  },
  { icon: Smartphone, title: 'スマホは腰の高さに、縦にまっすぐ', text: '台に置くときは、棚や台に立てかけます。2.5〜3m 離れて、頭からつま先まで入るところに立ちます。' },
  { icon: Sun, title: '明るい場所で、無地の壁の前に', text: '逆光にならない場所を選びます。背景に物が少ないほど、体の位置を正しく読み取れます。' },
  { icon: Shirt, title: '体の線が分かる服で', text: 'ゆったりした服は、肩や膝の位置がずれます。長い髪は背中にかからないようにまとめます。' },
]

/** 毎回そろえるためのコツ（開いて見る） */
const MORE_CHECKS: Check[] = [
  { icon: Footprints, title: 'その場で 5 回足踏みして、自然に止まったところで立つ', text: '足の開き方で、正面の傾きや膝の向きの値が変わります。床にテープで足の外側の線を写しておくと、毎回同じ立ち位置になります。' },
  { icon: Eye, title: '正面の目の高さの 1 点を見る', text: '目線の高さで、頭の位置の値が変わります。' },
  { icon: Hand, title: '腕は体の横で力を抜き、手のひらを太ももの横に向ける', text: '手の向きで、横向きの手の位置の値が変わります。腕や手が背中・お尻より後ろに出ると、背中の輪郭を測れません。' },
  { icon: User, title: 'いつもどおりに立つ', text: '良い姿勢をつくろうとしないでください。自分が良いと思う姿勢は、あとで別に撮れます。' },
  { icon: Footprints, title: '毎回、裸足か同じ靴下で', text: '履物で足首とかかとの位置が変わります。' },
]

/** 鏡の前で自撮りするときの条件 */
const MIRROR_KEY: Check[] = [
  { icon: SquareDashed, title: '全身が映る、まっすぐな鏡の前に', text: '壁に掛けた姿見がおすすめです。立てかけて傾いた鏡だと、体が傾いて写ります。鏡から 1.2〜1.5m 離れます。' },
  { icon: Smartphone, title: 'スマホは胸の前で、縦にまっすぐ', text: 'あごより下で持ち、顔を隠さないようにします。画面の水準器で傾きを確かめられます。' },
  { icon: Eye, title: 'タイマーを使い、撮る瞬間は前を見る', text: '正面は鏡の中の自分の目を、横向きはまっすぐ前を見ます。画面を見ていると頭が下を向きます。' },
]
const MIRROR_MORE: Check[] = [
  { icon: User, title: 'スマホを持たない腕は体の横に', text: '力を抜いて下ろします。スマホを持つ腕の位置は評価しません。' },
  { icon: Shirt, title: '体の線が分かる服で', text: 'ゆったりした服は肩や膝の位置がずれ、横向きの背中の輪郭も変わります。長い髪は背中にかからないようにまとめます。' },
  { icon: Footprints, title: 'その場で 5 回足踏みして、自然に止まったところで立つ', text: '床にテープで足の位置の目印を付けると、毎回同じ距離で撮れます。' },
]

const STYLE_LABEL: Record<ShootStyle, string> = { placed: 'スマホを置いて撮る', mirror: '鏡の前で自撮り' }

/** スマホの置き方の図（スマホを置いて撮るとき） */
function PlacementFigure() {
  return (
    <svg viewBox="0 0 320 150" role="img" aria-label="スマホの置き方の図。腰の高さの台にスマホを縦に立て、2.5〜3m 離れたところに全身で立つ" className="w-full">
      <line x1="10" x2="310" y1="132" y2="132" stroke="var(--color-line-strong)" strokeWidth="2" />
      {/* 台とスマホ */}
      <rect x="28" y="78" width="36" height="54" fill="var(--color-sunken)" stroke="var(--color-line-strong)" />
      <rect x="40" y="52" width="13" height="26" rx="2.5" fill="var(--color-ink)" />
      <circle cx="46.5" cy="57" r="1.6" fill="var(--color-level)" />
      {/* 腰の高さの線 */}
      <line x1="58" x2="258" y1="68" y2="68" stroke="var(--color-measure)" strokeWidth="1.2" strokeDasharray="3 3" />
      <text x="70" y="62" fontSize="12" fill="var(--color-measure)">
        腰の高さ
      </text>
      {/* 距離 */}
      <line x1="64" x2="234" y1="144" y2="144" stroke="var(--color-ink-2)" strokeWidth="1.2" markerStart="url(#pf-a)" markerEnd="url(#pf-a)" />
      <defs>
        <marker id="pf-a" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--color-ink-2)" />
        </marker>
      </defs>
      <text x="149" y="139" fontSize="12" textAnchor="middle" fill="var(--color-ink)">
        2.5〜3m
      </text>
      {/* 人 */}
      <g stroke="var(--color-ink)" strokeWidth="3.5" strokeLinecap="round" fill="none">
        <circle cx="250" cy="20" r="9" fill="var(--color-ink)" stroke="none" />
        <line x1="250" y1="31" x2="250" y2="74" />
        <line x1="250" y1="38" x2="240" y2="70" />
        <line x1="250" y1="38" x2="260" y2="70" />
        <line x1="250" y1="74" x2="244" y2="130" />
        <line x1="250" y1="74" x2="256" y2="130" />
      </g>
      <text x="282" y="80" fontSize="12" fill="var(--color-ink-2)">
        全身
      </text>
    </svg>
  )
}

function CheckList({ items }: { items: Check[] }) {
  return (
    <ul className="divide-y divide-line">
      {items.map(({ icon: Icon, title, text }) => (
        <li key={title} className="flex gap-3 py-3">
          <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-measure" />
          <div>
            <p className="font-medium">{title}</p>
            <p className="text-[15px] text-ink-2">{text}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function CaptureGuide() {
  const navigate = useNavigate()
  const draft = useDraft()
  const timerSec = useSettings((s) => s.settings.timerSec)
  const savedStyle = useSettings((s) => s.settings.shootStyle)
  const saveImages = useSettings((s) => s.settings.saveImages)
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
  const checkin = draft.checkin ?? { id: newId('c'), date: new Date().toISOString(), discomfortAreas: [] as BodyArea[] }
  const ios = isIOS()

  const start = () => {
    if (!hasDraft) draft.clear()
    draft.setStyle(style)
    if (!draft.checkin || localDateKey(new Date(draft.checkin.date)) !== localDateKey()) draft.setCheckin({ ...checkin, date: new Date().toISOString() })
    navigate('/measure/capture/front')
  }

  return (
    <Screen
      title="姿勢を測る"
      back="/"
      footer={
        <>
          {!hasDraft && <p className="text-center text-sm text-ink-2">次にカメラの使用を聞かれます。写真はこのスマホの外に出ません。</p>}
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
      {ios && (
        <div className="mb-3">
          <Notice tone="info">{IOS_NOTE}</Notice>
        </div>
      )}
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
      <p className="text-ink-2">
        正面と横向きを 1 枚ずつ撮ります。3 分ほどです。
        {style === 'mirror' && '鏡に映った姿は左右が反対なので、アプリが左右を戻して記録します。'}
      </p>

      {style === 'placed' && (
        <div className="mt-4 border-y border-line py-3">
          <PlacementFigure />
        </div>
      )}
      <div className="mt-2">
        <CheckList items={style === 'mirror' ? MIRROR_KEY : KEY_CHECKS} />
      </div>
      {last && (
        <p className="mt-2 text-[15px] text-ink-2">
          前回は {new Date(last.createdAt).getHours()} 時台に測りました。近い時間帯・同じ服装・同じ場所で撮ると、比べやすくなります。撮影の画面には前回の骨格が重なります。
        </p>
      )}

      <label className="mt-4 flex min-h-11 items-start gap-2 text-[15px]">
        <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--color-ink)]" checked={saveImages} onChange={(e) => updateSetting('saveImages', e.target.checked)} />
        <span>
          写真をこのスマホに残す
          <span className="block text-sm text-ink-2">残すと、結果で写真に線を重ねて見られます。外へは送りません。残さないときは、骨格の点と数値だけが残ります（設定でも変えられます）。</span>
        </span>
      </label>

      <div className="mt-6 border-b border-line">
        <Fold title="毎回そろえるためのコツ" hint={`${(style === 'mirror' ? MIRROR_MORE : MORE_CHECKS).length + 1} 件`}>
          <CheckList items={style === 'mirror' ? MIRROR_MORE : MORE_CHECKS} />
          <div className="flex gap-3 border-t border-line py-3">
            <ArrowLeftRight aria-hidden className="mt-0.5 size-5 shrink-0 text-measure" />
            <div>
              <p className="font-medium">{style === 'mirror' ? 'タイマーは 3 秒がおすすめ' : '一人で撮るときはタイマーを使う'}</p>
              <p className="text-[15px] text-ink-2">セルフタイマーは {timerSec ? `${timerSec} 秒` : 'オフ'} です（撮影の画面で変えられます）。</p>
            </div>
          </div>
          <div className="flex gap-3 border-t border-line py-3">
            <Ruler aria-hidden className="mt-0.5 size-5 shrink-0 text-measure" />
            <div>
              <p className="font-medium">施術の前後で比べるときは</p>
              <p className="text-[15px] text-ink-2">同じ日に、同じ場所・同じ服・同じ立ち方で撮ります。結果の「札とメモ」で「施術の前」「施術の後」を付けておくと、比べるときに見分けられます。</p>
            </div>
          </div>
        </Fold>
        <Fold title="今日の調子（任意）" hint={checkin.fatigueRating || checkin.sleepRating || checkin.discomfortAreas.length ? '記録あり' : undefined}>
          <p className="mb-3 text-sm text-ink-2">比べるときに、体調の変化と並べて見られます。</p>
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
        </Fold>
      </div>
    </Screen>
  )
}
