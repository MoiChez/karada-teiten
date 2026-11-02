import { CheckCircle2, CircleDashed, Info } from 'lucide-react'
import { Screen, SectionTitle } from '../components/ui'
import { ROUTINES } from '../domain/recommend/routines'

const DONE = [
  'プロフィール入力（あとから編集可）',
  '正面・横向きの撮影（カメラ / 写真の選択、セルフタイマー、ガイド枠、水準器、全身が入っているかの表示）',
  '端末内での骨格推定（MediaPipe Pose Landmarker、標準 / 高精度モデル）',
  '撮影品質のチェック（全身欠け・向き・傾き・明るさ・ぶれ・複数人など）',
  '骨格の手動補正（14 点、ドラッグ・拡大鏡・拡大表示・ボタンでの微調整・吸着・リセット・再検出）',
  '補正後の再計算と、補正前の値の記録',
  '正面 10 指標・横向き 10 指標・複合スコア 2 種の計算と、測定のばらつきの目安',
  'ずれの向きと大きさのゲージ（中央の帯は測定のばらつきの範囲、前回の位置も表示）と、左右荷重の傾向の足の図',
  '身長から換算した cm の目安（位置のずれ・高さの差）',
  '写真への基準線（足元を通る鉛直線、肩と股関節の水平線）',
  '分析結果（事実・仮説・行動を分けた表示）',
  '過去比較（前回 / 日付指定 / 2 件選択 / 7・30・90 日の推移、条件差の注意、行動記録との関連）',
  `運動・ストレッチの提案（${ROUTINES.length} 種類、ルールベース）と実施記録`,
  '正面と横向きから合成した簡易 3D と、過去との重ね表示',
  '端末内保存（写真は同意した場合のみ）、JSON / CSV の書き出し、JSON の読み込み、全削除',
  'ホーム画面に追加して使える（PWA、オフライン対応）',
]

const NOT_YET = [
  '詳細モード（12 枚の写真による測定）',
  '骨盤の前傾・後傾の角度（写真の目印から推定できないため）',
  '動画での動作の分析',
  'クラウド同期・複数端末での共有・アカウント',
  '運動メニューの動画・イラスト（いまは文章のみ）',
  '運動メニューの専門家による監修',
  '体型・脂肪のつき方の推定、将来の姿勢の予測（行わない方針）',
  'ダークモード',
]

export function Status() {
  return (
    <Screen title="できること・まだできないこと" back="/settings">
      <SectionTitle>実装済み</SectionTitle>
      <ul className="space-y-2.5">
        {DONE.map((d) => (
          <li key={d} className="flex gap-2.5">
            <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-good" />
            <span>{d}</span>
          </li>
        ))}
      </ul>
      <SectionTitle>未実装・対象外</SectionTitle>
      <ul className="space-y-2.5">
        {NOT_YET.map((d) => (
          <li key={d} className="flex gap-2.5">
            <CircleDashed aria-hidden className="mt-0.5 size-5 shrink-0 text-ink-3" />
            <span className="text-ink-2">{d}</span>
          </li>
        ))}
      </ul>
      <SectionTitle>動作確認の状況</SectionTitle>
      <p className="flex gap-2.5 text-ink-2">
        <Info aria-hidden className="mt-0.5 size-5 shrink-0 text-measure" />
        計算ロジックは合成データの単体テストで確認しています。実機では Android の Chrome を主な対象にしており、iPhone（Safari）での動作は未確認です。
      </p>
    </Screen>
  )
}
