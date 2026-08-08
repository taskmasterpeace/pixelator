---
name: pixelator
description: Use when working on the Pixelator pixel-art studio (D:\Pixelator) — building/improving the Animate feature, prompting Retro Diffusion, sprite-sheet grid handling, feet-grounding, isometric/top-down, or running the self-improving loop. Captures the hard-won RD contract, prompting rules, timings, and the real-test methodology so you don't re-learn them.
---

# Pixelator — Retro Diffusion pixel-art studio

Self-contained internal tool at `D:\Pixelator`. Vite + React + TS SPA + a thin Node/Express proxy (`server/index.mjs`) that holds the RD key and exposes a tiny job API the SPA polls. One provider: **Retro Diffusion direct API**. Repo: github.com/taskmasterpeace/pixelator.

**Run:** `npm run dev` → Vite on **:5178** (NOT 5173 — that's a different project), proxy on **:8787**. No key → MOCK mode (procedural sprites) so the UI always works. Live when `.env` has `RETRO_DIFFUSION_API_KEY=rdpk-…` (gitignored — never commit it).

**Golden rules**
- **Never commit secrets.** Before every commit run `git diff --cached | grep -i 'rdpk-'` (the RD key prefix) and confirm `.env` isn't staged — any real key match (not a placeholder) is a leak. Never paste real key characters into tracked files, including docs/examples. History was clean at the public release — keep it that way.
- **RD calls cost money and are slow.** Budget a *few* per task. Learn a format with ONE call, then reuse the fetched sheet for wiring/verification.
- **Actually drive the app and verify with real RD output — don't cut corners.** This is the standing instruction; claims without a real test don't count.

## Retro Diffusion API contract (the gotchas)

Base `https://api.retrodiffusion.ai/v1`, header `X-RD-Token: rdpk-…`. Everything is POST `/v1/inferences`.

- **Always async:** submit `{..., async:true}` → poll `GET /v1/inferences/tasks/{id}` every ~2.5s. Sync holds the connection ~100s and is unreliable.
- **Result nesting:** on success the payload is under **`task.result`** (`result.base64_images`), not top-level. `base64_images` are raw PNG (no `data:` prefix).
- **RD is flaky under load** ("Unable to run inference" → refunded). The proxy's `rdInference` retries transient failures 3×. Balance unchanged after a failure = RD's fault, not your input.
- `remove_bg:true` → hard 1-bit alpha (clean transparent frames, better grounding). `input_palette` = base64 palette PNG → quantizes output to those colors.

## Animation families + grid layouts (VERIFIED)

Sheets come back as a **GRID**, not a strip, and RD publishes no layout — **auto-detect**: `cols = round(sheetW / frameW)`.

| Style | Call shape | Output (verified) | Cost / time |
|---|---|---|---|
| `rd_advanced_animation__{attack,walking,idle,jump,crouch,destroy,subtle_motion}` | needs `input_image` + `frames_duration` + `return_spritesheet:true`; prompt = **MOTION only** | 8f@64px → **256×128 = 4×2** | $0.14 · ~210–250s |
| `rd_advanced_animation__custom_action` | same; prompt = a **kinematic sentence** | 8f@64 → 4×2 | $0.25 · ~294s |
| `rd_animation__four_angle_walking` | **prompt-driven, NO input_image**; prompt = the **CHARACTER**; `width:48` | **192×192 = 4×4 = 16f** (facings ↓←→↑ × 4) | $0.07 · ~54s |
| `rd_animation__8_dir_rotation` | prompt-driven | 80px, 8 facings (turntable, not a walk) | ~$0.25 |

`frames_duration` ∈ {4,6,8,10,12,16} (only 8f grid is proven — see issue #3 to verify others). Sizes 64/128/192/256.

## Prompting rules (from the RD guide + testing)

- **Advanced animations: prompt is MOTION only** — identity comes from `input_image`. Don't restate hair/armor/color (it fights the image). `rd_animation__*` (prompt-driven) is the opposite: prompt describes the **character**.
- **`looping animation` suffix** → seamless loop (what made the shark loop clean).
- **Weight/speed adverbs are the #1 quality lever:** "slow, heavy steps" / "quick, light" / "confident, steady".
- **`custom_action` takes a kinematic arc,** phase by phase: e.g. backflip = "crouches, springs up, tucks knees to chest, full backward rotation in mid-air, lands on both feet".
- Best start frame for advanced anim: **neutral, side-profile, full-body, plain background.** Mid-action start frames extrapolate poorly.
- Per-action defaults live in `ACTION_HINTS` in `src/pages/AnimatePage.tsx` (auto-fill on action change).

## Feet-grounding (the key correctness rule)

`stabilizeFrames(frames, mode)` in `src/lib/frames.ts`. Mode **"feet"** locks each frame's lowest opaque row to a shared baseline + centroid-X to center → character stays planted.

- **Grounded actions (walk/attack/idle/crouch/destroy) → "feet".** Verified: walk keeps feet in a 2px band, 0.4px horizontal drift.
- **Airborne actions (jump/custom_action) → "off".** Feet-grounding FLATTENS the jump arc to the baseline and destroys the flip (proven: backflip `[59,59,59,57,43,51,55,59]` → `[59×8]`). `AIRBORNE` set + `defaultGround(action)` auto-selects this.
- **Top-down (four_angle_walking) → no grounding** (it's overhead; feet-on-ground doesn't apply).
- Anchor **whole-body** centroid-X, not lower-body — whole-body is more stable on a walk (0.4 vs 2.2px). Data disproved the lower-body hunch.

## Isometric / top-down

RD does **static iso only**: `rd_plus__isometric`, `rd_plus__topdown_map` (Generate's View control forces rd_plus; rd_fast has no iso). **No isometric ANIMATION** — advanced-anim is side-view only. For animated top-down use `four_angle_walking`; for true iso walk cycles RD is the wrong tool (evaluate PixelLab `create_8_direction_object`, issue #2).

## Test methodology (how to verify for real)

1. **Drive the app UI** via the in-app browser MCP (`mcp__Claude_Browser__*`) at `http://localhost:5178`. React controlled inputs need the native value setter + a dispatched `input`/`change` event; click nav/buttons via `.click()` on the found element (coordinate clicks on the sidebar are unreliable).
2. **The pane reports `document.hidden`,** so `setInterval`/`rAF` throttle — playback looks frozen even though the frame math is right. Verify by **sampling `canvas.toDataURL()` at two times** (or across dir changes) and comparing, not by watching it move.
3. **Analyze real sheets in Node** (deterministic, no throttle). Reusable scratchpad tooling: `analyze.mjs <sheet> <base> [fps]` decodes RGBA PNG (colorType 6) + reports grounding metrics (bottomRow/centroidX) + emits GIF + strip. NOTE it hardcodes 64px frames — pass/patch for 48px 4-dir sheets. `verify_ground.mjs` proves a stabilization change on real frames; `fourdir_media.mjs` builds 4-dir media.
4. **gifenc in a scratchpad script:** import via `file:///D:/Pixelator/node_modules/gifenc/dist/gifenc.esm.js` (bare specifier won't resolve outside the project).
5. **Proof for the user:** generate GIF + montage in Node and `SendUserFile` them. Browser→base64→Write corrupts PNGs — always make images in Node.

## Self-improving loop checklist (per run)

The `/loop 15m` cron (`b1c9f411`) fires this. Each run: (1) keep Prompt+Action at the TOP, nothing important requires scrolling (verify Animate button bottom < viewport height ~910px); (2) learn from the RD docs + reference tools; (3) obsess over gamer needs — isometric + FEET-LEVEL grounding; (4) run REAL tests (drive app + real RD, verify); (5) one concrete improvement, verified + logged. Never more than a few RD calls per run.

Workflow: read the memory (`pixelator-project.md`) + open GitHub issues → pick the highest-value gap → learn-with-one-RD-call → wire → verify end-to-end → commit (clean msg, no Co-Authored-By) → push → close/comment the issue → log to memory. File new issues for gaps you find but don't fix.

## Architecture map

```
server/index.mjs      proxy → RD (async submit+poll, retry, MOCK fallback, PROMPT_DRIVEN map, remove_bg, input_palette)
src/lib/pixelSnap.ts  snap engine (downsample · median-cut quantize · corner-key alpha)
src/lib/frames.ts     placeSubject · remapPalette · stabilizeFrames (feet/centroid/off) · sliceToCanvases · compositeSheet
src/lib/gif.ts        gifenc GIF export (rgba4444, transparentIndex 0)
src/lib/api.ts        client: start job + poll (safeJson — survives proxy restarts / empty bodies)
src/pages/AnimatePage.tsx  the core: prep → action/prompt → run() → playback (Play/Pause/Replay, per-direction for top-down)
src/store.ts          Zustand (tab, Generate→Animate handoff, openAnimation replay-from-library)
```
