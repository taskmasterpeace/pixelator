// Pixelator proxy — self-contained internal tool.
// Primary provider: Retro Diffusion DIRECT API (rdpk- key) → real pixel art + animations.
// Falls back to MOCK mode (procedural sprites) when no key is set, so the UI always works.
import express from "express";
import zlib from "node:zlib";

try { process.loadEnvFile(new URL("../.env", import.meta.url)); } catch { /* no .env → mock */ }

const PORT = Number(process.env.PORT) || 8787;
const RD_KEY = process.env.RETRO_DIFFUSION_API_KEY || "";
const RD_BASE = "https://api.retrodiffusion.ai/v1";
const LIVE = !!RD_KEY;
// PixelLab — fast, reliable animation (RD animations are slow/flaky). Preferred for /api/animate when set.
const PIXELLAB_KEY = process.env.PIXELLAB_API_TOKEN || "";
const PIXELLAB_BASE = "https://api.pixellab.ai/v1";
const ANIMATE_PROVIDER = process.env.ANIMATE_PROVIDER || (PIXELLAB_KEY ? "pixellab" : "retrodiffusion");
const USE_PIXELLAB_ANIM = ANIMATE_PROVIDER === "pixellab" && !!PIXELLAB_KEY;

const app = express();
app.use(express.json({ limit: "25mb" }));

/* ------------------------------ job store ------------------------------ */
const jobs = new Map();
let seq = 1;
const newJob = (kind, meta = {}) => {
  const id = `job_${seq++}_${kind}`;
  jobs.set(id, { id, status: "processing", output: null, error: null, kind, meta });
  return id;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ Retro Diffusion ------------------------------ */
const rdHeaders = { "X-RD-Token": RD_KEY, "Content-Type": "application/json" };
// Coax any RD error shape into a readable string.
function msgOf(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (Array.isArray(x)) return x.map(msgOf).filter(Boolean).join("; ");
  if (typeof x === "object") return x.msg || x.message || x.detail && msgOf(x.detail) || x.error && msgOf(x.error) || JSON.stringify(x);
  return String(x);
}
function rdError(status, json, text) {
  return new Error(`RD ${status}: ${msgOf(json?.detail) || msgOf(json) || text}`);
}
// Submit async (RD sync can hold the connection ~100s), then poll the task to completion.
// Retries transient RD failures ("Unable to run inference" / 5xx) — failed charges are refunded.
async function rdInference(body, attempt = 0) {
  try { return await rdInferenceOnce(body); }
  catch (e) {
    const retryable = /unable to run inference|RD 5\d\d|timed out|task failed/i.test(String(e && e.message));
    if (retryable && attempt < 2) { await wait(1500); return rdInference(body, attempt + 1); }
    throw e;
  }
}
async function rdInferenceOnce(body) {
  const sub = await fetch(`${RD_BASE}/inferences`, { method: "POST", headers: rdHeaders, body: JSON.stringify({ ...body, async: true }) });
  const subText = await sub.text(); let subJson; try { subJson = JSON.parse(subText); } catch { subJson = {}; }
  if (!sub.ok) throw rdError(sub.status, subJson, subText);
  if (subJson.base64_images?.length) return subJson;            // in case it answered synchronously
  const taskId = subJson.task_id || subJson.request_id;
  if (!taskId) throw new Error("RD: no task_id returned");
  for (let i = 0; i < 150; i++) {                                // ~6 min ceiling
    await wait(2500);
    const t = await fetch(`${RD_BASE}/inferences/tasks/${taskId}`, { headers: rdHeaders });
    const tText = await t.text(); let tj; try { tj = JSON.parse(tText); } catch { tj = {}; }
    if (!t.ok) throw rdError(t.status, tj, tText);
    // On success the payload is nested under `result` (same shape as a sync response).
    if (tj.status === "succeeded" || tj.status === "completed") return tj.result || tj;
    if (tj.result?.base64_images?.length) return tj.result;
    if (tj.base64_images?.length) return tj;
    if (tj.status === "failed") throw new Error(`RD task failed: ${msgOf(tj.error) || msgOf(tj.detail) || msgOf(tj.message) || "unknown"}`);
  }
  throw new Error("RD task timed out");
}
const stripDataUrl = (s = "") => s.replace(/^data:image\/\w+;base64,/, "");
const asDataUrl = (b64) => `data:image/png;base64,${b64}`;
const pngDims = (b64) => { const b = Buffer.from(b64, "base64"); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
// Prompt-driven animation styles (rd_animation__*): NO input image — the prompt describes the CHARACTER,
// the style makes the motion + multi-direction layout. four_angle_walking = 4 directions × 4 frames (4×4 grid).
const PROMPT_DRIVEN = { four_angle_walking: { style: "rd_animation__four_angle_walking", px: 48, cols: 4, rows: 4 } };

// PixelLab animate-with-text: synchronous, ~4 frames per call. Reliable + fast.
// For 8 frames we request two segments (start_frame_index 0 & 4) with a shared seed so the
// character stays consistent, then concatenate. Segments run in parallel for speed.
async function pixellabSegment({ image, action, size, prompt, n_frames, start_frame_index, seed }) {
  const r = await fetch(`${PIXELLAB_BASE}/animate-with-text`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PIXELLAB_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      image_size: { width: size, height: size },
      description: prompt || "pixel art character",
      action,
      reference_image: { type: "base64", base64: stripDataUrl(image) },
      image_guidance_scale: 4,   // stay faithful to the uploaded sprite's identity
      view: "side", n_frames, start_frame_index, seed,
    }),
  });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = {}; }
  if (!r.ok) throw new Error(`PixelLab ${r.status}: ${msgOf(j.detail) || msgOf(j) || text}`);
  return (j.images || []).map((im) => asDataUrl(im.base64 || im));
}
async function pixellabAnimate({ image, action = "attack", size = 64, prompt = "", frames = 8 }) {
  const seed = 1 + (Math.abs(hashStr(action + size)) % 100000); // deterministic across segments, varied per action
  const segments = frames >= 8 ? [0, 4] : [0];
  const parts = await Promise.all(segments.map((s) => pixellabSegment({ image, action, size, prompt, n_frames: Math.max(4, frames), start_frame_index: s, seed })));
  const frameUrls = parts.flat();
  if (!frameUrls.length) throw new Error("PixelLab returned no frames");
  return { frameUrls };  // client stabilizes + composites into a sheet
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// style dropdown key → RD prompt_style (valid in both fast & plus)
const genStyle = (tier, key) => `${tier === "plus" ? "rd_plus" : "rd_fast"}__${key || "default"}`;

/* ------------------------------ mock (no key) ------------------------------ */
const mk = (w, h) => new Uint8Array(w * h * 4);
const px = (b, w, x, y, r, g, bl, a = 255) => { if (x < 0 || y < 0 || x >= w) return; const i = (y * w + x) * 4; if (i < 0 || i >= b.length) return; b[i] = r; b[i + 1] = g; b[i + 2] = bl; b[i + 3] = a; };
const rect = (b, w, x0, y0, ww, hh, c) => { for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + ww; x++) px(b, w, x, y, c[0], c[1], c[2], c[3] ?? 255); };
const disc = (b, w, cx, cy, r, c) => { for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) px(b, w, x, y, c[0], c[1], c[2], c[3] ?? 255); };
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.subarray(y * w * 4, (y + 1) * w * 4).forEach((v, i) => { raw[y * (w * 4 + 1) + 1 + i] = v; }); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const crcTable = encodePNG._crc || (encodePNG._crc = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })());
  const crc32 = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type, "ascii"); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
const toDataUrl = (w, h, rgba) => "data:image/png;base64," + encodePNG(w, h, rgba).toString("base64");
function drawFighter(w, h, frame, withBg) {
  const b = mk(w, h); const key = [31, 111, 106], skin = [120, 72, 48], shirt = [180, 40, 60], pants = [56, 84, 44], glove = [230, 230, 220];
  if (withBg) rect(b, w, 0, 0, w, h, key);
  const cx = (w / 2) | 0, s = w / 64, S = (n) => Math.max(1, Math.round(n * s));
  const headR = S(7), bodyW = S(16), bodyH = S(20), headY = S(14), bodyY = headY + headR + S(1);
  disc(b, w, cx, headY, headR, skin); rect(b, w, cx - bodyW / 2, bodyY, bodyW, bodyH, shirt);
  rect(b, w, cx - bodyW / 2, bodyY + bodyH, S(6), S(14), pants); rect(b, w, cx + bodyW / 2 - S(6), bodyY + bodyH, S(6), S(14), pants);
  const reach = Math.round((Math.sin((frame / 8) * Math.PI * 2) * 0.5 + 0.5) * S(14));
  rect(b, w, cx + bodyW / 2, bodyY + S(2), S(4) + reach, S(4), skin); disc(b, w, cx + bodyW / 2 + S(4) + reach, bodyY + S(4), S(4), glove);
  rect(b, w, cx - bodyW / 2 - S(4), bodyY + S(6), S(4), S(4), skin); disc(b, w, cx - bodyW / 2 - S(4), bodyY + S(8), S(3), glove);
  return b;
}
const mockGenerate = ({ size = 64 }) => toDataUrl(size, size, drawFighter(size, size, 2, true));
function mockAnimate({ size = 64, frames = 8 }) {
  const sw = size * frames, sheet = mk(sw, size);
  for (let f = 0; f < frames; f++) { const fr = drawFighter(size, size, f, false); for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const si = (y * size + x) * 4, di = (y * sw + (f * size + x)) * 4; sheet[di] = fr[si]; sheet[di + 1] = fr[si + 1]; sheet[di + 2] = fr[si + 2]; sheet[di + 3] = fr[si + 3]; } }
  return { sheet: toDataUrl(sw, size, sheet), frames, frameW: size, frameH: size };
}

/* ------------------------------ routes ------------------------------ */
app.get("/api/health", async (_req, res) => {
  const out = { live: LIVE, mock: !LIVE, provider: LIVE ? "retrodiffusion" : "mock", animate: USE_PIXELLAB_ANIM ? "pixellab" : (LIVE ? "rd-animation" : "mock") };
  if (LIVE) { try { const c = await (await fetch(`${RD_BASE}/inferences/credits`, { headers: { "X-RD-Token": RD_KEY } })).json(); out.balance = c.balance; out.credits = c.credits; } catch { /* ignore */ } }
  res.json(out);
});

app.post("/api/generate", async (req, res) => {
  const { prompt = "", styleKey = "default", size = 64, tier = "fast", seed, view = "side" } = req.body || {};
  const id = newJob("generate", { prompt, size });
  (async () => {
    try {
      if (!LIVE) { await wait(600); jobs.get(id).output = { images: [mockGenerate({ size })] }; }
      else {
        const promptStyle = view === "isometric"
          ? "rd_plus__isometric"
          : view === "topdown"
            ? "rd_plus__topdown_map"
            : genStyle(tier, styleKey);
        const out = await rdInference({ prompt, prompt_style: promptStyle, width: size, height: size, num_images: 1, remove_bg: true, ...(seed != null ? { seed } : {}) });
        jobs.get(id).output = { images: (out.base64_images || []).map(asDataUrl), cost: out.balance_cost, balance: out.remaining_balance };
      }
      jobs.get(id).status = "succeeded";
    } catch (e) { const j = jobs.get(id); j.status = "failed"; j.error = String(e.message || e); }
  })();
  res.json({ id });
});

app.post("/api/animate", async (req, res) => {
  const { image = "", action = "attack", frames = 8, size = 64, prompt = "", palette = "" } = req.body || {};
  const id = newJob("animate", { action, frames, size });
  (async () => {
    try {
      const pd = PROMPT_DRIVEN[action];
      if (pd && LIVE) {
        // prompt-driven (e.g. four_angle_walking): no input image; prompt = the character.
        const out = await rdInference({
          prompt: prompt || "pixel art character",
          prompt_style: pd.style,
          width: pd.px, height: pd.px, num_images: 1,
          return_spritesheet: true, remove_bg: true,
        });
        const b64 = (out.base64_images || [])[0];
        const { w, h } = pngDims(b64);
        const cols = pd.cols, rows = Math.max(1, Math.round(h / (w / cols)));
        jobs.get(id).output = { sheet: asDataUrl(b64), frames: cols * rows, frameW: Math.round(w / cols), frameH: Math.round(h / rows), cols, rows, topdown: true, cost: out.balance_cost, balance: out.remaining_balance };
      }
      else if (USE_PIXELLAB_ANIM) { jobs.get(id).output = await pixellabAnimate({ image, action, size, prompt, frames }); }
      else if (!LIVE) { await wait(900); jobs.get(id).output = mockAnimate({ size, frames }); }
      else {
        const out = await rdInference({
          prompt: prompt || action,
          prompt_style: `rd_advanced_animation__${action}`,
          width: size, height: size, num_images: 1,
          input_image: stripDataUrl(image),
          frames_duration: frames,
          return_spritesheet: true,
          remove_bg: true,                                               // hard 1-bit alpha → clean, grounded frames
          ...(palette ? { input_palette: stripDataUrl(palette) } : {}),  // constrain colors to the user's palette
        });
        jobs.get(id).output = { sheet: asDataUrl((out.base64_images || [])[0]), frames, frameW: size, frameH: size, cost: out.balance_cost, balance: out.remaining_balance };
      }
      jobs.get(id).status = "succeeded";
    } catch (e) { const j = jobs.get(id); j.status = "failed"; j.error = String(e.message || e); }
  })();
  res.json({ id });
});

app.post("/api/tiles", async (req, res) => {
  const { prompt = "", size = 64, seamless = true, kind = "tileset" } = req.body || {};
  const id = newJob("tiles", { prompt, size });
  (async () => {
    try {
      if (!LIVE) { await wait(700); jobs.get(id).output = { images: [mockGenerate({ size })] }; }
      else {
        const out = await rdInference({ prompt, prompt_style: `rd_tile__${kind}`, width: size, height: size, num_images: 1, ...(seamless ? { tile_x: true, tile_y: true } : {}) });
        jobs.get(id).output = { images: (out.base64_images || []).map(asDataUrl), cost: out.balance_cost, balance: out.remaining_balance };
      }
      jobs.get(id).status = "succeeded";
    } catch (e) { const j = jobs.get(id); j.status = "failed"; j.error = String(e.message || e); }
  })();
  res.json({ id });
});

app.get("/api/status/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "no such job" });
  res.json(j);
});

app.get("/api/credits", async (_req, res) => {
  if (!LIVE) return res.json({ mock: true });
  try { res.json(await (await fetch(`${RD_BASE}/inferences/credits`, { headers: { "X-RD-Token": RD_KEY } })).json()); }
  catch (e) { res.status(502).json({ error: String(e) }); }
});

app.listen(PORT, () => console.log(`[pixelator] proxy on :${PORT} — ${LIVE ? "LIVE (Retro Diffusion)" : "MOCK mode (no RD key)"}`));
