import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { registerForgeRoutes } from "./forge.mjs";
import { createForgeService } from "../services/forge-jobs.mjs";

async function withServer(service, run) {
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  registerForgeRoutes(app, service);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("exposes provider readiness without leaking the configured token", async () => {
  const service = createForgeService({
    pixelLab: {
      async getBalance() {
        return {
          credits: { type: "usd", usd: 4.25 },
          subscription: { type: "generations", status: "active", generations: 27, total: 100 },
        };
      },
    },
    configured: true,
  });

  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forge/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.provider, "pixellab-v2");
    assert.equal(body.configured, true);
    assert.equal(body.balance.subscription.generations, 27);
    assert.equal(JSON.stringify(body).includes("token"), false);
  });
});

test("queues and completes a character through the HTTP job lifecycle", async () => {
  const pixelLab = {
    async createCharacter() {
      return { background_job_id: "upstream-1", character_id: "character-1" };
    },
    async pollJob() {
      return { id: "upstream-1", status: "completed", created_at: "2026-08-23T12:00:00Z" };
    },
    async getCharacter() {
      return {
        id: "character-1",
        status: "completed",
        rotation_urls: {
          south: "south.png",
          "south-west": "south-west.png",
          west: "west.png",
          "north-west": "north-west.png",
          north: "north.png",
          "north-east": "north-east.png",
          east: "east.png",
          "south-east": "south-east.png",
        },
        animations: [],
      };
    },
    async getBalance() {
      return { credits: { type: "usd", usd: 4.25 }, subscription: { generations: 27, total: 100 } };
    },
  };
  const service = createForgeService({ pixelLab, configured: true, makeId: () => "forge-1" });

  await withServer(service, async (baseUrl) => {
    const createdResponse = await fetch(`${baseUrl}/api/forge/characters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "road-survivor",
        description: "worn road survivor",
        referenceImage: "data:image/png;base64,cm9hZA==",
        seed: 230823,
      }),
    });
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 202);
    assert.equal(created.id, "forge-1");

    let job = created;
    for (let attempt = 0; attempt < 10 && job.status !== "succeeded"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const jobResponse = await fetch(`${baseUrl}/api/forge/jobs/forge-1`);
      job = await jobResponse.json();
    }
    assert.equal(job.status, "succeeded");
    assert.equal(job.characterId, "character-1");

    const characterResponse = await fetch(`${baseUrl}/api/forge/characters/character-1`);
    const character = await characterResponse.json();
    assert.equal(characterResponse.status, 200);
    assert.equal(Object.keys(character.rotation_urls).length, 8);
  });
});

test("blocks live forge mutations when PixelLab is not configured", async () => {
  const service = createForgeService({ pixelLab: {}, configured: false });
  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forge/characters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "road-survivor" }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      code: "PIXELLAB_NOT_CONFIGURED",
      message: "PixelLab v2 is not configured for live character forging.",
    });
  });
});

test("returns a stable 404 body for an unknown forge job", async () => {
  const service = createForgeService({ pixelLab: {}, configured: false });
  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forge/jobs/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      code: "FORGE_JOB_NOT_FOUND",
      message: "No forge job exists with id missing.",
    });
  });
});

test("a status read resumes accepted upstream work without another generation submission", async () => {
  let createCalls = 0;
  let pollCalls = 0;
  const service = createForgeService({
    configured: true,
    makeId: () => "forge-resume-1",
    pixelLab: {
      async createCharacter() {
        createCalls += 1;
        return { background_job_id: "upstream-resume-1", character_id: "character-resume-1" };
      },
      async pollJob() {
        pollCalls += 1;
        if (pollCalls === 1) {
          const error = new Error("provider is still processing");
          error.code = "TIMEOUT";
          throw error;
        }
        return { id: "upstream-resume-1", status: "completed", created_at: "2026-08-23T12:00:00Z" };
      },
      async getCharacter() {
        return { id: "character-resume-1", rotation_urls: {}, animations: [] };
      },
    },
  });

  await withServer(service, async (baseUrl) => {
    await fetch(`${baseUrl}/api/forge/characters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "road-survivor",
        description: "worn road survivor",
        referenceImage: "data:image/png;base64,cm9hZA==",
        seed: 230823,
      }),
    });

    let job;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      job = await (await fetch(`${baseUrl}/api/forge/jobs/forge-resume-1`)).json();
      if (job.status === "succeeded") break;
    }
    assert.equal(job.status, "succeeded");
    assert.equal(createCalls, 1);
    assert.equal(pollCalls, 2);
  });
});

test("queues one eight-direction walk job for an existing character", async () => {
  const directions = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"];
  const service = createForgeService({
    configured: true,
    makeId: () => "forge-walk-route-1",
    pixelLab: {
      async animateWalk() {
        return {
          background_job_ids: directions.map((direction) => `walk-${direction}`),
          directions,
        };
      },
      async pollJob(jobId) {
        return { id: jobId, status: "completed", created_at: "2026-08-23T12:00:00Z" };
      },
      async getCharacter() {
        return {
          id: "character-1",
          rotation_urls: {},
          animations: [{
            animation_type: "walk-8dir-4f",
            directions: directions.map((direction) => ({
              direction,
              frame_count: 4,
              frames: ["0.png", "1.png", "2.png", "3.png"],
            })),
          }],
        };
      },
    },
  });

  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forge/characters/character-1/walk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "walking with restrained survival weight", seed: 230823 }),
    });
    const queued = await response.json();
    assert.equal(response.status, 202);
    assert.equal(queued.id, "forge-walk-route-1");
    assert.equal(queued.characterId, "character-1");

    let completed = queued;
    for (let attempt = 0; attempt < 10 && completed.status !== "succeeded"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed = await (await fetch(`${baseUrl}/api/forge/jobs/forge-walk-route-1`)).json();
    }
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.result.directionCount, 8);
  });
});

test("downloads a validated forge package as a named ZIP", async () => {
  const service = {
    isConfigured: true,
    async exportCharacter() {
      return {
        zipBuffer: Buffer.from("validated-forge-package"),
        manifest: { characterId: "road-survivor", runId: "forge-1" },
      };
    },
  };

  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forge/characters/character-1/export`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.match(response.headers.get("content-disposition"), /road-survivor-forge-1\.zip/);
    assert.equal(Buffer.from(await response.arrayBuffer()).toString("utf8"), "validated-forge-package");
  });
});
