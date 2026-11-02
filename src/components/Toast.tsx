import { CheckCircle2 } from 'lucide-react'
import { useToast } from '../state/stores'

export function Toast() {
  const message = useToast((s) => s.message)
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-[max(env(safe-area-inset-top),12px)] z-50 flex justify-center px-4">
      {message && (
        <div className="pointer-events-auto flex max-w-[520px] items-center gap-2 rounded-full bg-ink px-4 py-2.5 text-[15px] text-paper shadow-lift">
          <CheckCircle2 aria-hidden className="size-5 text-level" />
          {message}
        </div>
      )}
    </div>
  )
}
