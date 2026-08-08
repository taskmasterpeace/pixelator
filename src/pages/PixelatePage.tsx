import { useEffect, useRef, useState } from "react";
import { snap, loadImage, imageDataToDataUrl, type DownsampleMode, type SnapResult } from "../lib/pixelSnap";
import { useApp } from "../store";

export default function PixelatePage() {
  const view = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const srcRef = useRef<HTMLImageElement | null>(null);
  const resultRef = useRef<SnapResult | null>(null);
  const raf = useRef(0);
  const sendToAnimate = useApp((s) => s.sendToAnimate);

  const [size, setSize] = useState(64);
  const [colors, setColors] = useState(16);
  const [mode, setMode] = useState<DownsampleMode>("area");
  const [removeBg, setRemoveBg] = useState(true);
  const [tol, setTol] = useState(32);
  const [palette, setPalette] = useState<[number, number, number][]>([]);
  const [zoom, setZoom] = useState("—");
  const [hasImg, setHasImg] = useState(false);
  const [drag, setDrag] = useState(false);

  const run = () => {
    const src = srcRef.current, cv = view.current;
    if (!src || !cv) return;
    const res = snap(src, { size, colors, mode, removeBg, tol });
    resultRef.current = res;
    setPalette(res.palette);
    reveal(cv, res, setZoom, raf);
  };
  // re-run whenever a control changes
  useEffect(() => { if (hasImg) run(); /* eslint-disable-next-line */ }, [size, colors, mode, removeBg, tol]);

  const loadUrl = async (url: string) => {
    const img = await loadImage(url);
    srcRef.current = img; setHasImg(true);
    run(); // paint immediately (rAF can be throttled in hidden tabs)
  };
  const onFile = (f?: File | null) => { if (f) loadUrl(URL.createObjectURL(f)); };

  const sample = () => loadUrl(demoGemDataUrl());

  const doExport = () => {
    const r = resultRef.current; if (!r) return;
    const a = document.createElement("a");
    a.download = `pixelator_${r.w}x${r.h}_${colors}c.png`;
    a.href = imageDataToDataUrl(r.imageData); a.click();
  };
  const toAnimate = () => { const r = resultRef.current; if (r) sendToAnimate(imageDataToDataUrl(r.imageData)); };

  return (
    <div>
      <div className="page-head"><h1>Pixelate</h1><span className="steps">drop · tune · download</span></div>
      <div className="muted" style={{ marginBottom: 14 }}>Turn any image into clean pixel art. Downsample → median-cut quantize → corner-key transparency — the exact auto-prep step Animate uses.</div>

      <div className="grid2">
        <div className="stage-wrap">
          <div className="stage-bar"><span className="lbl">Result</span><span className="z">{zoom}</span></div>
          <div className={"stage" + (drag ? " drag" : "")}
            onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); onFile([...e.dataTransfer.files].find((f) => f.type.startsWith("image/"))); }}>
            <canvas ref={view} width={480} height={480} />
            {!hasImg && <div className="hint">drop an image here<br />— or load the demo sprite —</div>}
          </div>
        </div>

        <div className="rail">
          <div className="card">
            <h3>Source</h3>
            <div className="btns">
              <button className="act primary" onClick={() => file.current?.click()}>Choose image…</button>
              <button className="act ghost" onClick={sample}>Load demo sprite</button>
            </div>
            <input ref={file} type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          </div>

          <div className="card">
            <h3>Recipe</h3>
            <Slider label="Target size" val={`${size} px`} min={16} max={160} step={8} value={size} onChange={setSize} />
            <Slider label="Palette colors" val={`${colors}`} min={4} max={64} step={2} value={colors} onChange={setColors} />
            <div className="field">
              <div className="row"><label>Downsample</label></div>
              <div className="seg">
                {(["area", "dominant", "nearest"] as DownsampleMode[]).map((m) => (
                  <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "area" ? "Area avg" : m[0].toUpperCase() + m.slice(1)}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <div className="toggle" role="button" tabIndex={0} aria-pressed={removeBg}
                onClick={() => setRemoveBg(!removeBg)} onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); setRemoveBg(!removeBg); } }}>
                <label>Remove background <span style={{ color: "var(--bone-dim)" }}>(corner key)</span></label>
                <span className="switch" />
              </div>
            </div>
            {removeBg && <Slider label="BG tolerance" val={`${tol}`} min={0} max={120} step={2} value={tol} onChange={setTol} />}
          </div>

          <div className="card">
            <h3>Actions</h3>
            <div className="btns">
              <button className="act primary" disabled={!hasImg} onClick={doExport}>⇩ Export PNG</button>
              <button className="act ghost" disabled={!hasImg} onClick={toAnimate}>▶ Send to Animate</button>
            </div>
          </div>

          <div className="card">
            <h3>Extracted palette</h3>
            <div className="palette">
              {palette.length ? palette.slice().sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2])).map((c, i) => (
                <div key={i} className="sw" style={{ background: `rgb(${c[0]},${c[1]},${c[2]})` }} title={`#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`} />
              )) : <span className="muted">— run to extract —</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Slider({ label, val, min, max, step, value, onChange }: { label: string; val: string; min: number; max: number; step: number; value: number; onChange: (n: number) => void }) {
  return (
    <div className="field">
      <div className="row"><label>{label}</label><span className="val">{val}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
    </div>
  );
}

/* shared reveal: diagonal sweep + per-pixel smoothstep fade */
export function reveal(cv: HTMLCanvasElement, res: SnapResult, setZoom: (s: string) => void, raf: { current: number }) {
  cancelAnimationFrame(raf.current);
  const box = 460, scale = Math.max(1, Math.floor(box / Math.max(res.w, res.h)));
  cv.width = res.w * scale; cv.height = res.h * scale;
  const ctx = cv.getContext("2d")!; ctx.imageSmoothingEnabled = false;
  setZoom(scale * 100 + "%");
  const tiny = document.createElement("canvas"); tiny.width = res.w; tiny.height = res.h;
  const tctx = tiny.getContext("2d")!;
  const src = res.imageData.data, W = res.w, H = res.h, band = 0.22, dur = 700;
  // Paint the final result immediately so it always shows — even if requestAnimationFrame
  // is throttled (hidden tab) or reduced-motion is set. The sweep below is enhancement only.
  tctx.putImageData(res.imageData, 0, 0);
  ctx.drawImage(tiny, 0, 0, cv.width, cv.height);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const t0 = performance.now();
  const frame = (now: number) => {
    const t = Math.min(1, (now - t0) / dur);
    const buf = tctx.createImageData(W, H), d = buf.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, diag = (x / (W - 1 || 1) + y / (H - 1 || 1)) / 2;
      let a = (t - diag) / band; a = a <= 0 ? 0 : a >= 1 ? 1 : a;
      d[i] = src[i]; d[i + 1] = src[i + 1]; d[i + 2] = src[i + 2]; d[i + 3] = Math.round(src[i + 3] * a * a * (3 - 2 * a));
    }
    tctx.putImageData(buf, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(tiny, 0, 0, cv.width, cv.height);
    if (t < 1) raf.current = requestAnimationFrame(frame);
    else { tctx.putImageData(res.imageData, 0, 0); ctx.drawImage(tiny, 0, 0, cv.width, cv.height); }
  };
  raf.current = requestAnimationFrame(frame);
}

/* procedural anti-aliased demo (a glossy gem on a flat key bg) */
function demoGemDataUrl(): string {
  const s = 320, c = document.createElement("canvas"); c.width = c.height = s;
  const x = c.getContext("2d")!;
  x.fillStyle = "#1f6f6a"; x.fillRect(0, 0, s, s);
  x.translate(s / 2, s / 2 + 10);
  const pts = [[0, -110], [92, -40], [60, 96], [-60, 96], [-92, -40]];
  const gem = new Path2D(); gem.moveTo(pts[0][0], pts[0][1]); pts.slice(1).forEach((p) => gem.lineTo(p[0], p[1])); gem.closePath();
  const g = x.createLinearGradient(-90, -110, 90, 110); g.addColorStop(0, "#ff5db1"); g.addColorStop(.5, "#c81e6b"); g.addColorStop(1, "#7a0f45");
  x.fillStyle = g; x.fill(gem);
  x.strokeStyle = "rgba(255,255,255,.55)"; x.lineWidth = 4; x.lineJoin = "round";
  x.beginPath(); x.moveTo(0, -110); x.lineTo(0, 40); x.lineTo(60, 96); x.moveTo(0, 40); x.lineTo(-60, 96); x.stroke();
  const hl = x.createRadialGradient(-30, -50, 4, -30, -50, 70); hl.addColorStop(0, "rgba(255,255,255,.9)"); hl.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = hl; x.beginPath(); x.arc(-30, -50, 60, 0, 7); x.fill();
  return c.toDataURL();
}
