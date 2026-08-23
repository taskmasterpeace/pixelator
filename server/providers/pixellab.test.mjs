import assert from "node:assert/strict";
import test from "node:test";

import { createPixelLabClient, PIXELLAB_DIRECTIONS } from "./pixellab.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("creates a low-top-down character from the approved south reference", async () => {
  const calls = [];
  const client = createPixelLabClient({
    token: "authorized-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        background_job_id: "job-character",
        character_id: "character-1",
        status: "processing",
        usage: { type: "usd", usd: 0.02 },
      });
    },
  });

  const accepted = await client.createCharacter({
    name: "road-survivor",
    description: "worn road survivor",
    referenceImage: "data:image/png;base64,cm9hZA==",
    seed: 230823,
  });

  assert.equal(accepted.background_job_id, "job-character");
  assert.equal(calls[0].url, "https://api.pixellab.ai/v2/create-character-v3");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer authorized-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    description: "worn road survivor",
    reference_image: { type: "base64", base64: "cm9hZA==", format: "png" },
    view: "low top-down",
    template_id: "mannequin",
    name: "road-survivor",
    seed: 230823,
    no_background: true,
  });
});

test("submits one v3 walk request covering all eight orthographic directions", async () => {
  const calls = [];
  const client = createPixelLabClient({
    token: "authorized-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        background_job_ids: PIXELLAB_DIRECTIONS.map((direction) => `job-${direction}`),
        directions: PIXELLAB_DIRECTIONS,
        status: "processing",
      });
    },
  });

  const accepted = await client.animateWalk({
    characterId: "character-1",
    prompt: "walking with restrained survival weight",
    seed: 230823,
  });

  assert.equal(accepted.background_job_ids.length, 8);
  assert.equal(calls[0].url, "https://api.pixellab.ai/v2/animate-character");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    character_id: "character-1",
    animation_name: "walk-8dir-4f",
    action_description: "walking with restrained survival weight",
    mode: "v3",
    frame_count: 4,
    keep_first_frame: false,
    directions: [
      "south",
      "south-west",
      "west",
      "north-west",
      "north",
      "north-east",
      "east",
      "south-east",
    ],
    isometric: false,
    seed: 230823,
    enhance_prompt: false,
  });
});

test("resumes an accepted job by polling GET without repeating a charged POST", async () => {
  const calls = [];
  const responses = [
    { id: "job-character", status: "processing", created_at: "2026-08-23T12:00:00Z", last_response: null },
    {
      id: "job-character",
      status: "completed",
      created_at: "2026-08-23T12:00:00Z",
      last_response: { character_id: "character-1", uploaded_directions: PIXELLAB_DIRECTIONS },
      usage: { type: "usd", usd: 0.08 },
    },
  ];
  const client = createPixelLabClient({
    token: "authorized-token",
    sleep: async () => undefined,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      return jsonResponse(responses.shift());
    },
  });

  const completed = await client.pollJob("job-character", { maxAttempts: 3, intervalMs: 1 });

  assert.equal(completed.status, "completed");
  assert.equal(completed.last_response.character_id, "character-1");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ init }) => !init.method || init.method === "GET"));
  assert.ok(calls.every(({ url }) => url.endsWith("/background-jobs/job-character")));
});

test("maps provider status codes to stable forge error codes", async () => {
  const cases = [
    [401, "AUTH"],
    [402, "BALANCE"],
    [429, "RATE_LIMIT"],
    [422, "INVALID_REFERENCE"],
  ];

  for (const [status, expectedCode] of cases) {
    const client = createPixelLabClient({
      token: "authorized-token",
      fetchImpl: async () => jsonResponse({ detail: `provider ${status}` }, status),
    });
    await assert.rejects(
      () => client.createCharacter({
        name: "road-survivor",
        description: "road survivor",
        referenceImage: "data:image/png;base64,cm9hZA==",
        seed: 230823,
      }),
      (error) => error.code === expectedCode && error.status === status,
    );
  }
});
