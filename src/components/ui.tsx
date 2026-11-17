// 共通 UI 部品
import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { canGoBack } from '../state/nav'
import { AlertTriangle, ChevronDown, ChevronLeft, Info, Loader2, X } from 'lucide-react'

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ')
}

// ---------- ボタン ----------

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-level text-ink font-bold hover:brightness-95 active:brightness-90 shadow-[inset_0_-2px_0_rgb(16_40_47/0.18)]',
  secondary: 'bg-surface text-ink font-medium border border-ink/25 hover:bg-sunken active:bg-sunken',
  quiet: 'text-measure font-medium hover:bg-measure-soft active:bg-measure-soft',
  danger: 'bg-surface text-danger font-medium border border-danger/40 hover:bg-danger-soft',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'lg' | 'md' | 'sm'
  loading?: boolean
  icon?: ReactNode
  block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, block, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] transition-[filter,background-color] duration-150 select-none',
        'disabled:opacity-45 disabled:cursor-not-allowed',
        size === 'lg' && 'min-h-14 px-5 text-[17px]',
        size === 'md' && 'min-h-12 px-4 text-[15px]',
        size === 'sm' && 'min-h-11 px-3 text-sm',
        block ? 'w-full' : 'shrink-0 whitespace-nowrap',
        VARIANT[variant],
        className,
      )}
    >
      {loading ? <Loader2 aria-hidden className="size-5 animate-spin" /> : icon}
      {children}
    </button>
  )
})

export function ButtonLink({
  to,
  variant = 'secondary',
  size = 'md',
  icon,
  block,
  className,
  children,
}: {
  to: string
  variant?: Variant
  size?: 'lg' | 'md' | 'sm'
  icon?: ReactNode
  block?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <Link
      to={to}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] transition-[filter,background-color] duration-150',
        size === 'lg' && 'min-h-14 px-5 text-[17px]',
        size === 'md' && 'min-h-12 px-4 text-[15px]',
        size === 'sm' && 'min-h-11 px-3 text-sm',
        block ? 'w-full' : 'shrink-0 whitespace-nowrap',
        VARIANT[variant],
        className,
      )}
    >
      {icon}
      {children}
    </Link>
  )
}

export function IconButton({
  label,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-11 items-center justify-center rounded-full text-ink hover:bg-sunken active:bg-sunken disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  )
}

// ---------- 画面の枠 ----------

export function Screen({
  title,
  back,
  action,
  footer,
  children,
  wide,
  staticHeader,
}: {
  title: string
  back?: string | true
  action?: ReactNode
  footer?: ReactNode
  children: ReactNode
  wide?: boolean
  /** 見出しを画面の上に留めない（動画を上に留める画面で、動画に場所を空ける） */
  staticHeader?: boolean
}) {
  const navigate = useNavigate()
  const h1 = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    document.title = `${title} | からだ定点`
    // 画面遷移後、スクリーンリーダー向けに見出しへフォーカスを移す
    h1.current?.focus({ preventScroll: true })
  }, [title])
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col">
      <header className={cx('safe-top bg-paper', !staticHeader && 'sticky top-0 z-20')}>
        <div className="flex min-h-14 items-center gap-1 px-2">
          {back ? (
            <IconButton
              label="戻る"
              // アプリの中から来たときは来た画面へ。直接開いたときや撮影の直後は、決まった画面へ移る
              onClick={() => (back === true || canGoBack() ? navigate(-1) : navigate(back, { replace: true }))}
            >
              <ChevronLeft aria-hidden className="size-6" />
            </IconButton>
          ) : (
            <span className="w-2" />
          )}
          <h1 ref={h1} tabIndex={-1} className="flex-1 truncate text-[17px] font-bold outline-none">
            {title}
          </h1>
          {action}
        </div>
      </header>
      <main className={cx('flex-1 px-4 pb-8', wide && 'px-0')}>{children}</main>
      {footer && (
        <div className="safe-bottom sticky bottom-0 z-20 border-t border-line bg-paper px-4 pt-3 pb-3">
          <div className="flex flex-col gap-2 pb-1">{footer}</div>
        </div>
      )}
    </div>
  )
}

export function SectionTitle({ children, sub, id }: { children: ReactNode; sub?: ReactNode; id?: string }) {
  return (
    <div className="mt-8 mb-3">
      <h2 id={id} className="text-[19px] font-bold">
        {children}
      </h2>
      {sub && <p className="mt-0.5 text-sm text-ink-3">{sub}</p>}
    </div>
  )
}

// ---------- お知らせ ----------

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'danger'
  title?: string
  children?: ReactNode
}) {
  const Icon = tone === 'info' ? Info : AlertTriangle
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={cx(
        'flex gap-3 rounded-[var(--radius-control)] px-3.5 py-3 text-[15px]',
        tone === 'info' && 'bg-measure-soft text-ink',
        tone === 'warn' && 'bg-attention-soft text-ink',
        tone === 'danger' && 'bg-danger-soft text-ink',
      )}
    >
      <Icon
        aria-hidden
        className={cx(
          'mt-0.5 size-5 shrink-0',
          tone === 'info' && 'text-measure',
          tone === 'warn' && 'text-attention',
          tone === 'danger' && 'text-danger',
        )}
      />
      <div className="min-w-0">
        {title && <p className="font-bold">{title}</p>}
        {children && <div className={cx(title && 'mt-0.5', 'text-ink-2')}>{children}</div>}
      </div>
    </div>
  )
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center">
      <svg aria-hidden viewBox="0 0 64 96" className="mb-4 h-24 text-past">
        <line x1="32" y1="4" x2="32" y2="74" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 4" />
        <path d="M24 74h16l-8 14z" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <line x1="8" y1="92" x2="56" y2="92" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <p className="text-[17px] font-bold">{title}</p>
      {children && <div className="mt-1 max-w-[34ch] text-ink-2">{children}</div>}
      {action && <div className="mt-5 w-full max-w-xs">{action}</div>}
    </div>
  )
}

// ---------- フォーム ----------

export function Field({
  label,
  help,
  error,
  children,
  htmlFor,
}: {
  label: string
  help?: string
  error?: string
  children: ReactNode
  htmlFor?: string
}) {
  return (
    <div className="mb-5">
      <label htmlFor={htmlFor} className="mb-1.5 block font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p id={htmlFor ? `${htmlFor}-error` : undefined} role="alert" className="mt-1.5 text-sm font-medium text-danger">
          {error}
        </p>
      ) : (
        help && (
          <p id={htmlFor ? `${htmlFor}-help` : undefined} className="mt-1.5 text-sm text-ink-3">
            {help}
          </p>
        )
      )}
    </div>
  )
}

export const inputClass =
  'w-full min-h-12 rounded-[var(--radius-control)] border border-line-strong bg-surface px-3.5 text-[16px] text-ink placeholder:text-ink-3 focus:border-measure focus:outline-none focus-visible:outline-3 focus-visible:outline-measure'

/** 見えない input を包む label に、キーボードで選んだときのフォーカスの輪を出す */
const FOCUS_WITHIN = 'has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-measure'

/** 単一選択（ラジオボタン） */
export function Segmented<T extends string | number>({
  legend,
  options,
  value,
  onChange,
  columns,
}: {
  legend: string
  options: { value: T; label: string; hint?: string }[]
  value: T | undefined
  onChange: (v: T) => void
  columns?: number
}) {
  const name = useId()
  return (
    <fieldset className="mb-5">
      <legend className="mb-1.5 font-medium">{legend}</legend>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns ?? Math.min(options.length, 3)}, minmax(0, 1fr))` }}>
        {options.map((o) => {
          const checked = value === o.value
          return (
            <label
              key={String(o.value)}
              className={cx(
                'relative flex min-h-12 items-center justify-center rounded-[var(--radius-control)] border px-2 py-2 text-center text-[15px] transition-colors',
                FOCUS_WITHIN,
                checked ? 'border-ink bg-ink text-paper font-medium' : 'border-line-strong bg-surface text-ink hover:bg-sunken',
              )}
            >
              <input
                type="radio"
                name={name}
                className="sr-only"
                checked={checked}
                onChange={() => onChange(o.value)}
              />
              <span>
                {o.label}
                {o.hint && <span className={cx('block text-xs', checked ? 'text-paper/80' : 'text-ink-3')}>{o.hint}</span>}
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

/** 複数選択（チェックボックスのチップ） */
export function ChipGroup<T extends string>({
  legend,
  help,
  options,
  values,
  onChange,
}: {
  legend: string
  help?: string
  options: { value: T; label: string }[]
  values: T[]
  onChange: (v: T[]) => void
}) {
  return (
    <fieldset className="mb-5">
      <legend className="mb-1.5 font-medium">{legend}</legend>
      {help && <p className="-mt-1 mb-2 text-sm text-ink-3">{help}</p>}
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const checked = values.includes(o.value)
          return (
            <label
              key={o.value}
              className={cx(
                'flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 text-[15px] transition-colors',
                FOCUS_WITHIN,
                checked ? 'border-ink bg-ink text-paper' : 'border-line-strong bg-surface text-ink hover:bg-sunken',
              )}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={checked}
                onChange={() => onChange(checked ? values.filter((v) => v !== o.value) : [...values, o.value])}
              />
              {checked && (
                <svg aria-hidden viewBox="0 0 16 16" className="size-3.5">
                  <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" />
                </svg>
              )}
              {o.label}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

/** 1〜5 の自己評価 */
export function RatingScale({
  legend,
  low,
  high,
  value,
  onChange,
}: {
  legend: string
  low: string
  high: string
  value: number | undefined
  onChange: (v: 1 | 2 | 3 | 4 | 5) => void
}) {
  const name = useId()
  return (
    <fieldset className="mb-5">
      <legend className="mb-1.5 font-medium">{legend}</legend>
      <div className="grid grid-cols-5 gap-2">
        {([1, 2, 3, 4, 5] as const).map((n) => (
          <label
            key={n}
            className={cx(
              'flex min-h-12 items-center justify-center rounded-[var(--radius-control)] border text-[17px] num transition-colors',
              FOCUS_WITHIN,
              value === n ? 'border-ink bg-ink text-paper font-bold' : 'border-line-strong bg-surface hover:bg-sunken',
            )}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              aria-label={`${n}（${n === 1 ? low : n === 5 ? high : '中間'}）`}
              checked={value === n}
              onChange={() => onChange(n)}
            />
            <span aria-hidden>{n}</span>
          </label>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-ink-3">
        <span>1: {low}</span>
        <span>5: {high}</span>
      </div>
    </fieldset>
  )
}

// ---------- ダイアログ ----------

export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
}: {
  open: boolean
  onClose: () => void
  title: string
  children?: ReactNode
  actions?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby={`${title}-title`}
      className="m-auto w-[min(92vw,440px)] rounded-[var(--radius-panel)] bg-surface p-0 text-ink shadow-lift"
    >
      <div className="p-5">
        <div className="flex items-start gap-2">
          <h2 id={`${title}-title`} className="flex-1 text-[18px] font-bold">
            {title}
          </h2>
          <IconButton label="閉じる" onClick={onClose} className="-mt-2 -mr-2">
            <X aria-hidden className="size-5" />
          </IconButton>
        </div>
        {children && <div className="mt-2 text-ink-2">{children}</div>}
        {actions && <div className="mt-5 flex flex-col gap-2">{actions}</div>}
      </div>
    </dialog>
  )
}

// ---------- 小物 ----------

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'measure' | 'attention' | 'good' | 'level' }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[13px] font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-sunken text-ink-2',
        tone === 'measure' && 'bg-measure-soft text-measure',
        tone === 'attention' && 'bg-attention-soft text-attention',
        tone === 'good' && 'bg-good-soft text-good',
        tone === 'level' && 'bg-level-soft text-level-ink',
      )}
    >
      {children}
    </span>
  )
}

export function ProgressSteps({ total, current, label }: { total: number; current: number; label: string }) {
  return (
    <div className="mb-6" aria-label={`${label} ${current} / ${total}`} role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={current}>
      <div className="flex gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={cx('h-1.5 flex-1 rounded-full', i < current ? 'bg-ink' : 'bg-line')} />
        ))}
      </div>
      <p className="mt-2 text-sm text-ink-3 num">
        {current} / {total}
      </p>
    </div>
  )
}

/**
 * 開いたり閉じたりする項目。初めは閉じていて、見出しの行を押すと開く。箱や影は付けず、細い線で区切る。
 * 中身は開いたときに作る（keepMounted なら、閉じても残す。書き出しの途中で閉じても止まらないように）
 */
export function Fold({
  title,
  hint,
  children,
  keepMounted,
  defaultOpen = false,
  anchor,
}: {
  title: ReactNode
  hint?: ReactNode
  children: ReactNode
  keepMounted?: boolean
  /** 初めから開いておく（あとから true になったときも開く） */
  defaultOpen?: boolean
  /** 画面の中で移動するときの目印（section の id） */
  anchor?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [seen, setSeen] = useState(defaultOpen)
  const id = useId()
  useEffect(() => {
    if (defaultOpen) {
      setOpen(true)
      setSeen(true)
    }
  }, [defaultOpen])
  return (
    <section id={anchor} className="border-t border-line">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            setOpen(!open)
            setSeen(true)
          }}
          className="flex min-h-14 w-full items-center gap-3 py-2 text-left"
        >
          <span className="flex-1 text-[16px] font-bold">{title}</span>
          {hint && <span className="shrink-0 text-sm text-ink-3 num">{hint}</span>}
          <ChevronDown aria-hidden className={cx('size-5 shrink-0 text-ink-3 transition-transform duration-150', open && 'rotate-180')} />
        </button>
      </h2>
      {(open || (keepMounted && seen)) && (
        <div id={id} hidden={!open} className="pb-5">
          {children}
        </div>
      )}
    </section>
  )
}

export function Details({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-[15px] font-medium text-measure [&::-webkit-details-marker]:hidden">
        <ChevronLeft aria-hidden className="size-4 -rotate-90 transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      <div className="pb-2 pl-5 text-[15px] text-ink-2">{children}</div>
    </details>
  )
}
