# からだ定点

写真 2 枚（正面・横向き）から姿勢を測り、過去と比べ、次の運動につなげるアプリです。
画像の処理はすべて端末のブラウザの中で行い、外部には送信しません。医療的な診断ではありません。

- 公開ページ: https://moichez.github.io/karada-teiten/
- 対応: Android の Chrome（主な対象）。iPhone の Safari は未確認

## できること

- プロフィール入力（すべて任意、目標がなくても使える）
- 正面・横向きの撮影（カメラ / 写真の選択、セルフタイマー、ガイド枠、水準器）
- MediaPipe Pose Landmarker による骨格推定（端末内）と撮影品質のチェック
- 骨格の点の手動補正（14 点）と再計算
- 正面 8 指標・横向き 9 指標・複合スコア 2 種。測定のばらつきの目安と信頼度つき
- 分析結果（観測された事実 / 考えられる要因 / 試してみるとよい行動 を分けて表示）
- 過去比較（前回・日付指定・2 件選択・7 / 30 / 90 日の推移、条件差の注意、行動記録との関連）
- ルールベースの運動・ストレッチ提案と実施記録
- 正面と横向きから合成した簡易 3D と、過去との重ね表示
- 端末内保存（写真は同意した場合のみ）、JSON / CSV の書き出し、JSON の読み込み
- PWA（ホーム画面に追加、オフライン）

できないこと・未実装は [docs/08](docs/08-verification-and-limits.md) とアプリ内の「できること・まだできないこと」に書いています。

## 起動手順

Node.js 22 以上。

```bash
npm install
```

```bash
npm run dev
```

http://localhost:5173 を開きます。`npm run dev` の前に MediaPipe の WASM が `public/mediapipe/` にコピーされます。

スマホのカメラは HTTPS でしか使えないため、実機では GitHub Pages の公開ページを使います（`main` に push すると自動で更新されます）。

## その他のコマンド

```bash
npm test
```

```bash
npm run build
```

```bash
npm run typecheck
```

## ドキュメント

| | |
|---|---|
| [01 要件整理と情報設計](docs/01-requirements.md) | 目的・機能要件・表現ルール・ナビゲーション |
| [02 アーキテクチャ](docs/02-architecture.md) | 構成・技術選定・MediaPipe の扱い |
| [03 画面一覧と UI 仕様](docs/03-screens.md) | 12 画面それぞれの構成・CTA・空状態・エラー |
| [04 データモデル](docs/04-data-model.md) | IndexedDB のテーブルと型 |
| [05 姿勢分析ロジック](docs/05-analysis-logic.md) | 全指標の使用点・座標系・式・意味・限界・測定不能条件 |
| [06 実装計画](docs/06-implementation-plan.md) | STEP 1〜10 とリスク |
| [07 補正・比較・3D](docs/07-correction-compare-3d.md) | 補正エディタ、比較画面、2 視点合成の 3D |
| [08 検証・制約・次フェーズ](docs/08-verification-and-limits.md) | テスト、手動確認の手順、既知の制約、次にやること |

## 構成

```
src/domain    計算ロジック（純粋関数、テスト対象）
src/pose      MediaPipe と画像処理
src/data      IndexedDB（Dexie）とエクスポート / インポート
src/state     画面をまたぐ状態（Zustand）
src/components 共通 UI・骨格表示・補正エディタ
src/screens   画面
tests         単体テスト（Vitest）
```

## ライセンスと出典

- 骨格推定モデル: MediaPipe Pose Landmarker（Google、Apache License 2.0）。`public/models/` に同梱
- フォント: IBM Plex Sans JP（SIL Open Font License）
