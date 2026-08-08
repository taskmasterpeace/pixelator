import { useRef, useState } from "react";
import { tiles } from "../lib/api";
import { snap, loadImage, imageDataToDataUrl, type SnapResult } from "../lib/pixelSnap";
import { reveal } from "./PixelatePage";
import { saveAsset } from "../lib/assets";
import { useApp } from "../store";

export default function TilesPage() {
  const view = useRef<HTMLCanvasElement>(null);
  const raf = useRef(0);
  const resultRef = useRef<SnapResult | null>(null);
  const mock = useApp((s) => s.mock);

  const [prompt, setPrompt] = useState("mossy dungeon stone floor");
  const [size, setSize] = useState(64);
  const [seamless, setSeamless] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [zoom, setZoom] = useState("—");
  const [done, setDone] = useState(false);
  const [info, setInfo] = useState("");

  const gen = async () => {
    setBusy(true); setErr(""); setDone(false);
    try {
      const job = await tiles({ prompt, size, seamless });
      if (job.status !== "succeeded" || !job.output?.images?.[0]) throw new Error(job.error || "no tile returned");
      if (job.output.cost != null) setInfo(`cost $${job.output.cost.toFixed(3)} · balance $${job.output.balance?.toFixed(2)}`);
      const img = await loadImage(job.output.images[0]);
      const res = snap(img, { size, colors: 32, mode: "area", removeBg: false, tol: 0 });
      resultRef.current = res;
      if (view.current) reveal(view.current, res, setZoom, raf);
      setDone(true);
      saveAsset({ kind: "tile", name: prompt.slice(0, 40), dataUrl: imageDataToDataUrl(res.imageData), meta: { size, seamless } });
    } catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  };
  const doExport = () => { const r = resultRef.current; if (!r) return; const a = document.createElement("a"); a.download = `tile_${size}.png`; a.href = imageDataToDataUrl(r.imageData); a.click(); };

  return (
    <div>
      <div className="page-head"><h1>Tiles</h1><span className="steps">prompt · seamless · export</span></div>
      <div className="chips">
        <span className="chip on"><span className="k">engine</span> rd-tile</span>
        <span className="chip"><span className="k">out</span> {size}×{size}{seamless ? " · seamless" : ""}</span>
        {mock && <span className="chip"><span className="k">mode</span> mock</span>}
      </div>
      <div className="grid2">
        <div className="stage-wrap">
          <div className="stage-bar"><span className="lbl">Tile</span><span className="z">{zoom}</span></div>
          <div className="stage">
            <canvas ref={view} width={480} height={480} />
            {!done && <div className="hint">{busy ? <><span className="spinner" /> generating tile on Retro Diffusion…</> : "describe a surface → Generate"}</div>}
          </div>
        </div>
        <div className="rail">
          <div className="card">
            <h3>Tile</h3>
            <div className="field"><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="mossy dungeon stone floor…" /></div>
            <div className="field"><div className="row"><label>Size</label></div>
              <div className="seg">{[32, 48, 64, 96].map((s) => <button key={s} aria-pressed={size === s} onClick={() => setSize(s)}>{s}</button>)}</div></div>
            <div className="field">
              <div className="toggle" role="button" tabIndex={0} aria-pressed={seamless} onClick={() => setSeamless(!seamless)} onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); setSeamless(!seamless); } }}>
                <label>Seamless (tile_x/y)</label><span className="switch" />
              </div>
            </div>
          </div>
          <div className="card">
            <h3>Actions</h3>
            <div className="btns">
              <button className="act primary" disabled={busy} onClick={gen}>{busy ? "Generating…" : "◫ Generate tile"}</button>
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
