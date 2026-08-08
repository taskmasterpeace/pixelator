// Pixel Snap engine — the deterministic "clean any image into transparent pixel art" stage.
// Downsample -> median-cut quantize -> corner-key transparency. Pure, reusable, no deps.
// (Ported from tools/pixel-snap.html; this is the module the whole studio shares.)

export type DownsampleMode = "area" | "dominant" | "nearest";
export interface SnapOptions {
  size: number;            // longest side of the output grid
  colors: number;          // palette size (median cut)
  mode: DownsampleMode;
  removeBg: boolean;       // corner flood-fill transparency
  tol: number;             // bg color tolerance (0..120)
}
export interface SnapResult {
  imageData: ImageData;
  w: number;
  h: number;
  palette: [number, number, number][];
}

type Src = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

function srcDims(src: Src): [number, number] {
  if (src instanceof HTMLImageElement) return [src.naturalWidth || src.width, src.naturalHeight || src.height];
  return [src.width, src.height];
}

function targetDims(sw: number, sh: number, size: number): [number, number] {
  const scale = size / Math.max(sw, sh);
  return [Math.max(1, Math.round(sw * scale)), Math.max(1, Math.round(sh * scale))];
}

export function snap(src: Src, o: SnapOptions): SnapResult {
  const [sw, sh] = srcDims(src);
  const [w, h] = targetDims(sw, sh, o.size);

  const small = document.createElement("canvas");
  small.width = w; small.height = h;
  const sc = small.getContext("2d", { willReadFrequently: true })!;

  if (o.mode === "dominant") {
    dominantDownsample(src, sc, w, h);
  } else {
    sc.imageSmoothingEnabled = o.mode === "area";
    sc.imageSmoothingQuality = "high";
    sc.drawImage(src as CanvasImageSource, 0, 0, w, h);
  }

  const img = sc.getImageData(0, 0, w, h);
  const palette = medianCut(img.data, o.colors);
  mapToPalette(img.data, palette);
  if (o.removeBg) cornerKey(img, o.tol);
  return { imageData: img, w, h, palette };
}

function dominantDownsample(src: Src, dctx: CanvasRenderingContext2D, w: number, h: number) {
  const [sw, sh] = srcDims(src);
  const tmp = document.createElement("canvas"); tmp.width = sw; tmp.height = sh;
  const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
  tctx.drawImage(src as CanvasImageSource, 0, 0);
  const sd = tctx.getImageData(0, 0, sw, sh).data;
  const out = dctx.createImageData(w, h);
  const cw = sw / w, ch = sh / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * cw), x1 = Math.min(sw, Math.ceil((x + 1) * cw));
    const y0 = Math.floor(y * ch), y1 = Math.min(sh, Math.ceil((y + 1) * ch));
    const hist = new Map<number, number[]>(); let aa = 0, n = 0;
    for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
      const i = (sy * sw + sx) * 4, a = sd[i + 3];
      const key = ((sd[i] >> 4) << 8) | ((sd[i + 1] >> 4) << 4) | (sd[i + 2] >> 4);
      const e = hist.get(key) || [0, 0, 0, 0, 0];
      e[0] += sd[i]; e[1] += sd[i + 1]; e[2] += sd[i + 2]; e[3] += a; e[4]++; hist.set(key, e);
      aa += a; n++;
    }
    let best: number[] | null = null, bc = -1;
    for (const e of hist.values()) if (e[4] > bc) { bc = e[4]; best = e; }
    const oi = (y * w + x) * 4;
    if (best) { out.data[oi] = best[0] / best[4]; out.data[oi + 1] = best[1] / best[4]; out.data[oi + 2] = best[2] / best[4]; }
    out.data[oi + 3] = n ? Math.round(aa / n) : 0;
  }
  dctx.putImageData(out, 0, 0);
}

function medianCut(data: Uint8ClampedArray, n: number): [number, number, number][] {
  const px: [number, number, number][] = [];
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 16) px.push([data[i], data[i + 1], data[i + 2]]);
  if (px.length === 0) return [[0, 0, 0]];
  let boxes: [number, number, number][][] = [px];
  while (boxes.length < n) {
    let bi = -1, brange = -1;
    boxes.forEach((b, idx) => { if (b.length < 2) return; const r = boxRange(b); if (r.range > brange) { brange = r.range; bi = idx; } });
    if (bi < 0) break;
    const b = boxes[bi], { ch } = boxRange(b);
    b.sort((p, q) => p[ch] - q[ch]);
    const mid = b.length >> 1;
    boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }
  return boxes.map((b) => {
    let r = 0, g = 0, bl = 0; for (const p of b) { r += p[0]; g += p[1]; bl += p[2]; }
    const k = b.length || 1; return [Math.round(r / k), Math.round(g / k), Math.round(bl / k)];
  });
}

function boxRange(b: [number, number, number][]) {
  const mn = [255, 255, 255], mx = [0, 0, 0];
  for (const p of b) for (let c = 0; c < 3; c++) { if (p[c] < mn[c]) mn[c] = p[c]; if (p[c] > mx[c]) mx[c] = p[c]; }
  const r = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
  const ch = r[0] >= r[1] && r[0] >= r[2] ? 0 : r[1] >= r[2] ? 1 : 2;
  return { range: r[ch], ch };
}

function mapToPalette(data: Uint8ClampedArray, pal: [number, number, number][]) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] <= 16) continue;
    let best = 0, bd = 1e9;
    for (let p = 0; p < pal.length; p++) {
      const dr = data[i] - pal[p][0], dg = data[i + 1] - pal[p][1], db = data[i + 2] - pal[p][2];
      const d = dr * dr + dg * dg + db * db; if (d < bd) { bd = d; best = p; }
    }
    data[i] = pal[best][0]; data[i + 1] = pal[best][1]; data[i + 2] = pal[best][2];
  }
}

function cornerKey(img: ImageData, tol: number) {
  const { width: w, height: h, data } = img, t2 = tol * tol * 3, A = 24;
  const bg = new Uint8Array(w * h);
  const seeds: [number, number][] = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  const stack: number[] = [];
  for (const [sx, sy] of seeds) {
    const si = sy * w + sx;
    // Only seed from an OPAQUE corner. If the input already has transparent corners
    // (e.g. Retro Diffusion remove_bg output), there is nothing to key — pass through.
    if (data[si * 4 + 3] <= A) continue;
    const sr = data[si * 4], sg = data[si * 4 + 1], sb = data[si * 4 + 2];
    if (bg[si]) continue;
    stack.length = 0; stack.push(si);
    while (stack.length) {
      const p = stack.pop()!; if (bg[p]) continue;
      const i = p * 4;
      if (data[i + 3] <= A) continue;                 // already transparent → boundary
      const dr = data[i] - sr, dg = data[i + 1] - sg, db = data[i + 2] - sb;
      if (dr * dr + dg * dg + db * db > t2) continue;
      bg[p] = 1;
      const cx = p % w, cy = (p - cx) / w;
      if (cx > 0) stack.push(p - 1); if (cx < w - 1) stack.push(p + 1);
      if (cy > 0) stack.push(p - w); if (cy < h - 1) stack.push(p + w);
    }
  }
  for (let p = 0; p < w * h; p++) if (bg[p]) data[p * 4 + 3] = 0;
}

/* ---- small helpers the UI needs ---- */
export function imageDataToCanvas(img: ImageData): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  c.getContext("2d")!.putImageData(img, 0, 0); return c;
}
export function imageDataToDataUrl(img: ImageData): string {
  return imageDataToCanvas(img).toDataURL("image/png");
}
