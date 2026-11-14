import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { ChevronRight, Download, FileUp, Trash2 } from 'lucide-react'
import { ALGORITHM_VERSION } from '../domain/constants'
import { APP_VERSION } from '../domain/session'
import { localDateKey } from '../domain/format'
import { db } from '../data/db'
import { data } from '../data/repo'
import { exportJson, importJson, sessionsToCsv, validateExport } from '../data/exportImport'
import { POSE_MODEL, modelVersion } from '../pose/landmarker'
import { Button, Details, Dialog, Notice, Screen, SectionTitle, Segmented } from '../components/ui'
import { useSettings, useToast } from '../state/stores'
import { download } from '../components/download'

export function Settings() {
  const { settings, update } = useSettings()
  const load = useSettings((s) => s.load)
  const toast = useToast((s) => s.show)
  const fileRef = useRef<HTMLInputElement>(null)
  const [dialog, setDialog] = useState<null | 'enableImages' | 'disableImages' | 'wipe' | 'import'>(null)
  const [includeImages, setIncludeImages] = useState(false)
  const [importFile, setImportFile] = useState<unknown>(null)
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const exportAll = async () => {
    setBusy(true)
    const file = await exportJson(db, { includeImages })
    download(`karada-teiten-${localDateKey()}.json`, new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }))
    setBusy(false)
  }
  const exportCsv = async () => {
    const sessions = await data.listSessions()
    download(`karada-teiten-metrics-${localDateKey()}.csv`, new Blob([sessionsToCsv(sessions)], { type: 'text/csv' }))
  }
  const pickImport = async (file: File | undefined) => {
    if (!file) return
    setImportErrors([])
    try {
      const json = JSON.parse(await file.text())
      const errors = validateExport(json)
      if (errors.length) {
        setImportErrors(errors)
        return
      }
      setImportFile(json)
      setDialog('import')
    } catch {
      setImportErrors(['JSON ファイルとして読み込めませんでした'])
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  const runImport = async (mode: 'replace' | 'merge') => {
    setBusy(true)
    const res = await importJson(db, importFile, mode)
    setBusy(false)
    setDialog(null)
    if (res.ok) {
      await load()
      toast(`読み込みました（測定 ${res.counts!.assessments} 件）`)
    } else setImportErrors(res.errors)
  }

  return (
    <Screen title="設定" back="/">
      <ul className="mt-2 divide-y divide-line border-y border-line">
        <li>
          <Link to="/profile" className="flex min-h-14 items-center justify-between">
            <span>プロフィール</span>
            <ChevronRight aria-hidden className="size-5 text-ink-3" />
          </Link>
        </li>
        <li>
          <Link to="/settings/status" className="flex min-h-14 items-center justify-between">
            <span>できること・まだできないこと</span>
            <ChevronRight aria-hidden className="size-5 text-ink-3" />
          </Link>
        </li>
      </ul>

      <SectionTitle sub="写真は端末の中だけで処理し、外部には送信しません">プライバシー</SectionTitle>
      <label className="flex min-h-14 items-center justify-between gap-3 rounded-[var(--radius-control)] bg-surface px-3.5">
        <span>
          <span className="block font-medium">写真を保存する</span>
          <span className="block text-sm text-ink-3">オフの場合、骨格の点と数値だけを保存します</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="size-6 accent-[var(--color-ink)]"
          checked={settings.saveImages}
          onChange={(e) => setDialog(e.target.checked ? 'enableImages' : 'disableImages')}
        />
      </label>

      <SectionTitle>測定</SectionTitle>
      <Segmented
        legend="セルフタイマーの初期値"
        columns={4}
        value={settings.timerSec}
        onChange={(t) => update('timerSec', t)}
        options={[
          { value: 0, label: 'オフ' },
          { value: 3, label: '3秒' },
          { value: 5, label: '5秒' },
          { value: 10, label: '10秒' },
        ]}
      />

      <SectionTitle sub="データはこの端末のブラウザの中にだけあります。機種変更の前には書き出してください">データ</SectionTitle>
      <div className="space-y-2">
        <label className="flex min-h-11 items-center gap-2 text-[15px]">
          <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={includeImages} onChange={(e) => setIncludeImages(e.target.checked)} />
          保存済みの写真も含める（ファイルが大きくなります）
        </label>
        <Button block icon={<Download aria-hidden className="size-5" />} onClick={exportAll} loading={busy}>
          すべてのデータを書き出す（JSON）
        </Button>
        <Button block icon={<Download aria-hidden className="size-5" />} onClick={exportCsv}>
          測定値を書き出す（CSV）
        </Button>
        <Button block icon={<FileUp aria-hidden className="size-5" />} onClick={() => fileRef.current?.click()}>
          書き出したデータを読み込む（JSON）
        </Button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => pickImport(e.target.files?.[0])} />
        {importErrors.length > 0 && (
          <Notice tone="danger" title="読み込めませんでした（今のデータは変更していません）">
            <ul className="list-disc pl-4">
              {importErrors.slice(0, 6).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Notice>
        )}
      </div>
      <div className="mt-8 border-t border-line pt-6">
        <Button variant="danger" block icon={<Trash2 aria-hidden className="size-5" />} onClick={() => setDialog('wipe')}>
          すべてのデータを削除する
        </Button>
      </div>

      <SectionTitle>このアプリについて</SectionTitle>
      <Details summary="医療診断ではありません">
        このアプリは、写真から推定した体の目印の位置関係を数値にするものです。病気やけがの診断、治療の判断はできません。痛み・しびれ・めまいなどがある場合は、医療機関に相談してください。
      </Details>
      <Details summary="解析の限界">
        骨格の点は MediaPipe Pose Landmarker が服や体の見た目から推定した位置で、骨や関節そのものの位置ではありません。服装・撮影角度・照明・立ち方で値が変わります。基準値（正常範囲）は使わず、測定のばらつきを超える差かどうかと、自分の過去との比較を中心にしています。
      </Details>
      <Details summary="通信について">
        アプリ本体・骨格推定のモデル・フォントはこのサイトから読み込み、写真や測定値を外部へ送ることはありません。
      </Details>
      <Details summary="3D の筋肉の体の出典">
        動きの 3D の「筋肉の体」は、解剖モデル Z-Anatomy（The libre 3D atlas of anatomy、CC BY-SA 4.0。元のモデルは BodyParts3D、The Database Center for Life Science）の筋肉の形を、標準の人体の表面に写した絵です。筋肉の場所を見るためのもので、あなたの筋肉の量や使われ方を表すものではありません。
      </Details>
      <p className="mt-4 text-sm text-ink-3 num">
        アプリ {APP_VERSION} ・ 計算ロジック v{ALGORITHM_VERSION} ・ {modelVersion(POSE_MODEL)}
      </p>

      <Dialog
        open={dialog === 'enableImages'}
        onClose={() => setDialog(null)}
        title="写真を保存しますか"
        actions={
          <>
            <Button variant="primary" block onClick={() => { update('saveImages', true); setDialog(null) }}>
              同意して保存する
            </Button>
            <Button variant="quiet" block onClick={() => setDialog(null)}>
              保存しない
            </Button>
          </>
        }
      >
        これから測る写真を、この端末のブラウザ内に保存します。外部には送信しません。写真を残すと、あとから点の補正をし直したり、写真を並べて比べたりできます。端末を他の人と共有している場合はご注意ください。
      </Dialog>
      <Dialog
        open={dialog === 'disableImages'}
        onClose={() => setDialog(null)}
        title="写真の保存をやめますか"
        actions={
          <>
            <Button variant="danger" block onClick={async () => { await data.deleteAllImages(); await update('saveImages', false); setDialog(null); toast('保存済みの写真を削除しました') }}>
              保存済みの写真も削除する
            </Button>
            <Button variant="secondary" block onClick={() => { update('saveImages', false); setDialog(null) }}>
              保存済みの写真は残す
            </Button>
            <Button variant="quiet" block onClick={() => setDialog(null)}>
              やめる
            </Button>
          </>
        }
      >
        これからの測定では写真を保存しません。骨格の点と数値は残ります。
      </Dialog>
      <Dialog
        open={dialog === 'wipe'}
        onClose={() => setDialog(null)}
        title="すべてのデータを削除しますか"
        actions={
          <>
            <Button variant="danger" block onClick={async () => { await data.wipeAll(); await load(); setDialog(null); window.location.hash = '#/onboarding' }}>
              削除する
            </Button>
            <Button variant="quiet" block onClick={() => setDialog(null)}>
              やめる
            </Button>
          </>
        }
      >
        プロフィール・測定結果・写真・運動の記録・設定をすべて削除します。元に戻せません。必要なら先に書き出してください。
      </Dialog>
      <Dialog
        open={dialog === 'import'}
        onClose={() => setDialog(null)}
        title="データを読み込みます"
        actions={
          <>
            <Button variant="primary" block loading={busy} onClick={() => runImport('merge')}>
              今のデータに追加する
            </Button>
            <Button variant="danger" block loading={busy} onClick={() => runImport('replace')}>
              今のデータを消して置き換える
            </Button>
            <Button variant="quiet" block onClick={() => setDialog(null)}>
              やめる
            </Button>
          </>
        }
      >
        同じ記録がある場合は、読み込むファイルの内容で上書きします。
      </Dialog>
    </Screen>
  )
}
