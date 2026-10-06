// Renders Bangla text with the bundled Noto Sans Bengali font using the browser's own text shaper,
// which handles conjuncts and vowel signs correctly. Output is a high-resolution PNG label for pdf-lib.
import fontUrl from '../assets/fonts/NotoSansBengali-Regular.ttf?url'

const FAMILY = 'TPB Bengali'
const SCALE = 4
let loading = null

function loadFont() {
  if (!loading) {
    const face = new FontFace(FAMILY, `url(${fontUrl})`)
    loading = face.load().then((f) => {
      document.fonts.add(f)
      return f
    })
    loading.catch(() => {
      loading = null
    })
  }
  return loading
}

// Returns { png, width, height } with width/height in PDF points; baseline sits 28% above the bottom.
export async function renderLabel(text, sizePt, maxWidthPt = Infinity, color = '#1b2533') {
  await loadFont()
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  let size = sizePt
  ctx.font = `${size * SCALE}px "${FAMILY}"`
  const natural = ctx.measureText(text).width / SCALE
  if (natural > maxWidthPt) size = Math.max(6, (size * maxWidthPt) / natural)
  const font = `${size * SCALE}px "${FAMILY}"`
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width) + 8
  const h = Math.ceil(size * SCALE * 1.6)
  canvas.width = w
  canvas.height = h
  ctx.font = font
  ctx.fillStyle = color
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(text, 4, h * 0.72)
  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas'))), 'image/png'))
  return { png: new Uint8Array(await blob.arrayBuffer()), width: w / SCALE, height: h / SCALE }
}
