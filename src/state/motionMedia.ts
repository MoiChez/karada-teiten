// 残さないと選んだ動画（コマの画像）を、このページを開いているあいだだけ持っておく。
// 撮った直後の結果の画面で、動画と 3D を並べて見られるようにするため。ほかの画面へ移っても残すが、
// 新しく撮ったら前のものは捨てる（メモリを使いすぎないため）。ページを閉じれば消える
export interface MotionVideoData {
  width: number
  height: number
  images: { t: number; blob: Blob }[]
}

let latest: { id: string; video: MotionVideoData } | null = null

export function keepMotionVideo(id: string, video: MotionVideoData) {
  latest = { id, video }
}

export function memoryMotionVideo(id: string): MotionVideoData | undefined {
  return latest?.id === id ? latest.video : undefined
}

export function forgetMotionVideo(id: string) {
  if (latest?.id === id) latest = null
}
