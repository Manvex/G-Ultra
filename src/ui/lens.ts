// Real refraction at the edge of the navigation droplet: a displacement map generated on canvas,
// applied through backdrop-filter: url(#...). Only Chromium supports this, which means Electron and WebView.
let host: SVGSVGElement | null = null;

function ensureHost(): SVGSVGElement {
  if (host) return host;
  const ns = 'http://www.w3.org/2000/svg';
  host = document.createElementNS(ns, 'svg');
  host.setAttribute('width', '0');
  host.setAttribute('height', '0');
  host.setAttribute('aria-hidden', 'true');
  host.style.position = 'absolute';
  document.body.appendChild(host);
  return host;
}

export function makeLens(id: string, w: number, h: number, radius: number, bezel = 14, scale = 26) {
  const W = Math.max(2, Math.round(w));
  const H = Math.max(2, Math.round(h));
  const r = Math.min(radius, W / 2, H / 2);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const cx = W / 2;
  const cy = H / 2;
  const hx = W / 2 - r;
  const hy = H / 2 - r;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5 - cx;
      const py = y + 0.5 - cy;
      const qx = Math.abs(px) - hx;
      const qy = Math.abs(py) - hy;
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const outside = Math.hypot(ox, oy);
      const d = outside + Math.min(Math.max(qx, qy), 0) - r;
      const depth = Math.min(1, Math.max(0, -d / bezel));
      // Convex profile: strong displacement at the edge, none towards the center.
      const amp = Math.pow(1 - depth, 2.4);
      let nx = 0;
      let ny = 0;
      if (outside > 0) {
        nx = (ox / outside) * Math.sign(px);
        ny = (oy / outside) * Math.sign(py);
      } else if (qx > qy) {
        nx = Math.sign(px);
      } else {
        ny = Math.sign(py);
      }
      const i = (y * W + x) * 4;
      img.data[i] = 127.5 - nx * amp * 127.5;
      img.data[i + 1] = 127.5 - ny * amp * 127.5;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const svg = ensureHost();
  const ns = 'http://www.w3.org/2000/svg';
  svg.querySelector(`#${id}`)?.remove();
  const filter = document.createElementNS(ns, 'filter');
  filter.setAttribute('id', id);
  filter.setAttribute('x', '0');
  filter.setAttribute('y', '0');
  filter.setAttribute('width', '100%');
  filter.setAttribute('height', '100%');
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const fe = document.createElementNS(ns, 'feImage');
  fe.setAttribute('href', canvas.toDataURL());
  fe.setAttribute('x', '0');
  fe.setAttribute('y', '0');
  fe.setAttribute('width', String(W));
  fe.setAttribute('height', String(H));
  fe.setAttribute('preserveAspectRatio', 'none');
  fe.setAttribute('result', 'map');
  const disp = document.createElementNS(ns, 'feDisplacementMap');
  disp.setAttribute('in', 'SourceGraphic');
  disp.setAttribute('in2', 'map');
  disp.setAttribute('scale', String(scale));
  disp.setAttribute('xChannelSelector', 'R');
  disp.setAttribute('yChannelSelector', 'G');
  filter.appendChild(fe);
  filter.appendChild(disp);
  svg.appendChild(filter);
}
