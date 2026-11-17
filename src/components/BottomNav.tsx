import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router'
import { Camera, Columns2, Footprints, House, ListOrdered, PersonStanding, Video } from 'lucide-react'
import { Dialog, cx } from './ui'

const items = [
  { to: '/', label: 'ホーム', icon: House, end: true },
  { to: '/compare', label: '比較', icon: Columns2 },
  { to: '/move', label: '運動', icon: Footprints },
  { to: '/history', label: '履歴', icon: ListOrdered },
]

/** 下のタブ。真ん中の「測る」はタブではなく、姿勢か動きかを選ぶ行動のボタン */
export function BottomNav() {
  const navigate = useNavigate()
  const [choose, setChoose] = useState(false)
  const go = (to: string) => {
    setChoose(false)
    navigate(to)
  }
  const tab = ({ to, label, icon: Icon, end }: (typeof items)[number]) => (
    <li key={to}>
      <NavLink
        to={to}
        end={end}
        className={({ isActive }) => cx('flex min-h-16 flex-col items-center justify-center gap-0.5 text-[12px]', isActive ? 'font-bold text-ink' : 'text-ink-3')}
      >
        {({ isActive }) => (
          <>
            <span className={cx('flex h-7 w-12 items-center justify-center rounded-full', isActive && 'bg-sunken')}>
              <Icon aria-hidden className="size-5" strokeWidth={isActive ? 2.4 : 1.8} />
            </span>
            <span>{label}</span>
          </>
        )}
      </NavLink>
    </li>
  )
  return (
    <nav aria-label="メイン" className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper">
      <ul className="mx-auto grid max-w-[560px] grid-cols-5">
        {items.slice(0, 2).map(tab)}
        <li>
          <button type="button" onClick={() => setChoose(true)} aria-haspopup="dialog" className="flex min-h-16 w-full flex-col items-center justify-center gap-0.5 text-[12px] font-bold text-ink">
            <span className="-mt-5 flex size-13 items-center justify-center rounded-full bg-level shadow-lift ring-4 ring-paper">
              <Camera aria-hidden className="size-6" />
            </span>
            <span>測る</span>
          </button>
        </li>
        {items.slice(2).map(tab)}
      </ul>
      <Dialog open={choose} onClose={() => setChoose(false)} title="何を測りますか">
        <div className="mt-2 grid gap-2">
          <button
            type="button"
            onClick={() => go('/measure')}
            className="flex min-h-16 items-center gap-3 rounded-[var(--radius-control)] border border-line-strong bg-surface px-4 text-left hover:bg-sunken"
          >
            <PersonStanding aria-hidden className="size-6 shrink-0 text-measure" />
            <span>
              <span className="block font-bold text-ink">姿勢を測る</span>
              <span className="block text-sm text-ink-2">立った姿を正面と横から 2 枚撮る</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => go('/motion')}
            className="flex min-h-16 items-center gap-3 rounded-[var(--radius-control)] border border-line-strong bg-surface px-4 text-left hover:bg-sunken"
          >
            <Video aria-hidden className="size-6 shrink-0 text-measure" />
            <span>
              <span className="block font-bold text-ink">動きを撮る</span>
              <span className="block text-sm text-ink-2">スクワット・ローイングエルゴ・固定式の自転車を動画で</span>
            </span>
          </button>
        </div>
      </Dialog>
    </nav>
  )
}
