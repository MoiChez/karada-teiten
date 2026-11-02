import type { QualityFlag } from '../domain/types'
import { Notice } from './ui'

export function QualityList({ flags }: { flags: QualityFlag[] }) {
  const blocking = flags.filter((f) => f.severity === 'blocking')
  const major = flags.filter((f) => f.severity === 'major')
  const minor = flags.filter((f) => f.severity === 'minor')
  if (!flags.length) {
    return (
      <Notice tone="info" title="大きな問題は見つかりませんでした">
        点の位置がずれていないか確認し、必要なら直してください。
      </Notice>
    )
  }
  return (
    <div className="space-y-2">
      {blocking.map((f) => (
        <Notice key={f.key} tone="danger" title="分析できません">
          {f.message}
        </Notice>
      ))}
      {major.length > 0 && (
        <Notice tone="warn" title="撮り直しをおすすめします">
          <ul className="list-disc space-y-1 pl-4">
            {major.map((f) => (
              <li key={f.key}>{f.message}</li>
            ))}
          </ul>
        </Notice>
      )}
      {minor.length > 0 && (
        <Notice tone="info" title="精度に影響するかもしれない点">
          <ul className="list-disc space-y-1 pl-4">
            {minor.map((f) => (
              <li key={f.key}>{f.message}</li>
            ))}
          </ul>
        </Notice>
      )}
    </div>
  )
}
