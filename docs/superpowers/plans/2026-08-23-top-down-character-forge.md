# Top-Down Character Forge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Pixelator workflow that creates, validates, and exports an eight-direction four-frame top-down walk sheet, then make Brownstone Realms render that sheet for local and multiplayer movement.

**Architecture:** Pixelator owns a provider-neutral forge domain, a PixelLab v2 adapter, resumable job records, deterministic normalization/packing, and a three-stage browser workspace. Brownstone consumes only the exported sheet and manifest: movement selects one of eight canonical rows and a shared animation clock selects one of four columns. Provider originals and the current `road-survivor.png` are never overwritten.

**Tech Stack:** React 19, TypeScript 6, Zustand, Vite 8, Express 5, Node's built-in test runner, Sharp, fflate, PixelLab v2 REST API, HTML Canvas 2D, Rust, SpacetimeDB

**Spec:** `docs/superpowers/specs/2026-08-23-top-down-character-forge-design.md`

## Global Constraints

- Brownstone uses low-top-down orthographic art, not an isometric projection.
- Canonical row order is `south`, `south-west`, `west`, `north-west`, `north`, `north-east`, `east`, `south-east`.
- Every direction has exactly four walk frames; every normalized frame is a transparent 96×96 PNG.
- The packed sheet is exactly 384×768 pixels with four columns and eight rows.
- Frame duration is 140 milliseconds and idle renders frame zero.
- Preserve `public/brownstone/characters/road-survivor.png` unchanged.
- Preserve every accepted provider job ID and all raw files; never resubmit a charged request while resuming polling.
- Live forge failures never fall back to procedural mock art.
- Voice, attacks, equipment layers, true isometric projection, model training, and multi-view voxel reconstruction remain outside this slice.
- Do not use PixelZ private source code or private endpoints. Recreate observable workflow behavior with project-owned code and authorized public APIs.

---

## File map

### Pixelator (`D:\\Pixelator`)

- `src/lib/characterForge.ts`: canonical directions, manifest types, direction classification, validation summaries.
- `src/lib/characterForge.test.ts`: sector boundaries and manifest/frame-set validation.
- `src/lib/forgeApi.ts`: typed HTTP client and polling helper for forge routes.
- `src/pages/CharacterForgePage.tsx`: Identity, Directions, and Walk and Export workspace.
- `src/App.tsx`: Character Forge navigation and page routing.
- `src/store.ts`: forge tab and durable in-session forge state.
- `src/styles.css`: high-quality responsive forge layout, compass review, disabled/error states.
- `server/providers/pixellab.mjs`: PixelLab v2 payloads, authenticated requests, and bounded polling.
- `server/providers/pixellab.test.mjs`: adapter request and resume tests with injected `fetch`.
- `server/services/forge-jobs.mjs`: resumable Pixelator job records and orchestration.
- `server/services/forge-jobs.test.mjs`: state transitions, accepted job retention, and failure mapping.
- `server/services/forge-export.mjs`: raw download, Sharp normalization, validation, packing, manifest hashing, ZIP output.
- `server/services/forge-export.test.mjs`: deterministic synthetic-frame normalization and sheet assertions.
- `server/index.mjs`: mount forge routes without changing existing `/api/animate` behavior.
- `package.json` / `package-lock.json`: Node test script plus `sharp` and `fflate` dependencies.

### Brownstone (`D:\\git\\brownstone-realms-game`)

- `client/src/brownstone/game/direction.ts`: canonical direction type, movement-vector classification, animation source rectangle.
- `client/src/brownstone/game/direction.test.ts`: all eight vectors, zero-vector retention, and all 32 sheet cells.
- `client/src/brownstone/game/gameEngine.ts`: facing, movement flags, and animation clock in `PlayerState`.
- `client/src/brownstone/game/gameEngine.test.ts`: movement state and stop behavior.
- `client/src/brownstone/game/persistence.ts`: migrate valid version-one saves missing animation fields.
- `client/src/brownstone/game/persistence.test.ts`: legacy-save migration.
- `client/src/brownstone/game/BrownstoneCanvas.tsx`: emit explicit movement-stop action on key release.
- `client/src/brownstone/game/brownstoneRenderer.ts`: load manifest/sheet and render source rectangles for player and peers.
- `client/src/brownstone/game/brownstoneRenderer.test.ts`: row/column selection at frame boundaries.
- `brownstone-core/src/gameplay.rs`: mirrored `Facing` enum and movement state in serialized Rust game state.
- `brownstone-core/tests/gameplay.rs`: eight directions and stop retention on server-owned state.
- `public/brownstone/characters/road-survivor/walk-8dir-4f.png`: validated packed sheet.
- `public/brownstone/characters/road-survivor/manifest.json`: runtime animation contract.
- `art-source/brownstone/characters/road-survivor/<run-id>/`: source, raw, normalized, sheet, and manifest package.
- `public/brownstone/manifest.json`: versioned character entry pointing to the validated package.

---

### Task 1: Forge domain contract and test harness

**Files:**
- Create: `src/lib/characterForge.ts`
- Create: `src/lib/characterForge.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `ForgeDirection`, `FORGE_DIRECTIONS`, `directionFromVector(deltaX, deltaY, previous)`, `ForgeManifest`, `validateForgeManifest(manifest)`.
- Consumes: no earlier task interfaces.

- [ ] **Step 1: Add the test command and write the failing direction/manifest tests**

Add this script to `package.json`:

```json
"test": "node --experimental-strip-types --test src/**/*.test.ts server/**/*.test.mjs"
```

Create `src/lib/characterForge.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FORGE_DIRECTIONS,
  directionFromVector,
  validateForgeManifest,
  type ForgeManifest,
} from './characterForge.ts';

test('classifies the eight orthographic movement sectors in canonical order', () => {
  const vectors = [[0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1]] as const;
  assert.deepEqual(vectors.map(([x, y]) => directionFromVector(x, y, 'south')), FORGE_DIRECTIONS);
  assert.equal(directionFromVector(0, 0, 'north-east'), 'north-east');
});

test('accepts only the 4 by 8, 96 pixel runtime contract', () => {
  const manifest: ForgeManifest = {
    schemaVersion: 1,
    characterId: 'road-survivor',
    runId: 'run_20260823_001',
    provider: 'pixellab-v2',
    source: { name: 'road-survivor.png', sha256: 'a'.repeat(64) },
    prompt: 'low top-down road survivor walking with restrained survival weight',
    seed: 230823,
    directions: [...FORGE_DIRECTIONS],
    frameWidth: 96,
    frameHeight: 96,
    frameCount: 4,
    frameDurationMs: 140,
    sheet: { path: 'sheets/walk-8dir-4f.png', width: 384, height: 768, sha256: 'b'.repeat(64) },
    rawPath: 'raw',
    normalizedPath: 'normalized',
  };
  assert.deepEqual(validateForgeManifest(manifest), []);
  assert.match(validateForgeManifest({ ...manifest, frameCount: 3 })[0], /four frames/i);
});
```

- [ ] **Step 2: Run the test and confirm the missing module failure**

Run: `npm test -- --test-name-pattern="orthographic|4 by 8"`

Expected: FAIL because `src/lib/characterForge.ts` does not exist.

- [ ] **Step 3: Implement the canonical domain model**

Create `src/lib/characterForge.ts` with these public definitions and deterministic classifier:

```ts
export const FORGE_DIRECTIONS = [
  'south', 'south-west', 'west', 'north-west',
  'north', 'north-east', 'east', 'south-east',
] as const;

export type ForgeDirection = typeof FORGE_DIRECTIONS[number];

export interface ForgeManifest {
  schemaVersion: 1;
  characterId: string;
  runId: string;
  provider: 'pixellab-v2';
  source: { name: string; sha256: string };
  prompt: string;
  seed: number;
  directions: ForgeDirection[];
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  frameDurationMs: number;
  sheet: { path: string; width: number; height: number; sha256: string };
  rawPath: string;
  normalizedPath: string;
}

export function directionFromVector(
  deltaX: number,
  deltaY: number,
  previous: ForgeDirection = 'south',
): ForgeDirection {
  if (deltaX === 0 && deltaY === 0) return previous;
  const clockwiseFromSouth = Math.atan2(-deltaX, deltaY);
  const sector = Math.round(clockwiseFromSouth / (Math.PI / 4));
  return FORGE_DIRECTIONS[(sector + 8) % 8];
}

export function validateForgeManifest(manifest: ForgeManifest): string[] {
  const errors: string[] = [];
  if (manifest.directions.length !== 8 || FORGE_DIRECTIONS.some((direction, index) => manifest.directions[index] !== direction)) {
    errors.push('Directions must contain all eight canonical rows in order.');
  }
  if (manifest.frameCount !== 4) errors.push('Every direction must contain exactly four frames.');
  if (manifest.frameWidth !== 96 || manifest.frameHeight !== 96) errors.push('Frames must be 96 by 96 pixels.');
  if (manifest.sheet.width !== 384 || manifest.sheet.height !== 768) errors.push('Sheet must be 384 by 768 pixels.');
  return errors;
}
```

- [ ] **Step 4: Run the focused and full Pixelator tests**

Run: `npm test`

Expected: PASS with both domain tests green.

- [ ] **Step 5: Commit the domain contract**

```powershell
git add package.json src/lib/characterForge.ts src/lib/characterForge.test.ts
git -c commit.gpgsign=false commit --no-verify -m "Add character forge domain contract"
```

---

### Task 2: Authorized PixelLab v2 provider adapter

**Files:**
- Create: `server/providers/pixellab.mjs`
- Create: `server/providers/pixellab.test.mjs`

**Interfaces:**
- Consumes: canonical string values from `FORGE_DIRECTIONS` by duplicated JSON-safe constants on the server boundary.
- Produces: `createPixelLabClient({ token, fetchImpl, sleep })` with `getBalance()`, `createCharacter(input)`, `getCharacter(id)`, `animateWalk(input)`, `pollJob(id, options)`, and `downloadCharacterZip(id)`.

- [ ] **Step 1: Write failing request-construction and polling tests**

Create `server/providers/pixellab.test.mjs` using an injected response queue. Assert that `createCharacter` posts to `/create-character-v3` with `view: 'low top-down'`, `template_id: 'mannequin'`, `no_background: true`, and the supplied seed. Assert that `animateWalk` posts once to `/animate-character` with all eight directions, `mode: 'v3'`, `frame_count: 4`, `keep_first_frame: false`, and `isometric: false`. Assert that `pollJob` performs GET requests only and returns a completed payload without repeating either POST.

Core assertion:

```js
assert.deepEqual(body.directions, [
  'south', 'south-west', 'west', 'north-west',
  'north', 'north-east', 'east', 'south-east',
]);
assert.equal(body.frame_count, 4);
assert.equal(body.keep_first_frame, false);
assert.equal(body.isometric, false);
```

- [ ] **Step 2: Run the adapter test and confirm the missing module failure**

Run: `node --test server/providers/pixellab.test.mjs`

Expected: FAIL because `server/providers/pixellab.mjs` does not exist.

- [ ] **Step 3: Implement the v2 client with injected dependencies**

Implement `createPixelLabClient` around base URL `https://api.pixellab.ai/v2`. Centralize JSON parsing and map 401, 402/403, 429, invalid-reference 400/422, and poll timeout failures to errors with stable `code` values: `AUTH`, `BALANCE`, `RATE_LIMIT`, `INVALID_REFERENCE`, and `TIMEOUT`. Use `Authorization: Bearer <token>`. `pollJob` must accept `{ maxAttempts = 72, intervalMs = 5000 }`, stop on `completed` or `failed`, and call only `GET /background-jobs/{jobId}`.

The character body must be:

```js
{
  description,
  reference_image: { type: 'base64', base64: stripDataUrl(referenceImage), format: 'png' },
  view: 'low top-down',
  template_id: 'mannequin',
  name,
  seed,
  no_background: true,
}
```

The walk body must be:

```js
{
  character_id: characterId,
  animation_name: 'walk-8dir-4f',
  action_description: prompt,
  mode: 'v3',
  frame_count: 4,
  keep_first_frame: false,
  directions: PIXELLAB_DIRECTIONS,
  isometric: false,
  seed,
}
```

- [ ] **Step 4: Run the adapter tests**

Run: `node --test server/providers/pixellab.test.mjs`

Expected: PASS; recorded POST count remains two after polling.

- [ ] **Step 5: Commit the provider adapter**

```powershell
git add server/providers/pixellab.mjs server/providers/pixellab.test.mjs
git -c commit.gpgsign=false commit --no-verify -m "Add PixelLab v2 character provider"
```

---

### Task 3: Resumable forge jobs and Express routes

**Files:**
- Create: `server/services/forge-jobs.mjs`
- Create: `server/services/forge-jobs.test.mjs`
- Create: `src/lib/forgeApi.ts`
- Modify: `server/index.mjs`

**Interfaces:**
- Consumes: the Task 2 PixelLab client methods.
- Produces: `createForgeService({ pixelLab, exportCharacter })`, `registerForgeRoutes(app, service)`, and the HTTP route contract from the approved spec.

- [ ] **Step 1: Write failing lifecycle tests**

Test these transitions in `server/services/forge-jobs.test.mjs`:

```text
identity queued -> directions processing -> directions ready
walk queued -> walk processing -> export ready
provider accepted -> poll timeout -> resumable with the same upstream IDs
provider failed -> failed with mapped user-facing code
```

The resume test must record the fake provider call counts and assert `createCharacter` and `animateWalk` are each called once while `pollJob` may be called multiple times.

- [ ] **Step 2: Run the lifecycle test and confirm the missing module failure**

Run: `node --test server/services/forge-jobs.test.mjs`

Expected: FAIL because `forge-jobs.mjs` does not exist.

- [ ] **Step 3: Implement the service and route registration**

Store job records in a `Map` with this public shape:

```js
{
  id, kind, status, progress, characterId, upstreamJobIds,
  usage, result, error, createdAt, updatedAt
}
```

Mount these routes in `server/index.mjs`:

```text
GET  /api/forge/health
POST /api/forge/characters
GET  /api/forge/jobs/:id
GET  /api/forge/characters/:id
POST /api/forge/characters/:id/walk
GET  /api/forge/characters/:id/export
```

Return `503 { code: 'PIXELLAB_NOT_CONFIGURED' }` from forge mutation routes when `PIXELLAB_API_TOKEN` is absent. Keep `/api/generate`, `/api/animate`, `/api/tiles`, and `/api/status/:id` unchanged.

- [ ] **Step 4: Add the typed client and poll helper**

Create `src/lib/forgeApi.ts` with:

```ts
export interface ForgeJob {
  id: string;
  kind: 'identity' | 'walk' | 'export';
  status: 'queued' | 'processing' | 'succeeded' | 'failed';
  progress: number;
  characterId: string | null;
  upstreamJobIds: string[];
  usage: number | null;
  result: unknown;
  error: { code: string; message: string } | null;
}

export async function pollForgeJob(
  jobId: string,
  onProgress: (job: ForgeJob) => void,
  signal?: AbortSignal,
): Promise<ForgeJob>;
```

Poll once every two seconds, stop on succeeded/failed, and throw the stable forge error message on failure.

- [ ] **Step 5: Run tests, lint, and build**

Run: `npm test && npm run lint && npm run build`

Expected: tests and build pass; lint retains only pre-existing warnings.

- [ ] **Step 6: Commit the resumable API**

```powershell
git add server/index.mjs server/services/forge-jobs.mjs server/services/forge-jobs.test.mjs src/lib/forgeApi.ts
git -c commit.gpgsign=false commit --no-verify -m "Add resumable character forge API"
```

---

### Task 4: Deterministic normalization, validation, and export

**Files:**
- Create: `server/services/forge-export.mjs`
- Create: `server/services/forge-export.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: a PixelLab character payload containing eight animation directions with four public frame URLs each.
- Produces: `buildForgeExport({ character, source, characterId, runId, prompt, seed, outputRoot, fetchImpl })` returning `{ packageRoot, sheetPath, manifestPath, zipBuffer, validation }`.

- [ ] **Step 1: Install image and ZIP dependencies**

Run: `npm install sharp fflate`

Expected: `package.json` and `package-lock.json` include both packages.

- [ ] **Step 2: Write failing export tests with synthetic transparent frames**

In `server/services/forge-export.test.mjs`, create 32 in-memory 32×48 Sharp PNGs with a colored 16×30 body rectangle, two transparent pixels around the opaque bounds, stable foot row, and one-pixel walking offsets. Feed them through an injected `fetchImpl` and assert:

```js
assert.equal(metadata.width, 384);
assert.equal(metadata.height, 768);
assert.deepEqual(manifest.directions, EXPECTED_DIRECTIONS);
assert.equal(manifest.frameWidth, 96);
assert.equal(manifest.frameHeight, 96);
assert.equal(manifest.frameCount, 4);
assert.equal(manifest.sheet.sha256.length, 64);
assert.equal(validation.ok, true);
```

Add separate failures for an empty alpha frame, fewer than four frames, feet drifting by three pixels, centroid drifting by three pixels, and opaque bounds lacking two-pixel padding.

- [ ] **Step 3: Run the export test and confirm the missing module failure**

Run: `node --test server/services/forge-export.test.mjs`

Expected: FAIL because `forge-export.mjs` does not exist.

- [ ] **Step 4: Implement export package construction**

Use Sharp with `kernel: 'nearest'`. For each direction, download and save the untouched provider PNG under `raw/walk/<direction>/frame_000.png` through `frame_003.png`. Find alpha bounds, resize the opaque content without antialiasing to fit inside 92×92, place it on a 96×96 transparent canvas with a shared per-direction foot baseline and horizontal center, and save under `normalized/walk/...`.

Pack frames with this source contract:

```js
const left = frameIndex * 96;
const top = directionIndex * 96;
```

Compute SHA-256 for the source, every normalized frame, and the packed sheet. Write `manifest.json` only after validation succeeds. Create the downloadable ZIP with `fflate.zipSync`; include `source`, `raw`, `normalized`, `sheets`, and `manifest.json`.

Validation messages must name the direction and frame where applicable. Palette drift is the fraction of opaque pixels whose nearest source-palette color exceeds the configured RGB-distance tolerance; include the measurement in the manifest and block when it exceeds the provided threshold.

- [ ] **Step 5: Run export tests and the whole Pixelator suite**

Run: `npm test && npm run lint && npm run build`

Expected: deterministic export tests pass on repeated runs with identical hashes.

- [ ] **Step 6: Commit the export pipeline**

```powershell
git add package.json package-lock.json server/services/forge-export.mjs server/services/forge-export.test.mjs
git -c commit.gpgsign=false commit --no-verify -m "Add validated character forge exports"
```

---

### Task 5: Three-stage Character Forge interface

**Files:**
- Create: `src/pages/CharacterForgePage.tsx`
- Modify: `src/App.tsx`
- Modify: `src/store.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `ForgeJob`, forge HTTP helpers, and canonical directions from Tasks 1 and 3.
- Produces: a browser workflow that submits a source image, reviews rotations, generates walk frames, reports validation, previews compass directions, and downloads the export.

- [ ] **Step 1: Add forge state and navigation**

Add `'forge'` to `Tab`, a `Character Forge` navigation item tagged `8-DIR`, and render `<CharacterForgePage />` for that tab. Store only current UI state in Zustand: stage, source data URL/name, internal character name, identity note, seed, character ID, current job, and selected preview direction. Provider job IDs remain server-owned.

- [ ] **Step 2: Implement the Identity stage**

Accept PNG drop/file selection, reject non-PNG or images over 256×256 before upload, and show dimensions, transparency status, and source palette swatches. Default seed to `230823`; expose it as a locked numeric field with an explicit Unlock action. The submit button label is `Forge 8 directions`, and it stays disabled with a visible reason until the PNG, character name, and live provider health are valid.

- [ ] **Step 3: Implement the Directions stage**

Render a compass grid with north at top, south at bottom, west/east on their respective sides, and diagonal cards between them. Each card shows the rotation image, canonical label, silhouette height, baseline delta, palette drift, and transparency pass/fail. Display provider, seed, usage, upstream job IDs, and resume safety in a run-details panel.

- [ ] **Step 4: Implement Walk and Export**

Generate one four-frame walk for all eight directions. Preview a selected direction at 140ms per frame with nearest-neighbor scaling. Add eight compass buttons and keyboard arrow/diagonal combinations that switch the preview row. Show per-direction validation errors. Enable `Download game package` only when server validation is green; use the `/api/forge/characters/:id/export` response.

- [ ] **Step 5: Add distinctive responsive styling**

Use the existing dark Pixelator shell, OKLCH purple/amber accents, 10px radii, Inter typography, subtle grid texture, visible hover/focus states, compact status chips, and responsive one-column fallback below 900px. Do not add gradients. Disable buttons through both `disabled` and `aria-disabled`; keep explanations adjacent to the control.

- [ ] **Step 6: Verify types, lint, build, and browser behavior**

Run: `npm test && npm run lint && npm run build`

Open `http://127.0.0.1:5179/`, select Character Forge, upload `D:\\git\\brownstone-realms-game\\public\\brownstone\\characters\\road-survivor.png`, and confirm all three stages fit at 1440×900 and 390×844 without horizontal overflow.

- [ ] **Step 7: Commit the interface**

```powershell
git add src/App.tsx src/store.ts src/styles.css src/pages/CharacterForgePage.tsx
git -c commit.gpgsign=false commit --no-verify -m "Build the top-down character forge workspace"
```

---

### Task 6: Brownstone direction and animation state

**Files:**
- Create: `client/src/brownstone/game/direction.ts`
- Create: `client/src/brownstone/game/direction.test.ts`
- Modify: `client/src/brownstone/game/gameEngine.ts`
- Modify: `client/src/brownstone/game/gameEngine.test.ts`
- Modify: `client/src/brownstone/game/persistence.ts`
- Modify: `client/src/brownstone/game/persistence.test.ts`
- Modify: `client/src/brownstone/game/BrownstoneCanvas.tsx`
- Modify: `brownstone-core/src/gameplay.rs`
- Modify: `brownstone-core/tests/gameplay.rs`

**Interfaces:**
- Consumes: the canonical row order and 96×96/4-frame manifest contract.
- Produces: `Facing`, `facingFromVector`, `getWalkSourceRect`, client/Rust `PlayerState` animation fields, and a `{ type: 'stop-moving' }` action.

- [ ] **Step 1: Write failing direction and source-rectangle tests**

Create `direction.test.ts` asserting the eight cardinal/diagonal vectors map to canonical names, zero movement keeps the previous direction, and every pair of `directionIndex` 0–7 and `frameIndex` 0–3 returns:

```ts
{ sx: frameIndex * 96, sy: directionIndex * 96, sw: 96, sh: 96 }
```

- [ ] **Step 2: Implement the pure direction module**

Create `direction.ts`:

```ts
export const FACINGS = [
  'south', 'south-west', 'west', 'north-west',
  'north', 'north-east', 'east', 'south-east',
] as const;
export type Facing = typeof FACINGS[number];

export function facingFromVector(deltaX: number, deltaY: number, previous: Facing): Facing {
  if (deltaX === 0 && deltaY === 0) return previous;
  const sector = Math.round(Math.atan2(-deltaX, deltaY) / (Math.PI / 4));
  return FACINGS[(sector + 8) % 8];
}

export function getWalkSourceRect(facing: Facing, frameIndex: number) {
  return { sx: (frameIndex % 4) * 96, sy: FACINGS.indexOf(facing) * 96, sw: 96, sh: 96 };
}
```

- [ ] **Step 3: Add movement state tests before changing the engine**

Assert `createInitialGameState` supplies `facing: 'south'`, `isMoving: false`, and the provided creation time. Assert each accepted move sets facing, `isMoving: true`, and `movementStartedAtMs` only when transitioning from stopped. Assert `stop-moving` sets `isMoving: false` without losing facing. Mirror the same assertions in Rust.

- [ ] **Step 4: Implement animation fields in TypeScript and Rust**

Add these fields to both player-state models:

```text
facing: one of the eight canonical strings
isMoving: boolean
movementStartedAtMs: integer milliseconds
```

Add `stop-moving` to `GameAction`. In move handling, compute facing from the accepted vector and anchor the clock only on a stopped-to-moving transition. In stop handling, clear `isMoving` without changing facing. In Rust, derive serde values with kebab-case names so state JSON matches the TypeScript union.

- [ ] **Step 5: Emit stop events from the canvas input loop**

Track whether movement input was active on the previous 50ms interval. Dispatch one `stop-moving` when the vector changes from non-zero to zero; do not emit repeated stop actions while already stopped. Keep pointer shooting and interaction controls unchanged.

- [ ] **Step 6: Migrate version-one local saves**

When `parseGameSave` receives an otherwise-valid legacy player without the three fields, return a cloned state with `south`, `false`, and `updatedAtMs` as the animation clock. Reject invalid values, non-canonical facing strings, and negative/non-finite clocks.

- [ ] **Step 7: Run client and Rust tests**

Run:

```powershell
npm run test:brownstone
cargo test --manifest-path brownstone-core/Cargo.toml
cargo test --manifest-path brownstone-server/Cargo.toml
```

Expected: all direction, movement, save migration, and existing gameplay tests pass.

- [ ] **Step 8: Commit direction state**

```powershell
git add client/src/brownstone/game brownstone-core/src/gameplay.rs brownstone-core/tests/gameplay.rs
git -c commit.gpgsign=false commit --no-verify -m "Add eight-direction player movement state"
```

---

### Task 7: Brownstone manifest-driven renderer and multiplayer sync

**Files:**
- Create: `client/src/brownstone/game/brownstoneRenderer.test.ts`
- Modify: `client/src/brownstone/game/brownstoneRenderer.ts`
- Modify: `client/src/brownstone/multiplayer/multiplayer.ts`
- Modify: `client/src/brownstone/multiplayer/multiplayer.test.ts`
- Modify: `client/src/brownstone/generated/types.ts` only if generated state types are not inferred from JSON.

**Interfaces:**
- Consumes: Task 6 `Facing` and `getWalkSourceRect`; runtime manifest with four 96×96 frames, eight rows, and 140ms duration.
- Produces: manifest-aware `BrownstoneAssets` and deterministic `selectWalkFrame(player, timeMs, manifest)` used for local and peer rendering.

- [ ] **Step 1: Write failing renderer selection tests**

Test frame selection at timestamps 0, 139, 140, 559, and 560 milliseconds from `movementStartedAtMs`; expect columns 0, 0, 1, 3, and 0. Test every facing maps to its canonical row. Test idle always returns frame zero. Test peer mapping preserves `facing`, `isMoving`, and `movementStartedAtMs` from serialized state JSON.

- [ ] **Step 2: Load the sheet and manifest**

Extend `BrownstoneAssets` with `survivorWalk: HTMLImageElement | null` and `survivorManifest: BrownstoneCharacterManifest | null`. Load:

```text
/brownstone/characters/road-survivor/walk-8dir-4f.png
/brownstone/characters/road-survivor/manifest.json
```

Validate the manifest with exact frame width, height, count, duration, and canonical directions before accepting it. Fall back to the existing static `survivor` image only when the local package is missing or malformed; this is a runtime compatibility fallback, not a provider-generation fallback.

- [ ] **Step 3: Render local and peer source rectangles**

Compute frame index as:

```ts
const elapsed = Math.max(0, timeMs - player.movementStartedAtMs);
const frame = player.isMoving ? Math.floor(elapsed / 140) % 4 : 0;
```

Use the nine-argument `drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)` overload for both the local player and peers. Keep nearest-neighbor sampling, knockout rotation, shadows, nameplates, and accent rings.

- [ ] **Step 4: Verify multiplayer state mapping**

Because `SlicePlayer.stateJson` already transports the whole `GameState`, parse the three new fields from that JSON and reject/fix legacy peer data through the same save migration helper. Do not add redundant SpacetimeDB table columns.

- [ ] **Step 5: Run Brownstone checks**

Run:

```powershell
npm run test:brownstone
npm run lint:brownstone
npm run build
cargo test --manifest-path brownstone-core/Cargo.toml
cargo test --manifest-path brownstone-server/Cargo.toml
```

Expected: all tests, lint, TypeScript build, and Rust tests pass.

- [ ] **Step 6: Commit renderer and sync**

```powershell
git add client/src/brownstone/game/brownstoneRenderer.ts client/src/brownstone/game/brownstoneRenderer.test.ts client/src/brownstone/multiplayer
git -c commit.gpgsign=false commit --no-verify -m "Render manifest-driven eight-direction walks"
```

---

### Task 8: Live forge, versioned installation, and end-to-end verification

**Files:**
- Create: `public/brownstone/characters/road-survivor/walk-8dir-4f.png`
- Create: `public/brownstone/characters/road-survivor/manifest.json`
- Create: `art-source/brownstone/characters/road-survivor/<generated-run-id>/**`
- Modify: `public/brownstone/manifest.json`

**Interfaces:**
- Consumes: Pixelator export ZIP from Tasks 2–5 and Brownstone runtime contract from Tasks 6–7.
- Produces: the first playable top-down road-survivor package plus verification evidence.

- [ ] **Step 1: Confirm authorized provider readiness without exposing secrets**

Call `GET http://127.0.0.1:8787/api/forge/health`. Confirm PixelLab is configured and record only the numeric balance/credit availability and provider name. If the balance cannot cover one character plus one eight-direction walk, keep the software fully tested and report the exact provider state without submitting a paid generation.

- [ ] **Step 2: Forge from the active game sprite**

Use `D:\\git\\brownstone-realms-game\\public\\brownstone\\characters\\road-survivor.png` as the initial south-facing test source. Internal identity is `road-survivor`; do not claim it represents a named Brownstone canon character. Use seed `230823` and prompt:

```text
Low top-down orthographic pixel-art road survivor walking with restrained survival weight, consistent worn dark travel clothing, stable proportions and palette, transparent background, readable feet and shoulders, no camera turn, no weapon swing.
```

Submit once, preserve returned job IDs, resume polling on timeout, and export only after all eight directions pass.

- [ ] **Step 3: Install without overwriting raw work**

Unpack the complete forge package under `art-source/brownstone/characters/road-survivor/<run-id>/`. Copy only `sheets/walk-8dir-4f.png` and `manifest.json` to `public/brownstone/characters/road-survivor/`. Leave `public/brownstone/characters/road-survivor.png` byte-for-byte unchanged and verify its SHA-256 against the pre-run hash.

- [ ] **Step 4: Update the Brownstone asset manifest**

Change the `road-survivor` entry to point to `characters/road-survivor/walk-8dir-4f.png`, set `frameWidth: 96`, `frameHeight: 96`, and represent move rows/frames through the companion manifest path. Retain source and rights fields and add the forge run ID/provider metadata.

- [ ] **Step 5: Run the full automated verification matrix**

Pixelator:

```powershell
Set-Location D:\Pixelator
npm test
npm run lint
npm run build
```

Brownstone:

```powershell
Set-Location D:\git\brownstone-realms-game
npm run test:brownstone
npm run test:assets
npm run lint:brownstone
npm run build
cargo test --manifest-path brownstone-core/Cargo.toml
cargo test --manifest-path brownstone-server/Cargo.toml
```

- [ ] **Step 6: Verify all eight directions in the local browser**

Start the Brownstone dev server, open the local game, and exercise `W`, `WA`, `A`, `AS`, `S`, `SD`, `D`, and `DW`. Confirm each input selects the expected row, cycles four frames, stops on frame zero without losing facing, peers use their own clock/facing, and the sprite stays grounded. Capture one full-window screenshot showing the playable character and HUD.

- [ ] **Step 7: Commit the validated Brownstone asset package**

```powershell
git add public/brownstone/characters/road-survivor public/brownstone/manifest.json art-source/brownstone/characters/road-survivor
git -c commit.gpgsign=false commit --no-verify -m "Install playable road survivor walk set"
```

---

## Completion evidence

- Pixelator automated tests cover directions, provider calls, resume behavior, normalization, validation, packing, and hashing.
- Pixelator lint/build pass and Character Forge is usable at desktop and mobile widths.
- Brownstone client and Rust tests pass, including save migration and multiplayer peer state.
- The original static road-survivor file hash is unchanged.
- The installed sheet is 384×768, its manifest lists the eight canonical rows and four frames, and hashes match.
- Local browser verification demonstrates all eight movement directions and stop behavior.
