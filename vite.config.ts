import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages では https://<user>.github.io/karada-teiten/ で配信する
const PAGES_BASE = '/karada-teiten/'

export default defineConfig(({ command }) => ({
  base: command === 'build' ? PAGES_BASE : '/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'からだ定点 — 姿勢の記録と運動',
        short_name: 'からだ定点',
        description: '写真から姿勢を測り、過去と比べ、次の運動につなげるアプリ。画像は端末内で処理します。',
        lang: 'ja',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#10282F',
        background_color: '#F2F5F4',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // アプリ本体は事前キャッシュ。モデル・WASM・フォントは大きいので使った時にキャッシュする
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        globIgnores: ['**/mediapipe/**', '**/models/**'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /\/(models|mediapipe)\//.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'pose-assets-v1', expiration: { maxEntries: 12 } },
          },
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.woff2'),
            handler: 'CacheFirst',
            options: { cacheName: 'fonts-v1', expiration: { maxEntries: 400 } },
          },
        ],
      },
    }),
  ],
  build: {
    chunkSizeWarningLimit: 1200,
  },
}))
