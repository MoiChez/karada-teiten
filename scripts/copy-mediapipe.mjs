// MediaPipe の WASM ファイルを public/ にコピーし、自サイトから配信できるようにする
import { mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const dest = join(root, 'public', 'mediapipe', 'wasm')
const files = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
]

if (!existsSync(src)) {
  console.error('[copy-mediapipe] @mediapipe/tasks-vision が見つかりません。npm install を実行してください。')
  process.exit(1)
}
mkdirSync(dest, { recursive: true })
for (const f of files) {
  const from = join(src, f)
  const to = join(dest, f)
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue
  copyFileSync(from, to)
}
console.log('[copy-mediapipe] WASM を public/mediapipe/wasm に用意しました')
