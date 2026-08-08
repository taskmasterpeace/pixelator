import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { snap, loadImage } from "../lib/pixelSnap";
import { voxelize, voxelsToOBJ, type DepthProfile, type VoxResult } from "../lib/voxelize";
import { useApp } from "../store";

export default function VoxelizePage() {
  const mount = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const three = useRef<{ scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer; controls: OrbitControls; group: THREE.Group; raf: number } | null>(null);
  const voxRef = useRef<VoxResult | null>(null);
  const spriteForAnimate = useApp((s) => s.spriteForAnimate);

  const [source, setSource] = useState<string | null>(spriteForAnimate);
  const [maxDepth, setMaxDepth] = useState(14);
  const [profile, setProfile] = useState<DepthProfile>("rounded");
  const [gridSize, setGridSize] = useState(48);
  const [autoRotate, setAutoRotate] = useState(true);
  const [count, setCount] = useState(0);
  const [err, setErr] = useState("");

  // one-time Three.js setup
  useEffect(() => {
    const el = mount.current!;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, el.clientWidth / el.clientHeight, 0.1, 2000);
    camera.position.set(40, 30, 70);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.autoRotateSpeed = 2.2;
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(1, 2, 1.5); scene.add(key);
    const rim = new THREE.DirectionalLight(0xf5b21a, 0.5); rim.position.set(-2, 1, -1); scene.add(rim);
    const group = new THREE.Group(); scene.add(group);
    const state = { scene, camera, renderer, controls, group, raf: 0 };
    three.current = state;
    const loop = () => { controls.autoRotate = autoRotateRef.current; controls.update(); renderer.render(scene, camera); state.raf = requestAnimationFrame(loop); };
    loop();
    const onResize = () => { if (!el.clientWidth) return; camera.aspect = el.clientWidth / el.clientHeight; camera.updateProjectionMatrix(); renderer.setSize(el.clientWidth, el.clientHeight); };
    const ro = new ResizeObserver(onResize); ro.observe(el);
    return () => { cancelAnimationFrame(state.raf); ro.disconnect(); controls.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); three.current = null; };
  }, []);

  // keep autoRotate reachable from the render loop without re-subscribing
  const autoRotateRef = useRef(autoRotate);
  useEffect(() => { autoRotateRef.current = autoRotate; }, [autoRotate]);

  useEffect(() => { if (spriteForAnimate) setSource(spriteForAnimate); }, [spriteForAnimate]);

  // (re)build the voxel model when source or params change
  useEffect(() => {
    if (!source || !three.current) return;
    let cancelled = false;
    (async () => {
      try {
        const img = await loadImage(source);
        const res = snap(img, { size: gridSize, colors: 32, mode: "area", removeBg: true, tol: 40 });
        const vox = voxelize(res.imageData, { maxDepth, profile });
        voxRef.current = vox;
        if (cancelled) return;
        buildMesh(three.current!, vox);
        setCount(vox.voxels.length);
      } catch (e: any) { setErr(String(e.message || e)); }
    })();
    return () => { cancelled = true; };
  }, [source, maxDepth, profile, gridSize]);

  const onFile = (f?: File | null) => { if (f) setSource(URL.createObjectURL(f)); };
  const sample = () => setSource(demoBlobDataUrl());
  const exportObj = () => {
    if (!voxRef.current) return;
    const blob = new Blob([voxelsToOBJ(voxRef.current)], { type: "text/plain" });
    const a = document.createElement("a"); a.download = `voxel_${gridSize}.obj`; a.href = URL.createObjectURL(blob); a.click();
  };

  return (
    <div>
      <div className="page-head"><h1>Voxelize</h1><span className="steps">sprite · extrude · rotate</span></div>
      <div className="chips">
        <span className="chip on"><span className="k">2D→3D</span> silhouette extrusion</span>
        <span className="chip"><span className="k">voxels</span> {count.toLocaleString()}</span>
      </div>

      <div className="grid2">
        <div className="stage-wrap">
          <div className="stage-bar"><span className="lbl">Voxel model</span><span className="z">{count ? `${gridSize}³ grid` : "—"}</span></div>
          <div style={{ position: "relative", height: 460, background: "radial-gradient(120% 120% at 50% 20%, #1a2233 0%, #0b0d12 70%)" }}>
            <div ref={mount} style={{ position: "absolute", inset: 0 }} />
            {!source && <div className="hint">Send a sprite from Generate/Pixelate,<br />upload one, or load the demo</div>}
          </div>
        </div>

        <div className="rail">
          <div className="card">
            <h3>Source</h3>
            <div className="btns">
              <button className="act primary" onClick={() => file.current?.click()}>Choose image…</button>
              <button className="act ghost" onClick={sample}>Load demo</button>
            </div>
            <input ref={file} type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          </div>
          <div className="card">
            <h3>Extrusion</h3>
            <div className="field"><div className="row"><label>Depth</label><span className="val">{maxDepth}</span></div>
              <input type="range" min={2} max={40} step={1} value={maxDepth} onChange={(e) => setMaxDepth(+e.target.value)} /></div>
            <div className="field"><div className="row"><label>Grid</label><span className="val">{gridSize}px</span></div>
              <input type="range" min={16} max={96} step={8} value={gridSize} onChange={(e) => setGridSize(+e.target.value)} /></div>
            <div className="field"><div className="row"><label>Profile</label></div>
              <div className="seg">{(["rounded", "flat"] as DepthProfile[]).map((p) => <button key={p} aria-pressed={profile === p} onClick={() => setProfile(p)}>{p}</button>)}</div></div>
            <div className="field">
              <div className="toggle" role="button" tabIndex={0} aria-pressed={autoRotate} onClick={() => setAutoRotate(!autoRotate)} onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); setAutoRotate(!autoRotate); } }}>
                <label>Auto-rotate</label><span className="switch" />
              </div>
            </div>
          </div>
          <div className="card">
            <h3>Export</h3>
            <div className="btns"><button className="act primary" disabled={!count} onClick={exportObj}>⇩ Export OBJ</button></div>
            <div className="muted" style={{ marginTop: 8 }}>Drag to orbit · scroll to zoom. OBJ opens in Blender, Unity, Godot.</div>
            {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

const dummy = new THREE.Object3D();
const col = new THREE.Color();
function buildMesh(s: { scene: THREE.Scene; group: THREE.Group; camera: THREE.PerspectiveCamera; controls: OrbitControls }, vox: VoxResult) {
  // clear previous
  for (const c of [...s.group.children]) { s.group.remove(c); (c as THREE.Mesh).geometry?.dispose?.(); }
  if (!vox.voxels.length) return;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.0 });
  const mesh = new THREE.InstancedMesh(geo, mat, vox.voxels.length);
  // centre on origin
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9, minz = 1e9, maxz = -1e9;
  for (const v of vox.voxels) { minx = Math.min(minx, v.x); maxx = Math.max(maxx, v.x); miny = Math.min(miny, v.y); maxy = Math.max(maxy, v.y); minz = Math.min(minz, v.z); maxz = Math.max(maxz, v.z); }
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, cz = (minz + maxz) / 2;
  vox.voxels.forEach((v, i) => {
    dummy.position.set(v.x - cx, v.y - cy, v.z - cz); dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, col.setRGB((v.r / 255) ** 2.2, (v.g / 255) ** 2.2, (v.b / 255) ** 2.2));
  });
  mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  s.group.add(mesh);
  // frame the camera to the model size
  const span = Math.max(maxx - minx, maxy - miny, 12);
  s.camera.position.set(span * 0.9, span * 0.7, span * 1.5);
  s.controls.target.set(0, 0, 0); s.controls.update();
}

/* a chunky procedural demo sprite (rounded heart-gem) so the page works standalone */
function demoBlobDataUrl(): string {
  const s = 64, c = document.createElement("canvas"); c.width = c.height = s;
  const x = c.getContext("2d")!;
  x.translate(s / 2, s / 2);
  const g = x.createRadialGradient(-8, -8, 4, 0, 0, 34);
  g.addColorStop(0, "#ffd15c"); g.addColorStop(.6, "#f5820a"); g.addColorStop(1, "#b32a12");
  x.fillStyle = g;
  x.beginPath();
  for (let a = 0; a < Math.PI * 2; a += 0.08) { const r = 22 + 6 * Math.sin(a * 5); const px = Math.cos(a) * r, py = Math.sin(a) * r; a === 0 ? x.moveTo(px, py) : x.lineTo(px, py); }
  x.closePath(); x.fill();
  x.fillStyle = "rgba(255,255,255,.85)"; x.beginPath(); x.arc(-9, -9, 5, 0, 7); x.fill();
  return c.toDataURL();
}
