import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 数字と英字だけ IBM Plex Sans JP を読み込み、日本語は端末の標準フォントで表示する（読み込みを軽くするため）
import '@fontsource/ibm-plex-sans-jp/latin-400.css'
import '@fontsource/ibm-plex-sans-jp/latin-500.css'
import '@fontsource/ibm-plex-sans-jp/latin-700.css'
import './index.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
