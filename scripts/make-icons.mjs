// アプリアイコン（下げ振り = 鉛直を測る道具）を PNG と SVG で生成する。外部ライブラリなし
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'icons')
mkdirSync(outDir, { recursive: true })

const INK = [0x10, 0x28, 0x2f]
const PAPER = [0xe9, 0xef, 0xec]
const LEVEL = [0xcd, 0xe1, 0x4b]

// 512 基準の図形。scale で縮める。maskable は内側 80% に収める
function shapes(inset) {
  const s = (v) => inset + v * (1 - (2 * inset) / 512)
  const cx = 256
  return [
    // 吊り元の横棒
    { kind: 'rect', x0: s(cx - 70), y0: s(118), x1: s(cx + 70), y1: s(134), color: PAPER },
    // 糸
    { kind: 'rect', x0: s(cx - 5), y0: s(134), x1: s(cx + 5), y1: s(318), color: PAPER },
    // おもり（下向きのしずく形 = 円 + 三角）
    { kind: 'circle', cx: s(cx), cy: s(350), r: s(46) - s(0), color: LEVEL },
    { kind: 'tri', pts: [[s(cx - 40), s(372)], [s(cx + 40), s(372)], [s(cx), s(430)]], color: LEVEL },
    // 床の線
    { kind: 'rect', x0: s(cx - 120), y0: s(444), x1: s(cx + 120), y1: s(452), color: PAPER },
  ]
}

function inside(shape, x, y) {
  if (shape.kind === 'rect') return x >= shape.x0 && x <= shape.x1 && y >= shape.y0 && y <= shape.y1
  if (shape.kind === 'circle') return (x - shape.cx) ** 2 + (y - shape.cy) ** 2 <= shape.r ** 2
  const [[ax, ay], [bx, by], [cx, cy]] = shape.pts
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

function render(size, { inset = 0, rounded = true } = {}) {
  const list = shapes(inset)
  const k = 512 / size
  const ss = 4
  const px = Buffer.alloc(size * size * 4)
  const radius = rounded ? 112 : 0
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const x = (i + (si + 0.5) / ss) * k
          const y = (j + (sj + 0.5) / ss) * k
          // 角丸の外は透明
          if (radius) {
            const qx = Math.max(radius - x, 0, x - (512 - radius))
            const qy = Math.max(radius - y, 0, y - (512 - radius))
            if (qx * qx + qy * qy > radius * radius) continue
          }
          let c = INK
          for (const s of list) if (inside(s, x, y)) c = s.color
          r += c[0]; g += c[1]; b += c[2]; a += 255
        }
      }
      const n = ss * ss
      const o = (j * size + i) * 4
      const cov = a / 255
      px[o] = cov ? Math.round(r / cov) : 0
      px[o + 1] = cov ? Math.round(g / cov) : 0
      px[o + 2] = cov ? Math.round(b / cov) : 0
      px[o + 3] = Math.round(a / n)
    }
  }
  return encodePng(size, size, px)
}

function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

writeFileSync(join(outDir, 'icon-192.png'), render(192))
writeFileSync(join(outDir, 'icon-512.png'), render(512))
writeFileSync(join(outDir, 'icon-maskable-512.png'), render(512, { inset: 64, rounded: false }))
writeFileSync(join(outDir, 'apple-touch-icon.png'), render(180, { rounded: false }))

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="112" fill="#10282F"/>
<rect x="186" y="118" width="140" height="16" fill="#E9EFEC"/>
<rect x="251" y="134" width="10" height="184" fill="#E9EFEC"/>
<circle cx="256" cy="350" r="46" fill="#CDE14B"/>
<path d="M216 372h80l-40 58z" fill="#CDE14B"/>
<rect x="136" y="444" width="240" height="8" fill="#E9EFEC"/>
</svg>
`
writeFileSync(join(outDir, 'icon.svg'), svg)
console.log('[make-icons] public/icons を生成しました')
