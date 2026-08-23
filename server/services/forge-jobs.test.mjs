import assert from "node:assert/strict";
import test from "node:test";

import { createForgeService } from "./forge-jobs.mjs";

const DIRECTIONS = [
  "south",
  "south-west",
  "west",
  "north-west",
  "north",
  "north-east",
  "east",
  "south-east",
];

test("resumes an accepted character job without submitting the charged request twice", async () => {
  let createCalls = 0;
  let pollCalls = 0;
  const pixelLab = {
    async createCharacter() {
      createCalls += 1;
      return {
        background_job_id: "provider-character-job",
        character_id: "character-1",
        usage: { type: "usd", usd: 0.08 },
      };
    },
    async pollJob() {
      pollCalls += 1;
      if (pollCalls === 1) {
        const error = new Error("still processing");
        error.code = "TIMEOUT";
        throw error;
      }
      return {
        id: "provider-character-job",
        status: "completed",
        usage: { type: "usd", usd: 0.08 },
        last_response: { character_id: "character-1" },
      };
    },
    async getCharacter() {
      return {
        id: "character-1",
        name: "road-survivor",
        status: "completed",
        rotation_urls: Object.fromEntries(DIRECTIONS.map((direction) => [direction, `https://assets/${direction}.png`])),
        animations: [],
      };
    },
  };
  const service = createForgeService({
    pixelLab,
    now: () => "2026-08-23T12:00:00.000Z",
    makeId: () => "forge-identity-1",
  });

  const queued = service.queueCharacter({
    name: "road-survivor",
    description: "worn road survivor",
    referenceImage: "data:image/png;base64,cm9hZA==",
    seed: 230823,
  });
  assert.equal(queued.status, "queued");

  const resumable = await service.processJob(queued.id);
  assert.equal(resumable.status, "resumable");
  assert.deepEqual(resumable.upstreamJobIds, ["provider-character-job"]);
  assert.equal(resumable.characterId, "character-1");

  const completed = await service.processJob(queued.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.progress, 100);
  assert.equal(completed.result.rotationCount, 8);
  assert.equal(createCalls, 1);
  assert.equal(pollCalls, 2);
});

test("submits one walk request and completes all eight accepted direction jobs", async () => {
  let animateCalls = 0;
  const polled = [];
  const pixelLab = {
    async animateWalk() {
      animateCalls += 1;
      return {
        background_job_ids: DIRECTIONS.map((direction) => `walk-${direction}`),
        directions: DIRECTIONS,
        status: "processing",
      };
    },
    async pollJob(jobId) {
      polled.push(jobId);
      return {
        id: jobId,
        status: "completed",
        usage: { type: "usd", usd: 0.01 },
        last_response: { saved_to_storage: true },
      };
    },
    async getCharacter() {
      return {
        id: "character-1",
        status: "completed",
        rotation_urls: {},
        animations: [{
          animation_type: "walk-8dir-4f",
          display_name: "Walk · 8 directions · 4 frames",
          directions: DIRECTIONS.map((direction) => ({
            direction,
            frame_count: 4,
            frames: [0, 1, 2, 3].map((frame) => `https://assets/${direction}-${frame}.png`),
          })),
        }],
      };
    },
  };
  const service = createForgeService({
    pixelLab,
    now: () => "2026-08-23T12:00:00.000Z",
    makeId: () => "forge-walk-1",
  });

  const queued = service.queueWalk("character-1", {
    prompt: "walking with restrained survival weight",
    seed: 230823,
  });
  const completed = await service.processJob(queued.id);

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.result.directionCount, 8);
  assert.equal(animateCalls, 1);
  assert.deepEqual(polled, DIRECTIONS.map((direction) => `walk-${direction}`));
  assert.ok(completed.upstreamJobs.every((job) => job.status === "completed"));
});

test("preserves a stable provider error code for user-facing failure handling", async () => {
  const pixelLab = {
    async createCharacter() {
      const error = new Error("insufficient credits");
      error.code = "BALANCE";
      error.status = 402;
      throw error;
    },
  };
  const service = createForgeService({
    pixelLab,
    now: () => "2026-08-23T12:00:00.000Z",
    makeId: () => "forge-identity-1",
  });
  const queued = service.queueCharacter({
    name: "road-survivor",
    description: "worn road survivor",
    referenceImage: "data:image/png;base64,cm9hZA==",
    seed: 230823,
  });

  const failed = await service.processJob(queued.id);

  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.error, {
    code: "BALANCE",
    message: "insufficient credits",
    status: 402,
  });
});

test("rejects processing an unknown local job id", async () => {
  const service = createForgeService({ pixelLab: {} });
  await assert.rejects(() => service.processJob("missing"), /no such forge job/i);
});

test("exports with the retained source identity and latest walk prompt", async () => {
  const ids = ["identity-run-1", "walk-run-1"];
  const character = {
    id: "provider-character-1",
    rotation_urls: {},
    animations: [{
      animation_type: "walk-8dir-4f",
      directions: DIRECTIONS.map((direction) => ({
        direction,
        frame_count: 4,
        frames: ["0.png", "1.png", "2.png", "3.png"],
      })),
    }],
  };
  const service = createForgeService({
    makeId: () => ids.shift(),
    pixelLab: {
      async createCharacter() {
        return { background_job_id: "identity-upstream", character_id: "provider-character-1" };
      },
      async animateWalk() {
        return {
          background_job_ids: DIRECTIONS.map((direction) => `walk-${direction}`),
          directions: DIRECTIONS,
        };
      },
      async pollJob(jobId) {
        return { id: jobId, status: "completed", created_at: "2026-08-23T12:00:00Z" };
      },
      async getCharacter() {
        return character;
      },
    },
    async exportCharacter(input) {
      return { zipBuffer: Buffer.from("zip"), manifest: { ...input, source: { name: input.source.name, bytes: input.source.buffer.length } } };
    },
  });
  const identity = service.queueCharacter({
    name: "road-survivor",
    sourceName: "road-survivor-original.png",
    description: "worn road survivor",
    referenceImage: "data:image/png;base64,c291cmNl",
    seed: 230823,
  });
  await service.processJob(identity.id);
  const walk = service.queueWalk("provider-character-1", {
    prompt: "walking with restrained survival weight",
    seed: 230823,
  });
  await service.processJob(walk.id);

  const exported = await service.exportCharacter("provider-character-1");

  assert.equal(exported.manifest.characterId, "road-survivor");
  assert.equal(exported.manifest.runId, "identity-run-1");
  assert.equal(exported.manifest.prompt, "walking with restrained survival weight");
  assert.equal(exported.manifest.seed, 230823);
  assert.deepEqual(exported.manifest.source, { name: "road-survivor-original.png", bytes: 6 });
});

test("reattaches a local source to an existing provider character without regenerating", async () => {
  const service = createForgeService({
    pixelLab: {
      async getCharacter() {
        return { id: "provider-character-1", rotation_urls: {}, animations: [] };
      },
    },
    async exportCharacter(input) {
      return {
        zipBuffer: Buffer.from("zip"),
        manifest: {
          characterId: input.characterId,
          runId: input.runId,
          prompt: input.prompt,
          sourceName: input.source.name,
          sourceBytes: input.source.buffer.length,
        },
      };
    },
  });

  service.recoverCharacterSource("provider-character-1", {
    name: "road-survivor",
    runId: "identity-run-recovered",
    sourceName: "road-survivor.png",
    referenceImage: "data:image/png;base64,c291cmNl",
    description: "worn road survivor",
    seed: 230823,
    walkPrompt: "walking with restrained survival weight",
  });

  const exported = await service.exportCharacter("provider-character-1");
  assert.deepEqual(exported.manifest, {
    characterId: "road-survivor",
    runId: "identity-run-recovered",
    prompt: "walking with restrained survival weight",
    sourceName: "road-survivor.png",
    sourceBytes: 6,
  });
});
