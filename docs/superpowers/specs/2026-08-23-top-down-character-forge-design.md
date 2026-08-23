# Top-Down Character Forge Design

Date: 2026-08-23  
Status: Approved  
Owner: Pixelator / Brownstone Realms

## Purpose

Add a Brownstone-owned Character Forge to Pixelator that turns one approved, south-facing character sprite into a game-ready eight-direction walking set and installs it into the Brownstone Realms game without overwriting source material.

The first release is intentionally narrow. It solves the immediate playability failure: the game accepts eight-direction movement input but currently draws one static character image for every direction. Voice, attacks, equipment layers, character creation, map generation, and isometric world conversion are outside this release.

## Camera and asset contract

Brownstone uses a square-grid orthographic world. `worldToScreen` maps world X directly to screen X and world Y directly to screen Y; there is no diamond-grid isometric projection. Character art should therefore use a **low top-down orthographic** view: enough elevation to see the head and shoulders, but not a true isometric camera.

The forge produces eight directions in this canonical order:

1. `south`
2. `south-west`
3. `west`
4. `north-west`
5. `north`
6. `north-east`
7. `east`
8. `south-east`

Each direction contains four walking frames. All exported frames are normalized to 96×96 transparent PNGs with nearest-neighbor sampling, a shared ground baseline, a stable horizontal body anchor, and the source palette remapped within a configurable tolerance.

The packed game sheet is 384×768 pixels: four frame columns by eight direction rows. A companion JSON manifest records direction order, frame dimensions, frame count, frame duration, source identity, generation provider, prompt, seed, hashes, and raw-asset paths.

## Selected approach

Pixelator owns the workflow, data model, validation, packing, and exports. Generation providers are adapters rather than the product boundary.

The first provider is the already configured PixelLab v2 API because its official character workflow directly supports a south-facing reference, eight low-top-down rotations, and per-direction animation. Retro Diffusion remains available for single-direction actions and four-direction prompt-driven experiments, but it is not the primary eight-direction identity path.

PixelZ is a black-box product benchmark. Pixelator may reproduce useful observable workflow ideas—keyframe slots, seed controls, palette modes, transparency cleanup, editor handoff, and sprite-sheet export—but the implementation uses Pixelator code and authorized public APIs.

The existing voxelizer remains an optional local preview/fallback. Its current single-image extrusion cannot produce a faithful humanoid turnaround, so multi-view voxel reconstruction is deferred until after the 2D eight-direction pipeline is playable.

## Architecture

### Server provider layer

Split provider-specific HTTP behavior out of the current Express route into focused modules:

- `server/providers/pixellab.mjs`
  - authenticate against `https://api.pixellab.ai/v2`
  - read account balance
  - submit `POST /create-character-v3` with the approved south-facing reference, `view: "low top-down"`, `template_id: "mannequin"`, transparent background, and fixed seed
  - poll `GET /background-jobs/{job_id}` with bounded retries
  - read `GET /characters/{character_id}` for the eight rotation URLs
  - submit `POST /animate-character` in v3 mode with `frame_count: 4`, `keep_first_frame: false`, all eight directions, `isometric: false`, a fixed shared seed, and the locked walking prompt
  - poll all returned direction jobs without resubmitting a charged request
  - download `GET /characters/{character_id}/zip`
- `server/providers/retrodiffusion.mjs`
  - preserve existing generation, single-direction advanced animation, and four-direction prompt-driven behavior
- `server/services/forge-jobs.mjs`
  - expose one Pixelator job lifecycle regardless of provider
  - retain upstream provider job IDs, usage, progress, errors, and retry state
  - never retry a generation submission after a provider accepted it

The existing `/api/animate` behavior remains compatible. Character Forge receives separate routes so a failed migration cannot break current animation tools:

- `GET /api/forge/health`
- `POST /api/forge/characters`
- `GET /api/forge/jobs/:id`
- `GET /api/forge/characters/:id`
- `POST /api/forge/characters/:id/walk`
- `GET /api/forge/characters/:id/export`

### Client domain layer

Add provider-independent types and deterministic image utilities:

- `src/lib/characterForge.ts`
  - canonical direction names and row order
  - frame-set validation
  - alpha bounds and baseline measurement
  - palette comparison
  - per-direction stabilization
  - 4×8 sheet composition
  - manifest construction
- `src/lib/forgeApi.ts`
  - typed client for the forge routes and progress polling
- `src/lib/forgeExport.ts`
  - ZIP unpacking in memory
  - raw-frame preservation
  - normalized PNG and manifest downloads

Provider responses never leak into React components. The UI consumes a single `ForgeCharacter` model containing source metadata, rotations, animations, validation results, and export readiness.

### Character Forge interface

Add a `Character Forge` navigation item and a focused three-stage workspace:

1. **Identity**
   - choose or drop one south-facing sprite
   - enter an internal character name and optional identity note
   - preview transparency, dimensions, and palette
   - lock seed and low-top-down perspective
2. **Directions**
   - generate and review all eight facings in a compass grid
   - compare silhouette height, ground baseline, palette drift, and transparency
   - regenerate only through an explicit new forge run; raw results remain preserved
3. **Walk and Export**
   - generate the four-frame walk for all eight directions
   - preview any direction and a compass-driven direction switch
   - show validation failures beside the affected direction
   - export raw provider files, normalized frames, packed sheet, and manifest

The interface shows provider, seed, estimated/actual usage, remote job IDs, and whether a run is safe to resume. Buttons that cannot act are disabled with a visible reason.

## Data and file layout

Pixelator keeps browser-library records for fast review and also creates an explicit export package:

```text
<character-slug>/
├── source/
│   └── south-reference.png
├── raw/
│   ├── rotations/<direction>.png
│   └── walk/<direction>/frame_000.png ... frame_003.png
├── normalized/
│   └── walk/<direction>/frame_000.png ... frame_003.png
├── sheets/
│   └── walk-8dir-4f.png
└── manifest.json
```

Brownstone installation copies versioned output into:

```text
public/brownstone/characters/<character-slug>/walk-8dir-4f.png
public/brownstone/characters/<character-slug>/manifest.json
art-source/brownstone/characters/<character-slug>/<run-id>/...
```

The existing `road-survivor.png` stays untouched. The Brownstone content manifest points to the new sheet only after validation succeeds.

## Brownstone runtime integration

Extend the shared player state with:

- `facing`: one of the eight canonical directions
- `isMoving`: boolean
- `movementStartedAtMs`: animation clock anchor

Movement maps a normalized input vector to the nearest 45-degree sector. Facing changes immediately when non-zero movement is accepted and remains locked when movement stops. The multiplayer server persists/synchronizes facing and moving state so peers render the same animation.

The renderer loads the character manifest, selects the direction row, advances through four frames using manifest timing, and draws with nearest-neighbor sampling. Idle uses frame zero in the first release. Knockout may rotate a stable frame as the current implementation does; a dedicated knockout animation is deferred.

Save migration supplies `south`, `false`, and the current timestamp when the new fields are absent.

## Validation and failure handling

A forge export is blocked unless all of the following pass:

- eight unique canonical directions exist
- every direction has exactly four non-empty walk frames
- every normalized frame is 96×96 with an alpha channel
- opaque bounds fit inside the frame with at least two pixels of padding
- feet stay within a two-pixel vertical band within each direction
- horizontal centroid drift stays within two pixels within each direction
- palette drift is reported and must remain under the configured threshold
- sheet dimensions and manifest hashes match the normalized frames

Provider failures preserve the accepted job IDs and completed direction results. Polling resumes from stored IDs. Authentication, insufficient balance, rate limiting, invalid reference dimensions, and provider timeouts receive distinct user-facing errors. No failed request silently falls back to mock art during a live forge run.

## Testing

Pixelator gains a real automated test command. Unit tests cover:

- direction-vector classification at all sector boundaries
- ZIP/metadata normalization and direction ordering
- frame validation, empty-frame rejection, bounds, grounding, and centroid drift
- deterministic sheet packing and manifest hashing
- provider adapter request construction and polling with mocked HTTP responses
- resume behavior without generation resubmission

Brownstone tests cover:

- eight-direction facing updates for keyboard and pointer movement
- stopping without losing facing
- save migration
- multiplayer serialization and peer state
- renderer source-rectangle selection for every direction and frame

End-to-end verification uses one approved Brownstone source sprite, performs one eight-direction walk forge run when account balance permits, exports the package, installs it without deleting the original sprite, and exercises all eight movement directions in the local game.

## Explicitly deferred

- voice, speech, lip sync, and vocal animation
- attack, idle, death, crafting, weapon, and equipment-layer animations
- true isometric world projection
- local model training or LoRA training
- multi-view voxel reconstruction
- public hosting, multi-user accounts, billing, and gallery publishing

