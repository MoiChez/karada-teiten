import { NavLink } from 'react-router'
import { Camera, Columns2, Footprints, House, ListOrdered } from 'lucide-react'
import { cx } from './ui'

const items = [
  { to: '/', label: 'ホーム', icon: House, end: true },
  { to: '/compare', label: '比較', icon: Columns2 },
  { to: '/measure', label: '測る', icon: Camera, primary: true },
  { to: '/move', label: '運動', icon: Footprints },
  { to: '/history', label: '履歴', icon: ListOrdered },
]

export function BottomNav() {
  return (
    <nav aria-label="メイン" className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper/95 backdrop-blur-sm">
      <ul className="mx-auto grid max-w-[560px] grid-cols-5">
        {items.map(({ to, label, icon: Icon, end, primary }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                cx(
                  'flex min-h-16 flex-col items-center justify-center gap-0.5 text-[12px]',
                  primary ? 'text-ink font-bold' : isActive ? 'text-ink font-bold' : 'text-ink-3',
                )
              }
            >
              {({ isActive }) =>
                primary ? (
                  <>
                    <span className="-mt-5 flex size-13 items-center justify-center rounded-full bg-level shadow-lift ring-4 ring-paper">
                      <Icon aria-hidden className="size-6" />
                    </span>
                    <span>{label}</span>
                  </>
                ) : (
                  <>
                    <span className={cx('flex h-7 w-12 items-center justify-center rounded-full', isActive && 'bg-sunken')}>
                      <Icon aria-hidden className="size-5" strokeWidth={isActive ? 2.4 : 1.8} />
                    </span>
                    <span>{label}</span>
                  </>
                )
              }
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
