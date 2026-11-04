# 02. アーキテクチャ

## 1. 全体像

```
┌──────────────────────── ブラウザ（端末内で完結） ────────────────────────┐
│                                                                           │
│  screens/  画面（React）                                                  │
│     │  読む・書く                                                         │
│     ▼                                                                     │
│  state/    Zustand（撮影中の下書き・設定）    data/ Dexie(IndexedDB)       │
│     │                                         profile / assessments /     │
│     │                                         images / routineLogs /      │
│     ▼                                         checkins / plans / settings │
│  pose/     MediaPipe Pose Landmarker（WASM + GPU/CPU）                    │
│     │      画像品質チェック（Canvas で明るさ・ぶれ）                       │
│     ▼                                                                     │
│  domain/   純粋関数（UI・DB に依存しない。単体テストの対象）               │
│     geometry → metrics(front/side/composite) → traits → hypotheses        │
│     compare（2 回の差分・推移）   recommend（ルールベース提案）            │
│     fusion3d（正面+側面 → 簡易 3D 座標）                                  │
└───────────────────────────────────────────────────────────────────────────┘
       ▲ 静的ファイルのみ配信（GitHub Pages / HTTPS）
       │ index.html, JS, CSS, フォント, MediaPipe WASM, モデル(.task)
```

サーバー側の処理はない。配信は静的ファイルだけで、画像や測定値はどこにも送らない。

## 2. 技術選定

| 領域 | 採用 | 理由 |
|---|---|---|
| ビルド | Vite + React 19 + TypeScript | 指定どおり。高速な開発サーバー |
| スタイル | Tailwind CSS v4 + CSS 変数のデザイントークン | shadcn の CLI 生成は使わず、必要な部品だけ自作して依存を減らす |
| 状態 | Zustand | 撮影フローの下書き（画像・ランドマーク・補正）を画面間で受け渡す |
| 保存 | Dexie（IndexedDB） | スキーマ版管理とインデックス検索が簡単 |
| 姿勢推定 | @mediapipe/tasks-vision（PoseLandmarker） | 指定どおり。WASM とモデルを自サイトから配信 |
| 3D | three + @react-three/fiber + drei（OrbitControls） | 3D 画面だけ遅延読み込みして初回表示を軽くする |
| グラフ | Recharts | 推移グラフ（折れ線）のみ |
| PWA | vite-plugin-pwa（Workbox） | アプリ本体は事前キャッシュ、モデルと WASM は初回利用時にキャッシュ |
| ルーティング | react-router（HashRouter） | GitHub Pages でリロードしても 404 にならない |
| アイコン | lucide-react | 線の太さが揃った SVG アイコン |
| フォント | IBM Plex Sans JP（@fontsource で自サイト配信） | 計測器のような端正さと日本語の読みやすさ。Google への通信をしない |
| テスト | Vitest + fake-indexeddb | 計算ロジックと保存処理の単体テスト |
| 配信 | GitHub Actions → GitHub Pages | push で自動デプロイ |

## 3. MediaPipe の扱い

- 実行モード: 静止画の分析は `IMAGE`、撮影中の「全身が入っているか」の表示は `VIDEO`（低頻度）
- モデル: 高精度 `pose_landmarker_heavy`（約 31MB）。シンプル・高精度のどちらの測り方でも同じモデルを使い、撮影中の「全身が入っているか」の確認にも同じモデルを使う（モデルを 1 つだけ読み込むため）
- デリゲート: GPU を試し、失敗したら CPU にフォールバック
- `numPoses: 2` で検出し、2 人目が大きく写っていれば品質フラグを立てる（分析は 1 人目のみ）
- 出力は `landmarks`（正規化画像座標 + visibility + presence）と `worldLandmarks`（メートル、腰の中点が原点）。分析には主に画像座標を使い、ワールド座標は向き推定と 3D の補助にだけ使う
- モデル名・バージョンはセッションに保存する（`modelVersion`）

## 4. 画面フローの状態管理

撮影から保存までは「下書き（Draft）」として Zustand に持つ。

```
Draft {
  front?: PlaneCapture   // 画像Blob, 画像サイズ, 生ランドマーク, 補正後, 補正ログ, 品質フラグ, 端末傾き
  side?:  PlaneCapture   // + 向き（左向き/右向き）
  checkin?: 今日のコンディション
}
```

「分析する」で Draft から `AssessmentSession` を作り IndexedDB に保存する。画像は設定で同意している場合だけ保存する。保存後に結果画面から補正し直す場合は、保存済み画像か、まだメモリにある Draft の画像を使う。どちらもなければ補正できない理由を表示する。

## 5. 計算の再現性

- 生ランドマークと補正後ランドマークを両方保存しているので、指標はいつでも再計算できる
- 計算ロジックに `ALGORITHM_VERSION` を持たせ、保存値の版が古ければ読み込み時に再計算する
- 指標の不確かさはランダム摂動（シード固定）で求めるため、同じ入力からは常に同じ結果になる

## 6. ディレクトリ構成

```
src/
  domain/         計算ロジック（純粋関数）
    landmarks.ts    ランドマーク定義・補正対象
    geometry.ts     角度・距離・射影
    metrics/        正面・側面・複合指標
    quality.ts      品質判定
    traits.ts       姿勢特徴と文章
    hypotheses.ts   生活習慣との関連仮説
    compare.ts      比較・推移
    recommend/      メニュー集・提案エンジン・習慣アドバイス
    fusion3d.ts     2 視点からの簡易 3D
  pose/           MediaPipe と画像処理
  data/           Dexie・リポジトリ・エクスポート/インポート
  state/          Zustand ストア
  components/     共通 UI・骨格表示・補正エディタ
  screens/        画面
docs/             設計ドキュメント
tests/            単体テスト
scripts/          MediaPipe WASM のコピー、アイコン生成
```
