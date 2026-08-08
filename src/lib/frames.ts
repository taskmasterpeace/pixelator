// Frame post-processing for animations — the difference between "AI frames" and a clean loop.
// The key technique (from PerfectPixel Studio): lock each frame's ALPHA-WEIGHTED CENTROID to the
// frame centre. The torso dominates the centroid, so limbs can extend without the character sliding
// around — kills the jitter that makes AI animation look cheap.

// Flip a canvas horizontally/vertically (nearest-neighbour, pixel-exact).
export function flipCanvas(src: HTMLCanvasElement, flipH: boolean, flipV: boolean): HTMLCanvasElement {
  if (!flipH && !flipV) return src;
  const c = document.createElement("canvas"); c.width = src.width; c.height = src.height;
  const ctx = c.getContext("2d")!; ctx.imageSmoothingEnabled = false;
  ctx.translate(flipH ? src.width : 0, flipV ? src.height : 0);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.drawImage(src, 0, 0);
  return c;
}

// Place a prepared subject onto a frameSize×frameSize canvas: centred + offset, optionally flipped,
// with a transparent or edge-extended background. This is the "Frame subject" crop control.
export function placeSubject(
  subject: HTMLCanvasElement, frameSize: number,
  opts: { offsetX?: number; offsetY?: number; flipH?: boolean; flipV?: boolean; bg?: "transparent" | "extend" }
): HTMLCanvasElement {
  const s = flipCanvas(subject, !!opts.flipH, !!opts.flipV);
  const c = document.createElement("canvas"); c.width = frameSize; c.height = frameSize;
  const ctx = c.getContext("2d")!; ctx.imageSmoothingEnabled = false;
  const dx = Math.round((frameSize - s.width) / 2 + (opts.offsetX || 0));
  const dy = Math.round((frameSize - s.height) / 2 + (opts.offsetY || 0));
  if (opts.bg === "extend") {
    // fill the margin by stretching the subject's edge pixels outward (clamp), then draw the subject on top
    ctx.drawImage(s, 0, 0, 1, s.height, 0, dy, dx + 1, s.height);                       // left
    ctx.drawImage(s, s.width - 1, 0, 1, s.height, dx + s.width - 1, dy, frameSize - (dx + s.width - 1), s.height); // right
    ctx.drawImage(c, 0, dy, frameSize, s.height, 0, 0, frameSize, dy + 1);              // up
    ctx.drawImage(c, 0, dy + s.height - 1, frameSize, 1, 0, dy + s.height - 1, frameSize, frameSize - (dy + s.height - 1)); // down
  }
  ctx.drawImage(s, dx, dy);
  return c;
}

export type RGB = [number, number, number];

// Remap a snapped sprite from one palette to an edited one (pixels already sit on `from` colors,
// so map each to the nearest `from` index and swap in the matching `to` colour).
export function remapPalette(img: ImageData, from: RGB[], to: RGB[]): ImageData {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] <= 16) continue;
    let best = 0, bd = 1e9;
    for (let p = 0; p < from.length; p++) {
      const dr = d[i] - from[p][0], dg = d[i + 1] - from[p][1], db = d[i + 2] - from[p][2];
      const dist = dr * dr + dg * dg + db * db; if (dist < bd) { bd = dist; best = p; }
    }
    const c = to[best] || from[best]; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
  }
  return out;
}

// A tiny PNG whose pixels are the palette colours — used as RD's input_palette to constrain output.
export function paletteToDataUrl(palette: RGB[]): string {
  const c = document.createElement("canvas"); c.width = Math.max(1, palette.length); c.height = 1;
  const ctx = c.getContext("2d")!;
  palette.forEach((p, i) => { ctx.fillStyle = `rgb(${p[0]},${p[1]},${p[2]})`; ctx.fillRect(i, 0, 1, 1); });
  return c.toDataURL("image/png");
}
export const rgbToHex = (c: RGB) => "#" + c.map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0")).join("");
export const hexToRgb = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export function imgToCanvas(img: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = (img as any).naturalWidth || img.width; c.height = (img as any).naturalHeight || img.height;
  const ctx = c.getContext("2d")!; ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0);
  return c;
}

// Slice a sprite sheet (grid, row-major) into per-frame canvases.
export function sliceToCanvases(img: HTMLImageElement, frames: number, frameW: number, frameH: number): HTMLCanvasElement[] {
  const cols = Math.max(1, Math.round(img.naturalWidth / frameW));
  const out: HTMLCanvasElement[] = [];
  for (let f = 0; f < frames; f++) {
    const col = f % cols, row = Math.floor(f / cols);
    const c = document.createElement("canvas"); c.width = frameW; c.height = frameH;
    const ctx = c.getContext("2d")!; ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, col * frameW, row * frameH, frameW, frameH, 0, 0, frameW, frameH);
    out.push(c);
  }
  return out;
}

function centroid(d: Uint8ClampedArray, w: number, h: number): [number, number, number] {
  let sx = 0, sy = 0, sa = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = d[(y * w + x) * 4 + 3];
    if (a > 16) { sx += x * a; sy += y * a; sa += a; }
  }
  return sa ? [sx / sa, sy / sa, sa] : [w / 2, h / 2, 0];
}

export type GroundMode = "off" | "centroid" | "feet";
function bottomRow(d: Uint8ClampedArray, w: number, h: number): number {
  for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 16) return y;
  return h - 1;
}
const shiftCanvas = (cv: HTMLCanvasElement, dx: number, dy: number) => {
  if (dx === 0 && dy === 0) return cv;
  const out = document.createElement("canvas"); out.width = cv.width; out.height = cv.height;
  const octx = out.getContext("2d")!; octx.imageSmoothingEnabled = false; octx.drawImage(cv, dx, dy);
  return out;
};

// Stabilize frames so the character doesn't jitter.
// "centroid": lock the alpha-weighted centroid to the frame centre (good for in-place actions).
// "feet": lock horizontal centroid to centre AND the bottom-most opaque row to a shared baseline —
//   keeps the character GROUNDED (feet level) across frames, what a game engine expects.
export function stabilizeFrames(frames: HTMLCanvasElement[], mode: GroundMode = "feet"): HTMLCanvasElement[] {
  if (!frames.length || mode === "off") return frames;
  const w = frames[0].width, h = frames[0].height;
  const info = frames.map((cv) => { const d = cv.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h).data; const [cx, cy, sa] = centroid(d, w, h); return { cx, cy, sa, bottom: bottomRow(d, w, h) }; });
  const baseline = Math.max(...info.map((i) => i.bottom)); // deepest feet → nothing gets clipped
  return frames.map((cv, i) => {
    const { cx, cy, sa, bottom } = info[i]; if (!sa) return cv;
    const dx = Math.round(w / 2 - cx);
    const dy = mode === "feet" ? Math.round(baseline - bottom) : Math.round(h / 2 - cy);
    return shiftCanvas(cv, dx, dy);
  });
}

// Composite frames into a horizontal sprite sheet (data URL) + metadata for playback/GIF.
export function compositeSheet(frames: HTMLCanvasElement[]): { sheet: string; frameW: number; frameH: number; frames: number } {
  const fw = frames[0].width, fh = frames[0].height;
  const c = document.createElement("canvas"); c.width = fw * frames.length; c.height = fh;
  const ctx = c.getContext("2d")!; ctx.imageSmoothingEnabled = false;
  frames.forEach((f, i) => ctx.drawImage(f, i * fw, 0));
  return { sheet: c.toDataURL("image/png"), frameW: fw, frameH: fh, frames: frames.length };
}
