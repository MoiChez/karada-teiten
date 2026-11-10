# 04. データモデル

実装は [src/domain/types.ts](../src/domain/types.ts) と [src/data/db.ts](../src/data/db.ts)。ここでは意味を説明する。

## 1. IndexedDB のテーブル

| テーブル | 主キー | インデックス | 内容 |
|---|---|---|---|
| `profile` | `id`（常に `"me"`） | — | UserProfile |
| `assessments` | `id` | `createdAt` | AssessmentSession |
| `images` | `id` | `assessmentId` | 画像 Blob（同意時のみ） |
| `routineLogs` | `id` | `date`, `routineId` | 運動の実施記録 |
| `checkins` | `id` | `date` | その日のコンディション |
| `plans` | `id` | `generatedAt`, `basedOnAssessmentId` | RecommendationPlan |
| `settings` | `key` | — | 設定（画像保存・セルフタイマー・前回選んだ撮り方など） |
| `gaits` | `id` | `createdAt` | 歩き方の記録 GaitRecord（版 0.8 から。動画は保存せず、体の点の動きだけ） |

### GaitRecord（[src/domain/gait.ts](../src/domain/gait.ts)）

```ts
{
  id, createdAt, appVersion, modelVersion
  source: 'camera' | 'upload'
  footwear?: 'shoes' | 'socks' | 'barefoot'
  video: { width, height, durationMs, frameCount, fps, quarterTurns, rollDeg? }
  frames: { t: number; p: number[] }[]   // 人を検出できたコマ。p は 33 点 × [x, y, 見えている度合い]（小数 4 桁）
  analysis: GaitAnalysis                 // algorithmVersion が古ければ frames から計算し直す
}
```

JSON の書き出しに `gaits` として含める（ないファイルも読み込める）。

## 2. 主要な型

### UserProfile
```ts
{
  id: 'me'
  age?: number; sex?: 'female' | 'male' | 'other' | 'no_answer'
  heightCm?: number; weightKg?: number
  goals: GoalTag[]               // posture | diet | body_make | relieve_discomfort | fatigue | appearance | health | other | none
  goalNote?: string              // 「その他」の内容
  hasClearGoal: boolean
  activityLevel?: 'low' | 'moderate' | 'high'
  exerciseExperience?: 'none' | 'some' | 'regular'
  lifestyle: LifestyleTag[]      // desk_work | standing_work | physical_work | driving | smartphone_long | bag_one_side | crossed_legs | housework_childcare
  sleepRating?: 1..5; fatigueRating?: 1..5   // 1=よく眠れる/疲れにくい … 5=眠れない/とても疲れる（疲労）
  concernAreas: BodyArea[]       // neck | shoulders | upper_back | lower_back | hips | knees | feet | whole_body
  createdAt: string; updatedAt: string       // ISO 8601
}
```

### AssessmentSession
```ts
{
  id: string; createdAt: string; note?: string
  front?: PlaneRecord; side?: PlaneRecord
  computedMetrics: ComputedMetric[]          // 補正後ランドマークから計算
  computedMetricsRaw: ComputedMetric[]       // 補正前（生）から計算。補正差分の記録用
  postureTraits: PostureTrait[]
  confidenceScores: { overall: number; front?: number; side?: number }  // 0..1
  qualityFlags: QualityFlag[]                // 正面・側面の品質判定をまとめたもの
  recommendationSnapshot?: { planId: string; routineIds: string[] }   // 分析時に作ったおすすめ。計算ロジックの版が変わって再計算したら捨てる（結果の画面で作り直す）
  checkinId?: string
  captureMode?: 'simple' | 'precise'         // 以前の測り方（版 0.6 までの記録だけ）
  shootStyle?: 'placed' | 'mirror'            // 撮り方（版 0.7 から。ない記録は置いて撮ったもの）
  conscious?: ConsciousPose                  // 「意識した姿勢」。結果画面からあとで追加する
  imagesSaved: boolean
  modelVersion: string; appVersion: string; algorithmVersion: number
}

ConsciousPose {
  capturedAt: string
  front?: PlaneRecord; side?: PlaneRecord    // 写真を保存した場合の imageId は <セッション>_conscious_<面>
  computedMetrics: ComputedMetric[]; computedMetricsRaw: ComputedMetric[]
  confidenceScores: { overall: number; front?: number; side?: number }
  qualityFlags: QualityFlag[]
}

PlaneRecord {
  plane: 'front' | 'side'
  imageMetadata: {
    width: number; height: number
    source: 'camera' | 'upload'
    capturedAt: string
    facing?: 'left' | 'right'                // 側面のみ。被写体の顔が画像のどちらを向いているか
    deviceTilt?: { rollDeg: number; pitchDeg: number }  // カメラ撮影時の端末の傾き
    mirrorSelfie?: boolean                   // 鏡の前で自撮りした写真（左右を戻してある）
    imageId?: string                         // 画像を保存した場合
  }
  landmarksRaw: Landmark[]                   // 33 点。x,y は 0..1、z は相対深度、visibility, presence
  worldLandmarksRaw: Landmark[]              // メートル、腰の中点が原点
  landmarksCorrected: Landmark[]             // 補正後（補正がなければ生と同じ）
  correctionLog: CorrectionEntry[]           // { index, from{x,y}, to{x,y}, at }
  qualityFlags: QualityFlag[]
  burst?: {                                  // 複数枚撮り。landmarksRaw はこの平均
    frames: Landmark[][]                     // 各撮影の点（代表の写真の位置と大きさにそろえたもの）
    repIndex: number                         // 代表の写真（保存・表示する写真）が frames の何番目か
    attempted: number                        // 撮影した枚数（検出できなかった分も含む）
    spreadFrac: number | null                // 写真ごとの点の揺れ（H 比、1σ）
    outlines?: ({ left: Point[]; right: Point[] } | null)[]  // 側面: 各撮影の体の左端・右端（frames と同じ順・同じそろえ方）
  }
  outline?: {                                // 側面: 体の輪郭（この機能より前の記録にはない）
    left: { points: Point[]; note?: string } // 人の領域の左端（正規化座標、上から下へ）。取れなければ空と理由
    right: { points: Point[]; note?: string }// 右端。顔が画像の右向きなら左端、左向きなら右端が背中側
  }
}
```

### ComputedMetric
```ts
{
  key: MetricKey; label: string
  plane: 'front' | 'side'
  group: 'alignment' | 'relative' | 'composite'
  rawValue: number | null                    // 主表示の値（角度など）。評価不可なら null
  unit: '°' | '%' | 'score'
  normalizedValue: number | null             // 体のサイズで割った値（% など）
  normalizedUnit?: string
  direction: string                          // 値の向きの説明（例: 「左肩が低い」）
  uncertainty: number | null                 // 測定のばらつきの目安（rawValue と同じ単位、1σ）
  status: 'noticeable' | 'within_noise' | 'descriptive' | 'unassessable' | 'unsupported'
  confidence: number                         // 0..1
  qualityNote?: string                       // 評価不可の理由・注意
  usedLandmarks: number[]; correctedLandmarks: number[]
}
```

### PostureTrait
```ts
{
  key: TraitKey; label: string
  status: 'noticeable' | 'within_noise' | 'recorded' | 'unassessable' | 'not_measured'   // recorded: 横向きの特徴（1 回の測定では判定しない位置の記録）
  evidenceMetricKeys: MetricKey[]
  summary: string                            // 観測された事実（例: 「左肩が右肩より約 2.1° 低い位置にあります」）
  caution: string                            // 限界の説明
  magnitude: number                          // 0..3。提案の重み付けに使う（ばらつきの何倍か）
  relatedAreas: BodyArea[]                   // 3D の参考ハイライト
}
```

### RecommendationPlan / Routine
```ts
RecommendationPlan {
  id; generatedAt; basedOnAssessmentId?: string; basedOnComparison?: { a: string; b: string }
  goalTags: GoalTag[]
  routines: { routineId: string; reasons: string[]; slot: Slot; score: number }[]
  habitSuggestions: { id: string; text: string; reason: string }[]
  reviewTiming: { days: number; text: string }
}
Slot = 'today' | 'set3' | 'set5' | 'set10' | 'tired' | 'minimal' | 'priority' | 'continue' | 'strengthen' | 'recovery'

Routine {
  id; name; category: 'stretch' | 'mobility' | 'light_exercise' | 'posture_tip' | 'breathing'
  durationMin: number; difficulty: 1 | 2 | 3
  targetTags: TargetTag[]                    // 対象となる傾向・部位
  instructions: string[]; cautions: string[]; contraindications: string[]
  logFields: ('feeling' | 'discomfort' | 'note')[]
  notes?: string
}
```

### 記録
```ts
RoutineLog { id; date: string; routineId: string; feeling?: 'easy' | 'ok' | 'hard'; discomfort?: 'none' | 'slight' | 'yes'; note?: string }
CheckIn    { id; date: string; sleepRating?: 1..5; fatigueRating?: 1..5; discomfortAreas: BodyArea[]; note?: string }
```

## 3. 整合性のルール

- `landmarksCorrected` は `landmarksRaw` と同じ長さ（33）。補正対象外の点は生の値のまま
- `correctionLog` の最後のエントリと `landmarksCorrected` の位置は一致する（テストで確認）
- 画像を削除しても、ランドマーク・指標は残る（骨格のみで比較できる）
- セッション削除時は、そのセッションの画像も削除する
- エクスポート JSON は `schemaVersion` を持ち、インポート時に検証する
