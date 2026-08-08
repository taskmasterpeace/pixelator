import { useEffect, useRef, useState } from "react";
import { animate, health, type AnimateOut } from "../lib/api";
import { snap, loadImage, imageDataToCanvas } from "../lib/pixelSnap";
import { imgToCanvas, sliceToCanvases, stabilizeFrames, compositeSheet, placeSubject, remapPalette, paletteToDataUrl, rgbToHex, hexToRgb, type GroundMode, type RGB } from "../lib/frames";
import { framesToGif, sliceSheet, downloadGif } from "../lib/gif";
import { saveAsset } from "../lib/assets";
import { useApp } from "../store";

// Retro Diffusion advanced-animation actions (rd_advanced_animation__*)
const ACTIONS = ["attack", "walking", "idle", "jump", "crouch", "destroy", "custom_action", "subtle_motion"];
const SIZES = [64, 128, 192, 256];
// Proven per-action MOTION prompts (validated against RD's own examples + our testing).
// For advanced animations the prompt describes the MOTION; character identity comes from the input image.
// "looping animation" makes the cycle seamless (the suffix that made the shark loop cleanly).
const ACTION_HINTS: Record<string, string> = {
  attack: "attack animation, melee swing, looping animation",
  walking: "walking animation, smooth confident steps, looping animation",
  idle: "idle breathing animation, subtle movement, looping animation",
  jump: "jump animation, crouch then spring up, rising and falling",
  crouch: "crouch animation, ducking down and back up",
  destroy: "death animation, falling and fading out",
  custom_action: "does a backflip: crouches, springs up, tucks knees, full backward rotation, lands on both feet",
  subtle_motion: "subtle ambient motion, gentle sway, looping animation",
};
const HINT_SET = new Set(Object.values(ACTION_HINTS));
// Airborne actions LEAVE the ground mid-animation (verified on a real backflip: feet lift from row 59→43→59).
// Feet-grounding would flatten that arc back to the baseline and kill the jump — so default these to "off".
const AIRBORNE = new Set(["jump", "custom_action"]);
const defaultGround = (a: string): GroundMode => (AIRBORNE.has(a) ? "off" : "feet");

export default function AnimatePage() {
  const play = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const raf = useRef(0);
  const sheetImg = useRef<HTMLImageElement | null>(null);
  const spriteForAnimate = useApp((s) => s.spriteForAnimate);

  const [source, setSource] = useState<string | null>(spriteForAnimate);
  const [prepared, setPrepared] = useState<string | null>(null);
  const [action, setAction] = useState("attack");
  const [topdown, setTopdown] = useState(false); // rd_animation__four_angle_walking (4-dir RPG walk, prompt-driven)
  const [dir, setDir] = useState(0); // which of the 4 directions to preview
  const [frames, setFrames] = useState(8); // 4 (fast) or 8 (smooth, stitched from 2 segments)
  const [size, setSize] = useState(64);
  const [fps, setFps] = useState(10);
  const [groundMode, setGroundMode] = useState<GroundMode>("feet"); // off | centroid | feet (keep feet grounded)
  const [prompt, setPrompt] = useState(ACTION_HINTS.attack); // motion prompt (auto-suggested per action)
  // Frame subject controls — crop/size the subject in the frame
  const [subjectScale, setSubjectScale] = useState(0.7); // fraction of the frame the subject fills (rest = room for motion)
  const [colors, setColors] = useState(24); // palette size for the prepped subject
  const snapRef = useRef<{ img: ImageData; base: RGB[] } | null>(null);
  const [snapVersion, setSnapVersion] = useState(0);
  const [palette, setPalette] = useState<RGB[]>([]); // editable palette (recolor + RD input_palette)
  const [offX, setOffX] = useState(0);
  const [offY, setOffY] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [bgMode, setBgMode] = useState<"transparent" | "extend">("transparent");
  const [engine, setEngine] = useState("pixellab");
  useEffect(() => { health().then((h) => setEngine(h.animate || (h.mock ? "mock" : "rd-animation"))); }, []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [out, setOut] = useState<AnimateOut | null>(null);
  const [playing, setPlaying] = useState(true);
  const [frameIdx, setFrameIdx] = useState(0);
  const frameRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef(0);
  const playAnimation = useApp((s) => s.playAnimation);
  // Live-countdown budget. Real RD runs show time is dominated by server variability, NOT size or frame count
  // (measured: 6f 78s · 16f 143s · 64px/8f 211–246s · 256px/8f 178s · custom_action 294s · four_angle_walking 54s).
  // So: a flat estimate per class beats a size/frames formula (which badly over-estimated big sizes).
  const heavyAction = action === "custom_action" || action === "subtle_motion";
  const estSeconds = topdown ? 60 : engine === "pixellab" ? 40 : (heavyAction ? 300 : 200);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, s % 60)).padStart(2, "0")}`;

  // pull the handed-off sprite in
  useEffect(() => { if (spriteForAnimate) setSource(spriteForAnimate); }, [spriteForAnimate]);

  // when the action changes: auto-suggest its proven motion prompt (unless the user typed their own),
  // and pick a sensible grounding default (airborne actions keep their jump arc; grounded ones lock feet).
  useEffect(() => {
    setPrompt((p) => (!p.trim() || HINT_SET.has(p.trim())) ? (ACTION_HINTS[action] ?? "") : p);
    setGroundMode(defaultGround(action));
  }, [action]);

  // (A) SNAP: clean pixel-snap + bg removal → store the snapped subject + its extracted palette.
  useEffect(() => {
    if (!source) { setPrepared(null); snapRef.current = null; setPalette([]); return; }
    let cancelled = false;
    (async () => {
      const img = await loadImage(source);
      const inner = Math.max(8, Math.round(size * subjectScale));
      const res = snap(img, { size: inner, colors, mode: "area", removeBg: true, tol: 40 });
      if (cancelled) return;
      snapRef.current = { img: res.imageData, base: res.palette };
      setPalette(res.palette.map((c) => [...c] as RGB)); // fresh editable copy
      setSnapVersion((v) => v + 1);
    })();
    return () => { cancelled = true; };
  }, [source, size, subjectScale, colors]);

  // (B) APPLY: recolor to the (possibly edited) palette, then place in the frame. Cheap → palette
  // edits, flip, and position update the preview live without re-snapping.
  useEffect(() => {
    const s = snapRef.current; if (!s) return;
    const recolored = palette.length ? remapPalette(s.img, s.base, palette) : s.img;
    const frame = placeSubject(imageDataToCanvas(recolored), size, { offsetX: offX, offsetY: offY, flipH, flipV, bg: bgMode });
    setPrepared(frame.toDataURL());
  }, [snapVersion, palette, offX, offY, flipH, flipV, bgMode, size]);

  const run = async () => {
    if (!topdown && !prepared) return;
    setBusy(true); setErr(""); setOut(null); cancelAnimationFrame(raf.current);
    setElapsed(0);
    const t0 = performance.now();
    clearInterval(timer.current);
    timer.current = window.setInterval(() => setElapsed(Math.round((performance.now() - t0) / 1000)), 1000);
    try {
      // Top-down 4-direction RPG walk: prompt-driven (no input sprite), returns a 4×4 sheet we play by row.
      if (topdown) {
        const job = await animate({ image: "", action: "four_angle_walking", frames: 16, size: 48, prompt });
        if (job.status !== "succeeded" || !job.output?.sheet) throw new Error(job.error || "top-down walk failed");
        const o = job.output;
        sheetImg.current = await loadImage(o.sheet!);
        setOut(o); // keep the raw 4×4 sheet (no feet-grounding — it's top-down)
        saveAsset({ kind: "animation", name: "top-down walk 4-dir", dataUrl: o.sheet!, meta: { frames: o.frames, size: o.frameW, action: "four_angle_walking", cols: o.cols, rows: o.rows, topdown: true } });
        return;
      }
      const paletteImg = palette.length ? paletteToDataUrl(palette) : undefined; // lock RD to the user's colors
      const job = await animate({ image: prepared!, action, frames, size, prompt, palette: paletteImg });
      if (job.status !== "succeeded" || !job.output) throw new Error(job.error || "animation failed");
      const o = job.output;
      // Unify every provider to an array of frame canvases…
      let fc: HTMLCanvasElement[];
      if (o.frameUrls?.length) fc = (await Promise.all(o.frameUrls.map(loadImage))).map(imgToCanvas);
      else if (o.sheet) fc = sliceToCanvases(await loadImage(o.sheet), o.frames, o.frameW, o.frameH);
      else throw new Error("no frames returned");
      // …stabilize (feet-grounded by default) so the character stays put across frames…
      fc = stabilizeFrames(fc, groundMode);
      // …then composite into the sheet the player + GIF export consume.
      const comp = compositeSheet(fc);
      const output = { sheet: comp.sheet, frames: comp.frames, frameW: comp.frameW, frameH: comp.frameH };
      sheetImg.current = await loadImage(output.sheet);
      setOut(output);
      saveAsset({ kind: "animation", name: `${action} ${output.frames}f`, dataUrl: output.sheet, meta: { frames: output.frames, size, action } });
    } catch (e: any) { setErr(String(e.message || e)); }
    finally { clearInterval(timer.current); setBusy(false); }
  };

  // a fresh animation always starts from frame 0 and auto-plays
  useEffect(() => { frameRef.current = 0; setFrameIdx(0); setPlaying(true); }, [out]);

  // playback — deterministic setInterval ticker. (requestAnimationFrame FREEZES to a static frame
  // when the tab/pane is throttled — the "can't play them" bug. setInterval keeps a steady fps.)
  // grid-aware: RD can return a 4×2 grid; our composited sheet is a 1×N strip.
  useEffect(() => {
    if (!out || !sheetImg.current || !play.current) return;
    const img = sheetImg.current, cv = play.current, ctx = cv.getContext("2d")!; ctx.imageSmoothingEnabled = false;
    const fw = out.frameW, fh = out.frameH;
    const cols = out.topdown ? (out.cols || 4) : Math.max(1, Math.round(img.naturalWidth / fw));
    const rows = out.topdown ? (out.rows || 4) : Math.max(1, Math.round(img.naturalHeight / fh));
    // top-down: play only the selected direction's row; otherwise play the whole sheet in order
    const seq = out.topdown
      ? Array.from({ length: cols }, (_, i) => Math.min(dir, rows - 1) * cols + i)
      : Array.from({ length: Math.max(1, Math.min(out.frames, cols * rows)) }, (_, i) => i);
    const scale = Math.max(1, Math.floor(340 / Math.max(fw, fh)));
    cv.width = fw * scale; cv.height = fh * scale;
    const draw = (fi: number) => { const col = fi % cols, row = Math.floor(fi / cols); ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(img, col * fw, row * fh, fw, fh, 0, 0, cv.width, cv.height); };
    let step = frameRef.current % seq.length;
    draw(seq[step]);                              // draw current frame immediately (also covers paused state)
    if (!playing) return;
    const id = window.setInterval(() => { step = (step + 1) % seq.length; frameRef.current = step; draw(seq[step]); setFrameIdx(step); }, Math.max(40, Math.round(1000 / fps)));
    return () => clearInterval(id);
  }, [out, fps, playing, dir]);

  // replay an already-generated animation handed off from My Assets (saved as a 1×N strip)
  useEffect(() => {
    if (!playAnimation) return;
    (async () => {
      const img = await loadImage(playAnimation.sheet);
      sheetImg.current = img;
      const frames = Math.max(1, playAnimation.frames);
      const fw = Math.round(img.naturalWidth / frames) || playAnimation.size;
      setOut({ sheet: playAnimation.sheet, frames, frameW: fw, frameH: img.naturalHeight });
    })();
  }, [playAnimation]);

  const exportSheet = () => { if (!out?.sheet) return; const a = document.createElement("a"); a.download = `${action}_${out.frames}f_${size}.png`; a.href = out.sheet; a.click(); };
  const exportGif = () => { if (!out || !sheetImg.current) return; downloadGif(framesToGif(sliceSheet(sheetImg.current, out.frames, out.frameW, out.frameH), fps), `${action}_${out.frames}f.gif`); };

  return (
    <div>
      <div className="page-head"><h1>Animate</h1><span className="steps">prep · action · sprite sheet</span></div>
      <div className="chips">
        <span className="chip on"><span className="k">engine</span> {engine}</span>
        <span className="chip"><span className="k">recipe</span> {size}×{size} · {Math.round(subjectScale * 100)}% subject · {bgMode}</span>
      </div>

      <div className="grid2">
        <div className="stage-wrap">
          <div className="stage-bar"><span className="lbl">{out ? `Playback · ${fps} fps` : "Prepared sprite"}</span>
            {out ? <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {out.topdown && ["↓", "←", "→", "↑"].map((d, i) => <button key={i} className="mini" title={`direction ${i + 1}`} style={dir === i ? { borderColor: "var(--gold)", color: "var(--gold)" } : undefined} onClick={() => { setDir(i); frameRef.current = 0; setFrameIdx(0); }}>{d}</button>)}
              <button className="mini" onClick={() => setPlaying((p) => !p)}>{playing ? "⏸ Pause" : "▶ Play"}</button>
              <button className="mini" onClick={() => { frameRef.current = 0; setFrameIdx(0); setPlaying(true); }}>↺ Replay</button>
              <span className="z">{frameIdx + 1}/{out.topdown ? (out.cols || 4) : out.frames}</span>
            </span> : <span className="z" />}</div>
          <div className="stage">
            {out ? <canvas ref={play} /> : busy ? <div className="hint" style={{ width: "72%", maxWidth: 380 }}>
              <div><span className="spinner" /> animating on {engine}…</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 24, color: "var(--gold)", margin: "12px 0 6px" }}>{fmt(elapsed)} <span style={{ fontSize: 13, color: "var(--bone-dim)" }}>/ ~{fmt(estSeconds)}</span></div>
              <div style={{ height: 8, background: "var(--panel-2)", border: "1px solid var(--line)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(100, Math.round((elapsed / estSeconds) * 100))}%`, background: elapsed > estSeconds ? "var(--blood)" : "var(--gold)", transition: "width .4s" }} />
              </div>
              <div style={{ fontSize: 11, color: "var(--bone-dim)", marginTop: 10 }}>{elapsed > estSeconds ? "taking longer than usual — RD is slow right now, hang tight (auto-retries)" : "keep this tab open · RD sprite-sheets take a few minutes"}</div>
            </div> : prepared ? <div style={{ textAlign: "center" }}><img src={prepared} style={{ width: 300, imageRendering: "pixelated", boxShadow: "0 0 0 2px var(--gold)" }} alt="prepared frame" /><div style={{ marginTop: 12, fontFamily: "var(--mono)", fontSize: 11, color: "var(--bone-dim)" }}>frame subject · {size}px — gold box = frame edge (margin = room for motion)</div></div> : <div className="hint">Send a sprite from Generate/Pixelate, or upload one</div>}
          </div>
          {out && <div className="stage-bar" style={{ borderTop: "1px solid var(--line)", borderBottom: 0 }}><span className="lbl">Sprite sheet</span></div>}
          {out?.sheet && <div style={{ padding: 12, overflowX: "auto", background: "#0b0d12" }}><img src={out.sheet} style={{ imageRendering: "pixelated", height: 80 }} alt="sheet" /></div>}
        </div>

        <div className="rail">
          {/* MOTION — primary, at the top so you never scroll to animate */}
          <div className="card">
            <h3>Motion</h3>
            <div className="field">
              <div className="row"><label>Prompt <span style={{ color: "var(--bone-dim)" }}>{topdown ? "(describe the character)" : "(what they're doing)"}</span></label></div>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={topdown ? "e.g. a shark in a martial arts uniform with red gloves" : "e.g. muscular shark boxer throwing a cross punch, side view"} />
            </div>
            <label className="toggle" aria-pressed={topdown} onClick={() => setTopdown(!topdown)} style={{ marginBottom: 14 }}>
              <span>Top-down 4-dir walk <span style={{ color: "var(--bone-dim)", fontSize: 11 }}>RPG · no sprite needed</span></span>
              <span className="switch" />
            </label>
            {topdown
              ? <div className="muted" style={{ marginBottom: 14 }}>16 frames · 48px · 4 directions (↓ ← → ↑) — <span style={{ fontFamily: "var(--mono)" }}>rd_animation__four_angle_walking</span></div>
              : <>
                <div className="pair">
                  <div className="field"><div className="row"><label>Action</label></div>
                    <select value={action} onChange={(e) => setAction(e.target.value)}>{ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}</select></div>
                  <div className="field"><div className="row"><label>Size</label></div>
                    <div className="seg wrap">{SIZES.map((s) => <button key={s} aria-pressed={size === s} onClick={() => setSize(s)}>{s}</button>)}</div></div>
                </div>
                <div className="field"><div className="row"><label>Frames <span style={{ color: "var(--bone-dim)" }}>{frames === 4 ? "fast" : frames >= 12 ? "smoothest" : "smooth"}</span></label></div>
                  <div className="seg">{[4, 6, 8, 10, 12, 16].map((f) => <button key={f} aria-pressed={frames === f} onClick={() => setFrames(f)}>{f}</button>)}</div></div>
              </>}
            <div className="btns"><button className="act primary" disabled={busy || (!topdown && !prepared)} onClick={run}>{busy ? "Animating…" : topdown ? "▶ Walk (4-dir)" : "▶ Animate"}</button></div>
            {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
          </div>

          {/* FRAME SUBJECT — compact, paired */}
          {source && <div className="card">
            <h3>Frame subject</h3>
            <div className="pair">
              <div className="field"><div className="row"><label>Subject</label><span className="val">{Math.round(subjectScale * 100)}%</span></div>
                <input type="range" min={30} max={100} step={2} value={Math.round(subjectScale * 100)} onChange={(e) => setSubjectScale(+e.target.value / 100)} /></div>
              <div className="field"><div className="row"><label>Colors</label><span className="val">{colors}</span></div>
                <input type="range" min={4} max={64} step={2} value={colors} onChange={(e) => setColors(+e.target.value)} /></div>
            </div>
            {palette.length > 0 && palette.length <= 48 && <div className="field"><div className="row"><label>Palette <span style={{ color: "var(--bone-dim)" }}>(click a swatch to recolor)</span></label></div>
              <div className="swatches">{palette.map((c, i) => <input key={i} type="color" className="sw-edit" value={rgbToHex(c)} title={rgbToHex(c)} onChange={(e) => { const np = palette.map((x) => [...x] as RGB); np[i] = hexToRgb(e.target.value); setPalette(np); }} />)}</div></div>}
            <div className="pair">
              <div className="field"><div className="row"><label>Pos X</label><span className="val">{offX}</span></div>
                <input type="range" min={-Math.round(size / 3)} max={Math.round(size / 3)} step={1} value={offX} onChange={(e) => setOffX(+e.target.value)} /></div>
              <div className="field"><div className="row"><label>Pos Y</label><span className="val">{offY}</span></div>
                <input type="range" min={-Math.round(size / 3)} max={Math.round(size / 3)} step={1} value={offY} onChange={(e) => setOffY(+e.target.value)} /></div>
            </div>
            <div className="pair">
              <div className="field"><div className="row"><label>Flip</label></div>
                <div className="seg"><button aria-pressed={flipH} onClick={() => setFlipH(!flipH)}>⇋ H</button><button aria-pressed={flipV} onClick={() => setFlipV(!flipV)}>⇵ V</button></div></div>
              <div className="field"><div className="row"><label>Background</label></div>
                <div className="seg">{(["transparent", "extend"] as const).map((m) => <button key={m} aria-pressed={bgMode === m} onClick={() => setBgMode(m)}>{m === "extend" ? "Extend" : "Clear"}</button>)}</div></div>
            </div>
            <div className="pair">
              <div className="field"><div className="row"><label>Grounding</label></div>
                <div className="seg">{(["feet", "centroid", "off"] as GroundMode[]).map((m) => <button key={m} aria-pressed={groundMode === m} onClick={() => setGroundMode(m)} title={m === "feet" ? "keep feet level" : m === "centroid" ? "lock to centre" : "no stabilization"}>{m === "feet" ? "Feet" : m === "centroid" ? "Centre" : "Off"}</button>)}</div></div>
              <div className="field"><div className="row"><label>Preview FPS</label><span className="val">{fps}</span></div>
                <input type="range" min={2} max={24} step={1} value={fps} onChange={(e) => setFps(+e.target.value)} /></div>
            </div>
            <div className="pair">
              <button className="act ghost" onClick={() => file.current?.click()}>Upload…</button>
              <button className="act ghost" onClick={() => { setSubjectScale(0.7); setOffX(0); setOffY(0); setFlipH(false); setFlipV(false); setBgMode("transparent"); setGroundMode("feet"); }}>Reset</button>
            </div>
            <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setSource(URL.createObjectURL(f)); }} />
          </div>}

          {/* EXPORT + upload (when no source yet) */}
          <div className="card">
            <h3>Export</h3>
            <div className="pair">
              <button className="act ghost" disabled={!out} onClick={exportGif}>⇩ GIF</button>
              <button className="act ghost" disabled={!out} onClick={exportSheet}>⇩ Sheet</button>
            </div>
            {!source && <div className="btns" style={{ marginTop: 9 }}><button className="act ghost" onClick={() => file.current?.click()}>Upload a sprite…</button><input ref={file} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setSource(URL.createObjectURL(f)); }} /></div>}
          </div>
        </div>
      </div>
    </div>
  );
}
