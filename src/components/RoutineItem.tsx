import { Link } from 'react-router'
import { ChevronRight, Clock } from 'lucide-react'
import type { PlannedRoutine } from '../domain/types'
import { routineById } from '../domain/recommend/routines'

const CATEGORY: Record<string, string> = {
  stretch: 'ストレッチ',
  mobility: 'モビリティ',
  light_exercise: '軽い運動',
  posture_tip: '姿勢のコツ',
  breathing: '呼吸',
}

export function categoryLabel(c: string) {
  return CATEGORY[c] ?? c
}

export function RoutineItem({ plan, showReason = true }: { plan: Pick<PlannedRoutine, 'routineId' | 'reasons'>; showReason?: boolean }) {
  const r = routineById(plan.routineId)
  if (!r) return null
  return (
    <li>
      <Link to={`/move/${r.id}`} className="flex items-center gap-3 py-3 hover:bg-sunken/60">
        <span className="flex size-12 shrink-0 flex-col items-center justify-center rounded-[10px] bg-level-soft text-level-ink">
          <Clock aria-hidden className="size-4" />
          <span className="text-[13px] font-bold num">{r.durationMin}分</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{r.name}</span>
          <span className="block text-sm text-ink-3">
            {categoryLabel(r.category)}・難易度 {'●'.repeat(r.difficulty)}
            {'○'.repeat(3 - r.difficulty)}
          </span>
          {showReason && plan.reasons[0] && <span className="mt-0.5 block text-sm text-ink-2">{plan.reasons[0]}</span>}
        </span>
        <ChevronRight aria-hidden className="size-5 shrink-0 text-ink-3" />
      </Link>
    </li>
  )
}
