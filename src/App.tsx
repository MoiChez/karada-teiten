import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { BottomNav } from './components/BottomNav'
import { Toast } from './components/Toast'
import { useSettings } from './state/stores'
import { data } from './data/repo'
import { Home } from './screens/Home'
import { Onboarding } from './screens/Onboarding'
import { ProfileEdit } from './screens/ProfileEdit'
import { CaptureGuide } from './screens/CaptureGuide'
import { Capture } from './screens/Capture'
import { Review } from './screens/Review'
import { Analyzing } from './screens/Analyzing'
import { Result } from './screens/Result'
import { EditSaved } from './screens/EditSaved'
import { Compare } from './screens/Compare'
import { Move } from './screens/Move'
import { RoutineDetail } from './screens/RoutineDetail'
import { History } from './screens/History'
import { Settings } from './screens/Settings'
import { Status } from './screens/Status'
import { CheckInScreen } from './screens/CheckIn'
import { MotionCapture } from './screens/MotionCapture'
import { MotionList, MotionResult } from './screens/MotionResult'

// 3D は重いので必要になった時に読み込む
const View3D = lazy(() => import('./screens/View3D'))

function WithNav({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="pb-[calc(76px+env(safe-area-inset-bottom))]">{children}</div>
      <BottomNav />
    </>
  )
}

function Gate({ children }: { children: ReactNode }) {
  const { settings, loaded } = useSettings()
  const loc = useLocation()
  if (!loaded) return null
  if (!settings.onboarded && !loc.pathname.startsWith('/onboarding')) return <Navigate to="/onboarding" replace />
  return <>{children}</>
}

function UpdatePrompt() {
  // 新しい版があれば自動で更新する（registerType: autoUpdate）
  useRegisterSW({ immediate: true })
  return null
}

export function App() {
  const load = useSettings((s) => s.load)
  useEffect(() => {
    load()
    data.upgradeAll().catch(() => undefined)
    // 保存領域を消されにくくする（対応ブラウザのみ）
    navigator.storage?.persist?.().catch(() => undefined)
  }, [load])

  return (
    <HashRouter>
      <UpdatePrompt />
      <Gate>
        <Suspense fallback={<div className="p-8 text-center text-ink-3">読み込み中…</div>}>
          <Routes>
            <Route path="/" element={<WithNav><Home /></WithNav>} />
            <Route path="/onboarding" element={<Onboarding />} />
            <Route path="/profile" element={<ProfileEdit />} />
            <Route path="/checkin" element={<CheckInScreen />} />
            <Route path="/measure" element={<CaptureGuide />} />
            <Route path="/measure/capture/:plane" element={<Capture />} />
            <Route path="/measure/review/:plane" element={<Review />} />
            <Route path="/measure/analyzing" element={<Analyzing />} />
            <Route path="/measure/conscious/capture/:plane" element={<Capture pose="conscious" />} />
            <Route path="/measure/conscious/review/:plane" element={<Review pose="conscious" />} />
            <Route path="/session/:id" element={<WithNav><Result /></WithNav>} />
            <Route path="/session/:id/edit/:plane" element={<EditSaved />} />
            <Route path="/session/:id/3d" element={<View3D />} />
            <Route path="/compare" element={<WithNav><Compare /></WithNav>} />
            <Route path="/move" element={<WithNav><Move /></WithNav>} />
            <Route path="/move/:routineId" element={<RoutineDetail />} />
            <Route path="/history" element={<WithNav><History /></WithNav>} />
            <Route path="/motion" element={<WithNav><MotionList /></WithNav>} />
            <Route path="/motion/capture" element={<MotionCapture />} />
            <Route path="/motion/:id" element={<WithNav><MotionResult /></WithNav>} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/settings/status" element={<Status />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </Gate>
      <Toast />
    </HashRouter>
  )
}
