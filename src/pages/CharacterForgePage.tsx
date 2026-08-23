import { useEffect, useMemo, useRef, useState } from "react";

import {
  createForgeCharacter,
  createForgeWalk,
  forgeExportUrl,
  getForgeCharacter,
  getForgeHealth,
  pollForgeJob,
  type ForgeCharacterDetail,
  type ForgeHealth,
  type ForgeJob,
} from "../lib/forgeApi";
import {
  FORGE_DIRECTIONS,
  directionFromVector,
  inspectPngHeader,
  type ForgeDirection,
} from "../lib/characterForge";

type ForgeStage = "identity" | "directions" | "walk";

interface SourceMeta {
  width: number;
  height: number;
  hasAlpha: boolean;
}

interface SpriteMetric {
  height: number;
  footY: number;
  centroidX: number;
  paletteSize: number;
}

const DEFAULT_PROMPT = "Weathered road survivor in worn dark travel clothing, restrained silhouette, practical layers, grounded survival-world proportions.";
const WALK_PROMPT = "Walking with restrained survival weight, deliberate alternating steps, stable shoulders and body proportions, no weapon swing, seamless cycle.";

const COMPASS_LABELS: Record<ForgeDirection, string> = {
  south: "S",
  "south-west": "SW",
  west: "W",
  "north-west": "NW",
  north: "N",
  "north-east": "NE",
  east: "E",
  "south-east": "SE",
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Could not read the PNG."));
    reader.readAsDataURL(file);
  });
}

function slugFromName(name: string): string {
  return name
    .replace(/\.[^.]+$/u, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (/^https?:/iu.test(url)) image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not inspect the generated sprite."));
    image.src = url;
  });
}

async function analyzeSprite(url: string): Promise<SpriteMetric | null> {
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let top = canvas.height;
    let bottom = -1;
    let count = 0;
    let sumX = 0;
    const colors = new Set<string>();
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const index = (y * canvas.width + x) * 4;
        if (pixels[index + 3] <= 8) continue;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        sumX += x;
        count += 1;
        if (colors.size < 256) colors.add(`${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`);
      }
    }
    if (count === 0) return null;
    return {
      height: bottom - top + 1,
      footY: bottom,
      centroidX: sumX / count,
      paletteSize: colors.size,
    };
  } catch {
    return null;
  }
}

function findWalk(character: ForgeCharacterDetail | null) {
  return character?.animations.find((animation) =>
    animation.animation_type === "walk-8dir-4f" ||
    animation.display_name === "Walk · 8 directions · 4 frames",
  ) || null;
}

function jobStatusLabel(job: ForgeJob | null): string {
  if (!job) return "standing by";
  if (job.status === "resumable") return "provider still working · safe to resume";
  return job.status;
}

export default function CharacterForgePage() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<ForgeStage>("identity");
  const [health, setHealth] = useState<ForgeHealth | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceMeta, setSourceMeta] = useState<SourceMeta | null>(null);
  const [sourcePalette, setSourcePalette] = useState<string[]>([]);
  const [characterName, setCharacterName] = useState("");
  const [description, setDescription] = useState(DEFAULT_PROMPT);
  const [seed, setSeed] = useState(230823);
  const [seedLocked, setSeedLocked] = useState(true);
  const [job, setJob] = useState<ForgeJob | null>(null);
  const [character, setCharacter] = useState<ForgeCharacterDetail | null>(null);
  const [metrics, setMetrics] = useState<Partial<Record<ForgeDirection, SpriteMetric | null>>>({});
  const [selectedDirection, setSelectedDirection] = useState<ForgeDirection>("south");
  const [frameIndex, setFrameIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void getForgeHealth()
      .then((result) => { if (!cancelled) setHealth(result); })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, []);

  const walk = useMemo(() => findWalk(character), [character]);
  const selectedFrames = useMemo(
    () => walk?.directions.find((direction) => direction.direction === selectedDirection)?.frames || [],
    [selectedDirection, walk],
  );

  useEffect(() => {
    setFrameIndex(0);
    if (selectedFrames.length === 0) return undefined;
    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % selectedFrames.length);
    }, 140);
    return () => window.clearInterval(timer);
  }, [selectedFrames]);

  useEffect(() => {
    if (stage !== "walk") return undefined;
    const pressed = new Set<string>();
    const updateDirection = () => {
      const deltaX = (pressed.has("d") || pressed.has("arrowright") ? 1 : 0)
        - (pressed.has("a") || pressed.has("arrowleft") ? 1 : 0);
      const deltaY = (pressed.has("s") || pressed.has("arrowdown") ? 1 : 0)
        - (pressed.has("w") || pressed.has("arrowup") ? 1 : 0);
      if (deltaX !== 0 || deltaY !== 0) {
        setSelectedDirection((current) => directionFromVector(deltaX, deltaY, current));
      }
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const key = event.key.toLowerCase();
      if (!["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) return;
      event.preventDefault();
      pressed.add(key);
      updateDirection();
    };
    const keyUp = (event: KeyboardEvent) => {
      pressed.delete(event.key.toLowerCase());
      updateDirection();
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, [stage]);

  async function inspectPalette(dataUrl: string) {
    const image = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    const maximum = 96;
    const scale = Math.min(1, maximum / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = new Map<string, number>();
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] <= 8) continue;
      const color = `rgb(${pixels[index]} ${pixels[index + 1]} ${pixels[index + 2]})`;
      counts.set(color, (counts.get(color) || 0) + 1);
    }
    setSourcePalette([...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12).map(([color]) => color));
  }

  async function acceptFile(file: File) {
    setError("");
    if (file.type !== "image/png" && !file.name.toLowerCase().endsWith(".png")) {
      setError("Character Forge accepts PNG files only.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("The source PNG must be 10 MB or smaller.");
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const meta = inspectPngHeader(bytes);
      if (meta.width > 256 || meta.height > 256) {
        throw new Error(`PixelLab reference images are capped at 256×256; this PNG is ${meta.width}×${meta.height}.`);
      }
      const dataUrl = await fileToDataUrl(file);
      setStage("identity");
      setCharacter(null);
      setMetrics({});
      setJob(null);
      setSource(dataUrl);
      setSourceName(file.name);
      setSourceMeta(meta);
      const slug = slugFromName(file.name);
      if (!characterName || characterName === slugFromName(sourceName)) setCharacterName(slug);
      await inspectPalette(dataUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function inspectRotations(detail: ForgeCharacterDetail) {
    const entries = await Promise.all(FORGE_DIRECTIONS.map(async (direction) => {
      const url = detail.rotation_urls?.[direction];
      return [direction, url ? await analyzeSprite(url) : null] as const;
    }));
    setMetrics(Object.fromEntries(entries));
  }

  async function forgeIdentity() {
    if (!source || !characterName.trim() || !health?.configured) return;
    setBusy(true);
    setError("");
    try {
      const queued = await createForgeCharacter({
        name: characterName.trim(),
        sourceName,
        description: description.trim(),
        referenceImage: source,
        seed,
      });
      setJob(queued);
      const completed = await pollForgeJob(queued.id, setJob);
      if (!completed.characterId) throw new Error("PixelLab completed without a character id.");
      const detail = await getForgeCharacter<ForgeCharacterDetail>(completed.characterId);
      setCharacter(detail);
      setStage("directions");
      void inspectRotations(detail);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function forgeWalk() {
    if (!character) return;
    setBusy(true);
    setError("");
    try {
      const queued = await createForgeWalk(character.id, { prompt: WALK_PROMPT, seed });
      setJob(queued);
      const completed = await pollForgeJob(queued.id, setJob);
      if (!completed.characterId) throw new Error("PixelLab completed without a character id.");
      const detail = await getForgeCharacter<ForgeCharacterDetail>(completed.characterId);
      setCharacter(detail);
      setStage("walk");
      setSelectedDirection("south");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const sourceReady = Boolean(source && sourceMeta && characterName.trim() && description.trim());
  const canForge = sourceReady && health?.configured && !busy;
  const disabledReason = !health
    ? "Checking PixelLab v2…"
    : !health.configured
      ? "Add PIXELLAB_API_TOKEN to Pixelator's .env."
      : !source
        ? "Choose the approved south-facing PNG."
        : !characterName.trim()
          ? "Enter an internal character name."
          : !description.trim()
            ? "Describe the locked identity."
            : "";
  const generationCount = health?.balance?.subscription?.generations;
  const creditBalance = health?.balance?.credits?.usd;

  return (
    <div className="forge-page">
      <header className="forge-head">
        <div>
          <div className="forge-eyebrow">Brownstone pipeline · low top-down orthographic</div>
          <h1>Character Forge</h1>
          <p>Lock one approved identity. Inspect every facing. Ship one validated walk set.</p>
        </div>
        <div className={`forge-live ${health?.configured ? "is-live" : ""}`}>
          <span className="forge-live-mark" />
          <div><b>PixelLab v2</b><small>{health?.configured ? "authorized provider" : "not configured"}</small></div>
        </div>
      </header>

      <nav className="forge-steps" aria-label="Character Forge stages">
        {([
          ["identity", "01", "Identity"],
          ["directions", "02", "Directions"],
          ["walk", "03", "Walk + Export"],
        ] as const).map(([id, number, label]) => {
          const disabled = id === "directions" ? !character : id === "walk" ? !walk : false;
          return (
            <button
              key={id}
              className={stage === id ? "is-active" : ""}
              disabled={disabled}
              onClick={() => setStage(id)}
            >
              <span>{number}</span><b>{label}</b>
            </button>
          );
        })}
      </nav>

      <div className="forge-layout">
        <main className="forge-workbench">
          {stage === "identity" && (
            <section className="forge-identity">
              <div
                className={`forge-drop ${dragging ? "is-dragging" : ""} ${source ? "has-source" : ""}`}
                onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  const file = event.dataTransfer.files[0];
                  if (file) void acceptFile(file);
                }}
              >
                {source ? (
                  <>
                    <div className="forge-source-frame"><img src={source} alt="Approved south-facing character source" /></div>
                    <div className="forge-drop-copy">
                      <span className="forge-kicker">source locked · south</span>
                      <strong>{sourceName}</strong>
                      <p>{sourceMeta?.width}×{sourceMeta?.height} PNG · {sourceMeta?.hasAlpha ? "alpha channel" : "opaque source"}</p>
                      <button className="forge-text-button" onClick={() => fileInput.current?.click()}>Replace source</button>
                    </div>
                  </>
                ) : (
                  <button className="forge-empty-drop" onClick={() => fileInput.current?.click()}>
                    <span className="forge-upload-icon">⇧</span>
                    <strong>Drop the approved south-facing PNG</strong>
                    <small>PNG only · maximum 256×256 · raw file preserved</small>
                  </button>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,.png"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void acceptFile(file);
                    event.target.value = "";
                  }}
                />
              </div>

              <div className="forge-identity-form">
                <div className="forge-form-row">
                  <label>
                    <span>Internal character name</span>
                    <input value={characterName} onChange={(event) => setCharacterName(slugFromName(event.target.value))} placeholder="road-survivor" />
                  </label>
                  <label>
                    <span>Generation seed</span>
                    <div className="forge-seed-field">
                      <input
                        type="number"
                        min={0}
                        value={seed}
                        disabled={seedLocked}
                        onChange={(event) => setSeed(Math.max(0, Number(event.target.value) || 0))}
                      />
                      <button onClick={() => setSeedLocked((locked) => !locked)}>{seedLocked ? "Unlock" : "Lock"}</button>
                    </div>
                  </label>
                </div>
                <label>
                  <span>Identity note <em>what must survive every turn</em></span>
                  <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} />
                </label>
                <div className="forge-palette-line">
                  <span>source palette</span>
                  <div>{sourcePalette.length > 0 ? sourcePalette.map((color) => <i key={color} style={{ background: color }} title={color} />) : <small>awaiting source</small>}</div>
                </div>
              </div>
            </section>
          )}

          {stage === "directions" && character && (
            <section>
              <div className="forge-section-title">
                <div><span>rotation review</span><h2>Eight facings. One person.</h2></div>
                <p>Review silhouette, palette, feet, and identity before paying for motion.</p>
              </div>
              <div className="forge-compass-grid">
                {FORGE_DIRECTIONS.map((direction) => {
                  const url = character.rotation_urls?.[direction];
                  const metric = metrics[direction];
                  return (
                    <article key={direction} className={`forge-direction-card forge-dir-${direction}`}>
                      <div className="forge-direction-heading"><b>{COMPASS_LABELS[direction]}</b><span>{direction}</span></div>
                      <div className="forge-direction-sprite">
                        {url ? <img src={url} alt={`${characterName} facing ${direction}`} /> : <span>missing</span>}
                      </div>
                      <dl>
                        <div><dt>height</dt><dd>{metric ? `${metric.height}px` : "review"}</dd></div>
                        <div><dt>foot</dt><dd>{metric ? `y ${metric.footY}` : "—"}</dd></div>
                        <div><dt>colors</dt><dd>{metric ? metric.paletteSize : "—"}</dd></div>
                      </dl>
                    </article>
                  );
                })}
                <div className="forge-compass-core">
                  <span>N</span><b>8</b><small>facings</small><span>S</span>
                </div>
              </div>
            </section>
          )}

          {stage === "walk" && character && (
            <section>
              <div className="forge-section-title">
                <div><span>runtime preview · 140 ms</span><h2>Drive the compass.</h2></div>
                <p>Every direction is four frames. Idle uses frame zero.</p>
              </div>
              <div className="forge-preview-deck">
                <div className="forge-preview-stage">
                  {selectedFrames.length > 0 ? (
                    <img src={selectedFrames[frameIndex]} alt={`${characterName} walking ${selectedDirection}, frame ${frameIndex + 1}`} />
                  ) : (
                    <div className="forge-preview-empty">Walk frames have not been generated.</div>
                  )}
                  <div className="forge-frame-readout"><b>{COMPASS_LABELS[selectedDirection]}</b><span>{selectedDirection}</span><i>{frameIndex + 1}/4</i></div>
                </div>
                <div className="forge-drive-pad" aria-label="Preview direction">
                  {FORGE_DIRECTIONS.map((direction) => (
                    <button
                      key={direction}
                      className={`forge-drive-${direction} ${selectedDirection === direction ? "is-active" : ""}`}
                      onClick={() => setSelectedDirection(direction)}
                      title={direction}
                    >{COMPASS_LABELS[direction]}</button>
                  ))}
                  <div className="forge-drive-core">✥</div>
                </div>
              </div>
              <div className="forge-validation-strip">
                <div><b>8/8</b><span>directions</span></div>
                <div><b>4</b><span>frames each</span></div>
                <div><b>96²</b><span>normalized PNG</span></div>
                <div><b>384×768</b><span>runtime sheet</span></div>
              </div>
            </section>
          )}
        </main>

        <aside className="forge-console">
          <section>
            <div className="forge-console-title"><span>run control</span><b>{jobStatusLabel(job)}</b></div>
            {job && <div className="forge-progress"><i style={{ width: `${job.progress}%` }} /></div>}
            <dl className="forge-run-data">
              <div><dt>provider</dt><dd>PixelLab v2</dd></div>
              <div><dt>view</dt><dd>low top-down</dd></div>
              <div><dt>projection</dt><dd>orthographic</dd></div>
              <div><dt>seed</dt><dd>{seed}</dd></div>
              <div><dt>usage</dt><dd>{job?.usage ? `$${job.usage.toFixed(2)}` : "not charged"}</dd></div>
              {typeof generationCount === "number" && <div><dt>generations</dt><dd>{generationCount}/{health?.balance?.subscription?.total}</dd></div>}
              {typeof creditBalance === "number" && <div><dt>credits</dt><dd>${creditBalance.toFixed(2)}</dd></div>}
            </dl>
            {job?.upstreamJobIds.length ? (
              <div className="forge-provider-ids"><span>accepted provider jobs</span>{job.upstreamJobIds.map((id) => <code key={id}>{id}</code>)}</div>
            ) : null}
          </section>

          <section className="forge-contract">
            <div className="forge-console-title"><span>game contract</span><b>locked</b></div>
            <ol>
              <li><span>01</span><p><b>8 canonical rows</b>South clockwise through south-east.</p></li>
              <li><span>02</span><p><b>4 walk columns</b>Fixed 140 ms playback clock.</p></li>
              <li><span>03</span><p><b>Source preserved</b>Raw provider output never overwritten.</p></li>
              <li><span>04</span><p><b>Validation gate</b>Padding, feet, centroid, palette, hashes.</p></li>
            </ol>
          </section>

          <section className="forge-action-panel">
            {stage === "identity" && (
              <>
                <button className="forge-main-action" disabled={!canForge} aria-disabled={!canForge} onClick={() => void forgeIdentity()}>
                  {busy ? "Forging directions…" : "Forge 8 directions"}
                </button>
                {!canForge && <p>{disabledReason}</p>}
                <small>This submits one paid rotation job only after you click.</small>
              </>
            )}
            {stage === "directions" && (
              <>
                <button className="forge-main-action" disabled={busy} aria-disabled={busy} onClick={() => void forgeWalk()}>
                  {busy ? "Animating 8 directions…" : "Generate 4-frame walk"}
                </button>
                <button className="forge-secondary-action" onClick={() => setStage("identity")}>Back to source</button>
                <small>One request starts eight accepted direction jobs. Resume is automatic.</small>
              </>
            )}
            {stage === "walk" && character && (
              <>
                <a className="forge-main-action" href={forgeExportUrl(character.id)}>Download game package</a>
                <button className="forge-secondary-action" onClick={() => setStage("directions")}>Review directions</button>
                <small>First download validates and packs all 32 frames before the ZIP begins.</small>
              </>
            )}
          </section>

          {error && <div className="forge-error"><b>Forge stopped</b><p>{error}</p></div>}
        </aside>
      </div>
    </div>
  );
}
