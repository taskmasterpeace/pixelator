import { useEffect, useRef, useState } from "react";
import { listAssets, deleteAsset, type Asset } from "../lib/assets";
import { useApp } from "../store";

// Loop a saved sprite-sheet (1×N strip) as a live thumbnail — so animations PLAY in the library,
// not just sit as a static sheet. setInterval, not rAF (steady even when throttled).
function AnimatedThumb({ src, frames, fps = 8 }: { src: string; frames: number; fps?: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let id = 0, f = 0, stop = false;
    const image = new Image();
    image.onload = () => {
      if (stop || !cv.current) return;
      const n = Math.max(1, frames);
      const fw = Math.round(image.naturalWidth / n) || image.naturalHeight;
      const fh = image.naturalHeight;
      const c = cv.current, ctx = c.getContext("2d")!; ctx.imageSmoothingEnabled = false;
      const scale = Math.max(1, Math.floor(120 / Math.max(fw, fh)));
      c.width = fw * scale; c.height = fh * scale;
      const draw = () => { ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(image, f * fw, 0, fw, fh, 0, 0, c.width, c.height); };
      draw();
      id = window.setInterval(() => { f = (f + 1) % n; draw(); }, Math.round(1000 / fps));
    };
    image.src = src;
    return () => { stop = true; clearInterval(id); };
  }, [src, frames, fps]);
  return <canvas ref={cv} style={{ imageRendering: "pixelated", maxWidth: "100%", maxHeight: 120 }} />;
}

export default function LibraryPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [filter, setFilter] = useState<"all" | Asset["kind"]>("all");
  const sendToAnimate = useApp((s) => s.sendToAnimate);
  const openAnimation = useApp((s) => s.openAnimation);
  const setTab = useApp((s) => s.setTab);

  const refresh = () => listAssets().then(setAssets);
  useEffect(() => { refresh(); }, []);

  const shown = assets.filter((a) => filter === "all" || a.kind === filter);
  const download = (a: Asset) => { const el = document.createElement("a"); el.download = `${a.name || a.kind}.png`; el.href = a.dataUrl; el.click(); };
  const remove = async (a: Asset) => { await deleteAsset(a.id); refresh(); };
  const toAnimate = (a: Asset) => { sendToAnimate(a.dataUrl); };
  const playAnim = (a: Asset) => { openAnimation(a.dataUrl, Number(a.meta?.frames) || 8, Number(a.meta?.size) || 64); };
  const toVoxelize = (a: Asset) => { useApp.setState({ spriteForAnimate: a.dataUrl }); setTab("voxelize"); };

  return (
    <div>
      <div className="page-head"><h1>My Assets</h1><span className="sub">{assets.length} saved · stored locally (IndexedDB)</span></div>
      <div className="chips">
        {(["all", "image", "animation", "tile", "voxel"] as const).map((k) => (
          <button key={k} className={"chip " + (filter === k ? "on" : "")} style={{ cursor: "pointer" }} onClick={() => setFilter(k)}>{k}</button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="card" style={{ maxWidth: 520 }}><div className="muted">Nothing here yet. Generate, animate, or make a tile — results are saved automatically.</div></div>
      ) : (
        <div className="home-grid">
          {shown.map((a) => (
            <div key={a.id} className="tile" style={{ cursor: "default" }}>
              <div style={{ background: "#0b0d12", borderRadius: 3, display: "grid", placeItems: "center", height: 130, marginBottom: 10, overflow: "hidden" }}>
                {a.kind === "animation" && a.meta?.frames
                  ? <AnimatedThumb src={a.dataUrl} frames={Number(a.meta.frames)} />
                  : <img src={a.dataUrl} alt={a.name} style={{ imageRendering: "pixelated", maxWidth: "100%", maxHeight: 120 }} />}
              </div>
              <h4 style={{ marginBottom: 4 }}>{a.name || a.kind}</h4>
              <div className="muted" style={{ marginBottom: 8 }}>{a.kind}{a.meta?.frames ? ` · ${a.meta.frames}f` : ""}{a.meta?.size ? ` · ${a.meta.size}px` : ""}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="act ghost" style={{ padding: "6px 8px", boxShadow: "2px 2px 0 var(--shadow)" }} onClick={() => download(a)}>⇩</button>
                {a.kind === "animation" && <button className="act ghost" style={{ padding: "6px 8px", boxShadow: "2px 2px 0 var(--shadow)" }} onClick={() => playAnim(a)}>▶ play</button>}
                {a.kind !== "animation" && <button className="act ghost" style={{ padding: "6px 8px", boxShadow: "2px 2px 0 var(--shadow)" }} onClick={() => toAnimate(a)}>▶ animate</button>}
                {a.kind !== "animation" && <button className="act ghost" style={{ padding: "6px 8px", boxShadow: "2px 2px 0 var(--shadow)" }} onClick={() => toVoxelize(a)}>◈ 3D</button>}
                <button className="act ghost" style={{ padding: "6px 8px", boxShadow: "2px 2px 0 var(--shadow)", color: "var(--blood)" }} onClick={() => remove(a)}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
