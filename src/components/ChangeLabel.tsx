import { AlertCircle, ArrowLeftRight, CheckCircle2, Minus, MoveHorizontal } from 'lucide-react'
import { CHANGE_LABELS, type ChangeLabel as CL } from '../domain/compare'
import { cx } from './ui'

const STYLE: Record<CL, { icon: typeof Minus; cls: string }> = {
  improved: { icon: CheckCircle2, cls: 'bg-good-soft text-good' },
  stable: { icon: Minus, cls: 'bg-sunken text-ink-2' },
  worsened: { icon: AlertCircle, cls: 'bg-attention-soft text-attention' },
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
