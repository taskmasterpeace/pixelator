import { useApp, type Tab } from "../store";

const CARDS: { id: Tab; ico: string; title: string; desc: string }[] = [
  { id: "generate", ico: "✦", title: "Generate", desc: "Prompt → pixel sprite on Retro Diffusion, cleaned to a transparent grid." },
  { id: "pixelate", ico: "▦", title: "Pixelate", desc: "Drop any image → clean pixel art. Downsample, quantize, corner-key transparency." },
  { id: "animate", ico: "▶", title: "Animate", desc: "Turn a sprite into an N-frame sprite sheet — walk, idle, attack." },
  { id: "tiles", ico: "◫", title: "Tiles", desc: "Seamless tilesets for top-down & sidescroller maps." },
];

export default function HomePage() {
  const setTab = useApp((s) => s.setTab);
  const mock = useApp((s) => s.mock);
  return (
    <div>
      <div className="page-head"><h1>Pixelator</h1><span className="sub">Draw · Generate · Animate — a self-contained pixel-art studio on Retro Diffusion.</span></div>
      <div className="chips">
        <span className={"chip " + (mock ? "" : "on")}><span className="k">engine</span> Retro Diffusion / Replicate</span>
        <span className="chip"><span className="k">mode</span> {mock ? "mock (no token)" : "live"}</span>
      </div>
      <div className="home-grid">
        {CARDS.map((c) => (
          <button key={c.id} className="tile" onClick={() => setTab(c.id)}>
            <div className="big">{c.ico}</div>
            <h4>{c.title}</h4>
            <div className="muted">{c.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
