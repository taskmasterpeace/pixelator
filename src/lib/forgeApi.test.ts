import assert from "node:assert/strict";
import test from "node:test";

import { createForgeCharacter, pollForgeJob } from "./forgeApi.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("polls through resumable provider work until the forge job succeeds", async () => {
  const statuses = ["processing", "resumable", "processing", "succeeded"] as const;
  const progressSeen: string[] = [];
  let requestCount = 0;

  const completed = await pollForgeJob(
    "forge-1",
    (job) => progressSeen.push(job.status),
    {
      intervalMs: 0,
      fetchImpl: async (url, init) => {
        assert.equal(url, "/api/forge/jobs/forge-1");
        assert.equal(init?.signal?.aborted, false);
        const status = statuses[requestCount++];
        return jsonResponse({
          id: "forge-1",
          kind: "identity",
          status,
          progress: status === "succeeded" ? 100 : requestCount * 20,
          characterId: "character-1",
          upstreamJobIds: ["provider-1"],
          upstreamJobs: [{ id: "provider-1", direction: null, status: status === "succeeded" ? "completed" : "processing" }],
          usage: 0.08,
          result: status === "succeeded" ? { rotationCount: 8 } : null,
          error: status === "resumable" ? { code: "TIMEOUT", message: "still running", status: null } : null,
          createdAt: "2026-08-23T12:00:00.000Z",
          updatedAt: "2026-08-23T12:00:01.000Z",
        });
      },
    },
  );

  assert.equal(completed.status, "succeeded");
  assert.deepEqual(progressSeen, ["processing", "resumable", "processing", "succeeded"]);
  assert.equal(requestCount, 4);
});

test("sends only the authorized forge identity fields to the local API", async () => {
  let observedBody: unknown;
  const job = await createForgeCharacter(
    {
      name: "road-survivor",
      description: "worn road survivor",
      referenceImage: "data:image/png;base64,cm9hZA==",
      seed: 230823,
    },
    async (url, init) => {
      assert.equal(url, "/api/forge/characters");
      assert.equal(init?.method, "POST");
      observedBody = JSON.parse(String(init?.body));
      return jsonResponse({
        id: "forge-1",
        kind: "identity",
        status: "queued",
        progress: 0,
        characterId: null,
        upstreamJobIds: [],
        upstreamJobs: [],
        usage: 0,
        result: null,
        error: null,
        createdAt: "2026-08-23T12:00:00.000Z",
        updatedAt: "2026-08-23T12:00:00.000Z",
      }, 202);
    },
  );

  assert.equal(job.id, "forge-1");
  assert.deepEqual(observedBody, {
    name: "road-survivor",
    description: "worn road survivor",
    referenceImage: "data:image/png;base64,cm9hZA==",
    seed: 230823,
  });
});

test("throws the stable server error message for a failed request", async () => {
  await assert.rejects(
    () => createForgeCharacter(
      {
        name: "road-survivor",
        description: "worn road survivor",
        referenceImage: "data:image/png;base64,cm9hZA==",
        seed: 230823,
      },
      async () => jsonResponse({ code: "BALANCE", message: "Not enough credits." }, 402),
    ),
    (error: unknown) => error instanceof Error
      && error.message === "Not enough credits."
      && (error as Error & { code?: string }).code === "BALANCE",
  );
});
