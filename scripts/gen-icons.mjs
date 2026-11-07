// Builds every icon from build/logo-source.jpg: the Windows ICO, the Android launcher icons
// and the logo shown inside the app.
import sharp from 'sharp';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'build', 'logo-source.jpg');
const res = join(root, 'android', 'app', 'src', 'main', 'res');
const LOGO_BG = { r: 7, g: 8, b: 13 };

// Where the logo sits in the 1254 px source.
const MARK = { left: 265, top: 205, width: 725, height: 745 };
const LETTER = { left: 370, top: 372, width: 520, height: 436 };

const { data: src, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });

// Lifts the logo off its dark background: everything lighter than the background keeps its
// color, the background turns transparent, and the edges between them stay smooth.
function cutOut(region) {
  const out = Buffer.alloc(region.width * region.height * 4);
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const i = ((y + region.top) * info.width + x + region.left) * 3;
      const r = src[i];
      const g = src[i + 1];
      const b = src[i + 2];
      const lift = Math.max(r - LOGO_BG.r, g - LOGO_BG.g, b - LOGO_BG.b);
      const alpha = Math.max(0, Math.min(1, (lift - 3) / 9));
      const o = (y * region.width + x) * 4;
      if (alpha > 0) {
        out[o] = Math.min(255, Math.max(0, (r - (1 - alpha) * LOGO_BG.r) / alpha));
        out[o + 1] = Math.min(255, Math.max(0, (g - (1 - alpha) * LOGO_BG.g) / alpha));
        out[o + 2] = Math.min(255, Math.max(0, (b - (1 - alpha) * LOGO_BG.b) / alpha));
      }
      out[o + 3] = alpha * 255;
    }
  }
  return sharp(out, { raw: { width: region.width, height: region.height, channels: 4 } }).png().toBuffer();
}

const markPng = await cutOut(MARK);

// At tiny sizes the cross frame turns into blur, so those sizes show only the letter.
// It's isolated by its brightness: the letter is a solid light surface.
function letterOnly() {
  const r = LETTER;
  const out = Buffer.alloc(r.width * r.height * 4);
  const lit = new Uint8Array(r.width * r.height);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const i = ((y + r.top) * info.width + x + r.left) * 3;
      if (src[i] > 118 && src[i + 1] > 118 && src[i + 2] > 118) lit[y * r.width + x] = 1;
    }
  }
  // Keep the largest connected shape: the letter. Frame pieces are separate, smaller shapes.
  const seen = new Int32Array(lit.length).fill(-1);
  let best = -1;
  let bestSize = 0;
  let label = 0;
  const stack = [];
  for (let s = 0; s < lit.length; s++) {
    if (!lit[s] || seen[s] !== -1) continue;
    let size = 0;
    stack.push(s);
    seen[s] = label;
    while (stack.length) {
      const p = stack.pop();
      size++;
      const x = p % r.width;
      for (const n of [x > 0 ? p - 1 : -1, x < r.width - 1 ? p + 1 : -1, p - r.width, p + r.width]) {
        if (n >= 0 && n < lit.length && lit[n] && seen[n] === -1) {
          seen[n] = label;
          stack.push(n);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = label;
    }
    label++;
  }
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const p = y * r.width + x;
      if (seen[p] !== best) continue;
      const i = ((y + r.top) * info.width + x + r.left) * 3;
      const o = p * 4;
      out[o] = src[i];
      out[o + 1] = src[i + 1];
      out[o + 2] = src[i + 2];
      out[o + 3] = 255;
    }
  }
  return sharp(out, { raw: { width: r.width, height: r.height, channels: 4 } }).png().toBuffer();
}

const letterPng = await letterOnly();

const bgHex = '#07080d';

function roundedMask(size, radius) {
  return Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`);
}

async function placed(art, size, scale) {
  const meta = await sharp(art).metadata();
  const fit = Math.round(size * scale);
  const inner = await sharp(art)
    .resize(fit, fit, { fit: 'inside', kernel: 'lanczos3' })
    .sharpen(size <= 48 ? { sigma: 0.6 } : undefined)
    .toBuffer();
  const m = await sharp(inner).metadata();
  return { input: inner, left: Math.round((size - m.width) / 2), top: Math.round((size - m.height) / 2), meta };
}

// A dark rounded tile, so the silver logo reads on both light and dark taskbars.
async function tile(size) {
  const small = size <= 32;
  const art = small ? letterPng : markPng;
  const scale = small ? 0.82 : 0.84;
  const radius = Math.round(size * 0.2);
  const { input, left, top } = await placed(art, size, scale);
  const base = await sharp({ create: { width: size, height: size, channels: 4, background: bgHex } })
    .composite([
      { input, left, top },
      { input: roundedMask(size, radius), blend: 'dest-in' },
    ])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  return base;
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((x) => x.png)]);
}

// ---- Windows ----
const images = [];
for (const size of [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]) images.push({ size, png: await tile(size) });
writeFileSync(join(root, 'build', 'icon.ico'), ico(images));
writeFileSync(join(root, 'build', 'icon.png'), images[images.length - 1].png);

// ---- inside the app ----
mkdirSync(join(root, 'src', 'assets'), { recursive: true });
await sharp(markPng)
  .resize(160, 160, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(join(root, 'src', 'assets', 'logo.png'));

// ---- Android ----
if (existsSync(res)) {
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [name, d] of Object.entries(densities)) {
    const dir = join(res, `mipmap-${name}`);
    mkdirSync(dir, { recursive: true });
    const legacy = Math.round(48 * d);
    const fg = Math.round(108 * d);

    await sharp(await tile(legacy)).toFile(join(dir, 'ic_launcher.png'));

    const round = await placed(markPng, legacy, 0.72);
    await sharp({ create: { width: legacy, height: legacy, channels: 4, background: bgHex } })
      .composite([{ input: round.input, left: round.left, top: round.top }, { input: roundedMask(legacy, legacy / 2), blend: 'dest-in' }])
      .png({ compressionLevel: 9 })
      .toFile(join(dir, 'ic_launcher_round.png'));

    // The adaptive icon canvas is 108 dp with a 66 dp safe circle; launchers crop the rest.
    // The cross fits that circle at 62 dp tall.
    const fgPlaced = await placed(markPng, fg, 62 / 108);
    await sharp({ create: { width: fg, height: fg, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: fgPlaced.input, left: fgPlaced.left, top: fgPlaced.top }])
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(join(dir, 'ic_launcher_foreground.png'));

    // Android 13+ themed icons recolor a single-color shape.
    const mono = await sharp(fgPlaced.input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = mono.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const light = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
      pixels[i + 3] = Math.round((pixels[i + 3] / 255) * Math.min(255, Math.max(0, (light - 60) * 2)));
      pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
    }
    const monoPng = await sharp(pixels, { raw: { width: mono.info.width, height: mono.info.height, channels: 4 } }).png().toBuffer();
    await sharp({ create: { width: fg, height: fg, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: monoPng, left: fgPlaced.left, top: fgPlaced.top }])
      .png({ compressionLevel: 9 })
      .toFile(join(dir, 'ic_launcher_monochrome.png'));
  }
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`;
  writeFileSync(join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptive);
  writeFileSync(join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptive);
  writeFileSync(join(res, 'values', 'ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${bgHex.toUpperCase()}</color>
</resources>
`);
}

// A contact sheet for checking the small sizes by eye. It stays out of the app.
const sheetDir = process.argv[2];
if (sheetDir) {
  const list = [16, 20, 24, 32, 48, 64, 128, 256];
  const zoom = (s) => (s <= 32 ? 6 : s <= 64 ? 3 : 1);
  let x = 20;
  const parts = [];
  for (const s of list) {
    const png = images.find((i) => i.size === s).png;
    const w = s * zoom(s);
    const big = await sharp(png).resize(w, w, { kernel: 'nearest' }).toBuffer();
    parts.push({ input: big, left: x, top: 20 }, { input: png, left: x, top: 20 + w + 10 });
    x += w + 20;
  }
  const lightHalf = await sharp({ create: { width: x, height: 340, channels: 3, background: '#e6e6e6' } })
    .composite(parts)
    .png()
    .toBuffer();
  const darkHalf = await sharp({ create: { width: x, height: 340, channels: 3, background: '#2a2a2e' } })
    .composite(parts)
    .png()
    .toBuffer();
  await sharp({ create: { width: x, height: 680, channels: 3, background: '#000' } })
    .composite([{ input: lightHalf, left: 0, top: 0 }, { input: darkHalf, left: 0, top: 340 }])
    .png()
    .toFile(join(sheetDir, 'icons-sheet.png'));
  await sharp({ create: { width: 432, height: 432, channels: 3, background: bgHex } })
    .composite([{ input: join(res, 'mipmap-xxxhdpi', 'ic_launcher_foreground.png') }, { input: Buffer.from('<svg width="432" height="432"><circle cx="216" cy="216" r="132" fill="none" stroke="#3f9bff" stroke-width="2"/></svg>') }])
    .png()
    .toFile(join(sheetDir, 'android-fg.png'));
}
console.log('icons generated');
