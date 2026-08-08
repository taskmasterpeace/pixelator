import { useRef, useState } from "react";
import { generate } from "../lib/api";
import { snap, loadImage, imageDataToDataUrl, type SnapResult } from "../lib/pixelSnap";
import { reveal } from "./PixelatePage";
import { saveAsset } from "../lib/assets";
import { useApp } from "../store";

// Retro Diffusion style keys (valid across rd_fast & rd_plus).
const STYLES = [
  { id: "default", label: "Default" },
  { id: "retro", label: "Retro" },
  { id: "character_turnaround", label: "Turnaround" },
  { id: "item_sheet", label: "Item sheet" },
  { id: "mc_item", label: "MC Item" },
];
const SIZES = [64, 128, 192, 256];

export default function GeneratePage() {
  const view = useRef<HTMLCanvasElement>(null);
  const raf = useRef(0);
  const resultRef = useRef<SnapResult | null>(null);
  const sendToAnimate = useApp((s) => s.sendToAnimate);
  const mock = useApp((s) => s.mock);

  const [prompt, setPrompt] = useState("full body pixel art character, a rugged boxer, bandaged fists, standing head to toe, side view");
  const [style, setStyle] = useState(STYLES[0].id);
  const [size, setSize] = useState(64);
  const [tier, setTier] = useState<"fast" | "plus">("fast");
  const [viewMode, setViewMode] = useState<"side" | "isometric" | "topdown">("side");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [zoom, setZoom] = useState("—");
  const [done, setDone] = useState(false);
  const [info, setInfo] = useState("");

  const gen = async () => {
    setBusy(true); setErr(""); setDone(false);
    try {
      const job = await generate({ prompt, styleKey: style, size, tier, view: viewMode });
      if (job.status !== "succeeded" || !job.output?.images?.[0]) throw new Error(job.error || "no image returned");
      setInfo(job.output.cost != null ? `cost $${job.output.cost?.toFixed(3)} · balance $${job.output.balance?.toFixed(2)}` : "");
      const img = await loadImage(job.output.images[0]);
      const res = snap(img, { size, colors: 24, mode: "area", removeBg: true, tol: 36 });
      resultRef.current = res;
      if (view.current) reveal(view.current, res, setZoom, raf);
      setDone(true);
      saveAsset({ kind: "image", name: prompt.slice(0, 40), dataUrl: imageDataToDataUrl(res.imageData), meta: { size, engine: `rd_${tier}`, style } });
    } catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  };

  const doExport = () => { const r = resultRef.current; if (!r) return; const a = document.createElement("a"); a.download = `generated_${size}.png`; a.href = imageDataToDataUrl(r.imageData); a.click(); };
  const toAnimate = () => { const r = resultRef.current; if (r) sendToAnimate(imageDataToDataUrl(r.imageData)); };

  return (
    <div>
      <div className="page-head"><h1>Generate</h1><span className="steps">prompt · style · snap</span></div>
      <div className="chips">
        <span className="chip on"><span className="k">engine</span> Retro Diffusion {tier}</span>
        <span className="chip"><span className="k">out</span> {size}×{size} · transparent</span>
        {mock && <span className="chip"><span className="k">mode</span> mock sprite</span>}
      </div>

      <div className="grid2">
        <div className="stage-wrap">
          <div className="stage-bar"><span className="lbl">Result</span><span className="z">{zoom}</span></div>
          <div className="stage">
            <canvas ref={view} width={480} height={480} />
            {!done && <div className="hint">{busy ? <><span className="spinner" /> generating on Retro Diffusion…</> : "describe a sprite → Generate"}</div>}
          </div>
        </div>

        <div className="rail">
          <div className="card">
            <h3>Prompt</h3>
            <div className="field"><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="a rugged boxer, bandaged fists…" /></div>
            <div className="field">
              <div className="row"><label>Style</label></div>
              <select value={style} onChange={(e) => setStyle(e.target.value)}>{STYLES.map((s) => <option key={s.label} value={s.id}>{s.label}</option>)}</select>
            </div>
            <div className="field">
              <div className="row"><label>Size</label></div>
              <div className="seg">{SIZES.map((s) => <button key={s} aria-pressed={size === s} onClick={() => setSize(s)}>{s}</button>)}</div>
            </div>
            <div className="field">
              <div className="row"><label>View</label></div>
              <div className="seg">{(["side", "isometric", "topdown"] as const).map((v) => <button key={v} aria-pressed={viewMode === v} onClick={() => setViewMode(v)}>{v === "side" ? "Side" : v === "isometric" ? "Isometric" : "Top-down"}</button>)}</div>
            </div>
            <div className="field">
              <div className="row"><label>Quality</label></div>
              <div className="seg">{(["fast", "plus"] as const).map((t) => <button key={t} aria-pressed={tier === t} onClick={() => setTier(t)}>{t === "fast" ? "rd-fast" : "rd-plus"}</button>)}</div>
            </div>
          </div>
          <div className="card">
            <h3>Actions</h3>
            <div className="btns">
              <button className="act primary" disabled={busy} onClick={gen}>{busy ? "Generating…" : "✦ Generate"}</button>
              <button className="act ghost" disabled={!done} onClick={toAnimate}>▶ Send to Animate</button>
              <button className="act ghost" disabled={!done} onClick={doExport}>⇩ Export PNG</button>
            </div>
            {info && <div className="muted" style={{ marginTop: 8 }}>{info}</div>}
            {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
