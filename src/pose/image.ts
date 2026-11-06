// 画像の読み込み・縮小・品質の数値化（明るさ・コントラスト・ぶれ）
import type { ImageStats } from '../domain/types'

/** 推定と保存に使う画像の長辺の上限 */
const MAX_LONG_SIDE = 1600

export interface PreparedImage {
  canvas: HTMLCanvasElement
  blob: Blob
  width: number
  height: number
  stats: ImageStats
}

function drawScaled(source: CanvasImageSource, sw: number, sh: number): HTMLCanvasElement {
  const scale = Math.min(1, MAX_LONG_SIDE / Math.max(sw, sh))
  const w = Math.round(sw * scale)
  const h = Math.round(sh * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, w, h)
  return canvas
}

async function finish(canvas: HTMLCanvasElement): Promise<PreparedImage> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を変換できませんでした'))), 'image/jpeg', 0.9),
  )
  return { canvas, blob, width: canvas.width, height: canvas.height, stats: computeImageStats(canvas) }
}

/** 左右を反転した複製（鏡の前で自撮りした写真を、ふつうに撮った写真の向きに戻す） */
export function flipCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = src.width
  c.height = src.height
  const ctx = c.getContext('2d')!
  ctx.translate(src.width, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(src, 0, 0)
  return c
}

/** ファイルを読み込み、向き（EXIF）を反映して縮小する。flip なら左右を反転する */
export async function prepareFromFile(file: Blob, opts: { flip?: boolean } = {}): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) throw new Error('画像ファイルを選んでください')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('この画像は読み込めませんでした。JPEG か PNG の写真を選んでください')
  }
  const canvas = drawScaled(bitmap, bitmap.width, bitmap.height)
  bitmap.close()
  return finish(opts.flip ? flipCanvas(canvas) : canvas)
}

/** カメラの映像から 1 枚切り出す（鏡像にはしない） */
export async function prepareFromVideo(video: HTMLVideoElement): Promise<PreparedImage> {
  return finish(grabVideoFrame(video))
}

/** 映像の今のコマをすぐに切り出す（続けて撮るときに間隔を保つため、圧縮はあとで prepareFromCanvas で行う） */
export function grabVideoFrame(video: HTMLVideoElement): HTMLCanvasElement {
  return drawScaled(video, video.videoWidth, video.videoHeight)
}

export const prepareFromCanvas = finish

/** 短辺 256px に縮小したグレースケールで、輝度の平均・標準偏差・ラプラシアン分散を求める */
export function computeImageStats(canvas: HTMLCanvasElement): ImageStats {
  const scale = 256 / Math.min(canvas.width, canvas.height)
  const w = Math.max(8, Math.round(canvas.width * Math.min(1, scale)))
  const h = Math.max(8, Math.round(canvas.height * Math.min(1, scale)))
  const small = document.createElement('canvas')
  small.width = w
  small.height = h
  const ctx = small.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(canvas, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)
  const gray = new Float32Array(w * h)
  let sum = 0
  for (let i = 0; i < w * h; i++) {
    const g = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
    gray[i] = g
    sum += g
  }
  const mean = sum / (w * h)
  let v = 0
  for (let i = 0; i < w * h; i++) v += (gray[i] - mean) ** 2
  const std = Math.sqrt(v / (w * h))
  // ラプラシアン（4 近傍）の分散
  let lsum = 0
  let lsq = 0
  let n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const lap = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i]
      lsum += lap
      lsq += lap * lap
      n++
    }
  }
  const lmean = lsum / n
  return {
    meanLuma: Math.round(mean * 10) / 10,
    stdLuma: Math.round(std * 10) / 10,
    laplacianVar: Math.round((lsq / n - lmean * lmean) * 10) / 10,
  }
}

export async function blobToImageBitmapCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvas
}
