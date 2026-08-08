// Animated-GIF export for pixel-art frames, using gifenc (tiny, transparent-aware).
import { GIFEncoder, quantize, applyPalette } from "gifenc";

export interface GifFrame { data: Uint8ClampedArray; w: number; h: number; }

export function framesToGif(frames: GifFrame[], fps: number): Uint8Array {
  const gif = GIFEncoder();
  const delay = Math.max(20, Math.round(1000 / fps));
  for (const f of frames) {
    // rgba4444 keeps alpha so transparent pixels become a transparent palette entry
    const palette = quantize(f.data, 256, { format: "rgba4444" });
    const index = applyPalette(f.data, palette, "rgba4444");
    gif.writeFrame(index, f.w, f.h, { palette, delay, transparent: true, transparentIndex: 0, dispose: 2 });
  }
  gif.finish();
  return gif.bytes();
}

// Slice a sprite sheet (grid, row-major) into per-frame RGBA buffers.
export function sliceSheet(img: HTMLImageElement, frames: number, frameW: number, frameH: number): GifFrame[] {
  const fw = frameW, fh = frameH, cols = Math.max(1, Math.round(img.naturalWidth / fw));
  const c = document.createElement("canvas"); c.width = fw; c.height = fh;
  const ctx = c.getContext("2d", { willReadFrequently: true })!; ctx.imageSmoothingEnabled = false;
  const out: GifFrame[] = [];
  for (let f = 0; f < frames; f++) {
    const col = f % cols, row = Math.floor(f / cols);
    ctx.clearRect(0, 0, fw, fh);
    ctx.drawImage(img, col * fw, row * fh, fw, fh, 0, 0, fw, fh);
    out.push({ data: ctx.getImageData(0, 0, fw, fh).data, w: fw, h: fh });
  }
  return out;
}

export function downloadGif(bytes: Uint8Array, name: string) {
  const blob = new Blob([bytes as unknown as BlobPart], { type: "image/gif" });
  const a = document.createElement("a"); a.download = name; a.href = URL.createObjectURL(blob); a.click();
}
