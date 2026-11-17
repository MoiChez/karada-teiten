import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, Minus, MoveHorizontal } from 'lucide-react'
import { CHANGE_LABELS, type ChangeLabel as CL } from '../domain/compare'
import { cx } from './ui'

// 良し悪しを言わないので、色は変化の有無だけで分ける（変化あり = 青、変化なし = 灰色）
const STYLE: Record<CL, { icon: typeof Minus; cls: string }> = {
  improved: { icon: ArrowDownRight, cls: 'bg-measure-soft text-measure' },
  stable: { icon: Minus, cls: 'bg-sunken text-ink-2' },
  worsened: { icon: ArrowUpRight, cls: 'bg-measure-soft text-measure' },
  smaller: { icon: ArrowDownRight, cls: 'bg-measure-soft text-measure' },
  larger: { icon: ArrowUpRight, cls: 'bg-measure-soft text-measure' },
  flipped: { icon: ArrowLeftRight, cls: 'bg-measure-soft text-measure' },
  changed: { icon: MoveHorizontal, cls: 'bg-measure-soft text-measure' },
}

export function ChangeLabel({ change }: { change: CL }) {
  const { icon: Icon, cls } = STYLE[change]
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[13px] font-medium whitespace-nowrap', cls)}>
      <Icon aria-hidden className="size-3.5" />
      {CHANGE_LABELS[change]}
    </span>
  )
}
