import { useEffect } from "react";
import { useApp, type Tab } from "./store";
import { health } from "./lib/api";
import HomePage from "./pages/HomePage";
import PixelatePage from "./pages/PixelatePage";
import GeneratePage from "./pages/GeneratePage";
import AnimatePage from "./pages/AnimatePage";
import VoxelizePage from "./pages/VoxelizePage";
import TilesPage from "./pages/TilesPage";
import LibraryPage from "./pages/LibraryPage";

const NAV: { group: string; items: { id: Tab; ico: string; label: string; tag?: string }[] }[] = [
  { group: "Studio", items: [
    { id: "home", ico: "▚", label: "Home" },
    { id: "pixelate", ico: "▦", label: "Pixelate" },
  ] },
  { group: "AI Tools", items: [
    { id: "generate", ico: "✦", label: "Generate", tag: "RD" },
    { id: "animate", ico: "▶", label: "Animate", tag: "RD" },
    { id: "voxelize", ico: "◈", label: "Voxelize", tag: "3D" },
    { id: "tiles", ico: "◫", label: "Tiles", tag: "RD" },
  ] },
  { group: "Library", items: [
    { id: "library", ico: "▤", label: "My Assets" },
  ] },
];

export default function App() {
  const { tab, setTab, mock, setMock } = useApp();
  const balance = useApp((s) => s.balance);
  const setBalance = useApp((s) => s.setBalance);
  useEffect(() => { health().then((h) => { setMock(h.mock); if (h.balance != null) setBalance(h.balance); }); }, [setMock, setBalance]);

  return (
    <div className="shell">
      <nav className="side">
        <div className="logo">
          <div className="mk">P</div>
          <div><b>Pixelator</b><small>Pixel Art Studio</small></div>
        </div>
        {NAV.map((g) => (
          <div key={g.group}>
            <div className="navlabel">{g.group}</div>
            {g.items.map((it) => (
              <button key={it.id} className="navbtn" aria-current={tab === it.id} onClick={() => setTab(it.id)}>
                <span className="ico">{it.ico}</span>{it.label}
                {it.tag && <span className="tagnew">{it.tag}</span>}
              </button>
            ))}
          </div>
        ))}
        <div className="spacer" />
        <div className="statusbar" title={mock ? "No RD key — running procedural mock sprites" : "Live: Retro Diffusion direct API"}>
          <span className={"dot " + (mock ? "mock" : "live")} />
          {mock ? "MOCK MODE" : `LIVE · RD${balance != null ? ` · $${balance.toFixed(2)}` : ""}`}
        </div>
      </nav>
      <main className="main">
        {tab === "home" && <HomePage />}
        {tab === "pixelate" && <PixelatePage />}
        {tab === "generate" && <GeneratePage />}
        {tab === "animate" && <AnimatePage />}
        {tab === "voxelize" && <VoxelizePage />}
        {tab === "tiles" && <TilesPage />}
        {tab === "library" && <LibraryPage />}
      </main>
    </div>
  );
}
