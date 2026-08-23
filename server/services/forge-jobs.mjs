import { randomUUID } from "node:crypto";

function publicCopy(value) {
  return structuredClone(value);
}

function usageUsd(value) {
  return Number(value?.usd ?? 0) || 0;
}

function errorRecord(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "PROVIDER",
    message: String(error?.message || error || "Unknown forge error"),
    status: Number.isInteger(error?.status) ? error.status : null,
  };
}

export function createForgeService({
  pixelLab,
  exportCharacter: exportBuilder = null,
  now = () => new Date().toISOString(),
  makeId = () => `forge_${randomUUID()}`,
  configured = true,
} = {}) {
  if (!pixelLab || typeof pixelLab !== "object") {
    throw new TypeError("Forge service requires a PixelLab client");
  }

  const jobs = new Map();
  const inputs = new Map();
  const characters = new Map();
  const sourceRuns = new Map();
  const walkSettings = new Map();
  const exportsByCharacter = new Map();
  const active = new Map();

  function createJob(kind, characterId, input) {
    const id = makeId();
    const timestamp = now();
    const job = {
      id,
      kind,
      status: "queued",
      progress: 0,
      characterId,
      upstreamJobIds: [],
      upstreamJobs: [],
      usage: 0,
      result: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    jobs.set(id, job);
    inputs.set(id, structuredClone(input));
    return publicCopy(job);
  }

  function update(job, patch) {
    Object.assign(job, patch, { updatedAt: now() });
  }

  async function processIdentity(job, input) {
    if (job.upstreamJobIds.length === 0) {
      update(job, { status: "processing", progress: 5, error: null });
      const accepted = await pixelLab.createCharacter(input);
      job.characterId = accepted.character_id;
      job.upstreamJobIds = [accepted.background_job_id];
      job.upstreamJobs = [{
        id: accepted.background_job_id,
        direction: null,
        status: "processing",
      }];
      job.usage += usageUsd(accepted.usage);
      update(job, { progress: 20 });
    } else {
      update(job, { status: "processing", error: null });
    }

    const providerJob = await pixelLab.pollJob(job.upstreamJobIds[0]);
    job.upstreamJobs[0].status = "completed";
    job.usage = Math.max(job.usage, usageUsd(providerJob.usage));
    update(job, { progress: 80 });
    const character = await pixelLab.getCharacter(job.characterId);
    characters.set(job.characterId, character);
    sourceRuns.set(job.characterId, {
      characterId: input.name,
      runId: job.id,
      source: {
        name: input.sourceName || `${input.name}.png`,
        buffer: Buffer.from(String(input.referenceImage || "").replace(/^data:image\/[a-z0-9.+-]+;base64,/iu, ""), "base64"),
      },
      prompt: input.description,
      seed: input.seed,
    });
    update(job, {
      status: "succeeded",
      progress: 100,
      result: {
        characterId: job.characterId,
        rotationCount: Object.keys(character.rotation_urls || {}).length,
        character,
      },
    });
  }

  async function processWalk(job, input) {
    if (job.upstreamJobIds.length === 0) {
      update(job, { status: "processing", progress: 5, error: null });
      const accepted = await pixelLab.animateWalk({ characterId: job.characterId, ...input });
      const ids = accepted.background_job_ids || [];
      const directions = accepted.directions || [];
      if (ids.length !== 8 || directions.length !== 8) {
        const error = new Error("PixelLab did not accept all eight walk directions.");
        error.code = "PROVIDER_SHAPE";
        throw error;
      }
      job.upstreamJobIds = [...ids];
      job.upstreamJobs = ids.map((id, index) => ({
        id,
        direction: directions[index],
        status: "processing",
      }));
      update(job, { progress: 10 });
    } else {
      update(job, { status: "processing", error: null });
    }

    for (let index = 0; index < job.upstreamJobs.length; index += 1) {
      const upstream = job.upstreamJobs[index];
      if (upstream.status === "completed") continue;
      const providerJob = await pixelLab.pollJob(upstream.id);
      upstream.status = "completed";
      job.usage += usageUsd(providerJob.usage);
      update(job, { progress: 10 + Math.round(((index + 1) / 8) * 75) });
    }

    const character = await pixelLab.getCharacter(job.characterId);
    characters.set(job.characterId, character);
    walkSettings.set(job.characterId, { prompt: input.prompt, seed: input.seed });
    const animation = (character.animations || []).find((candidate) =>
      candidate.animation_type === "walk-8dir-4f" ||
      candidate.display_name === "Walk · 8 directions · 4 frames",
    );
    update(job, {
      status: "succeeded",
      progress: 100,
      result: {
        characterId: job.characterId,
        directionCount: animation?.directions?.length || 0,
        character,
      },
    });
  }

  async function runJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw new Error(`No such forge job: ${jobId}`);
    if (job.status === "succeeded" || job.status === "failed") return publicCopy(job);
    const input = inputs.get(jobId);
    try {
      if (job.kind === "identity") await processIdentity(job, input);
      else if (job.kind === "walk") await processWalk(job, input);
      else throw new Error(`Unsupported forge job kind: ${job.kind}`);
    } catch (error) {
      if (error?.code === "TIMEOUT" && job.upstreamJobIds.length > 0) {
        update(job, { status: "resumable", error: errorRecord(error) });
      } else {
        update(job, { status: "failed", error: errorRecord(error) });
      }
    }
    return publicCopy(job);
  }

  return {
    isConfigured: configured,

    queueCharacter(input) {
      return createJob("identity", null, input);
    },

    queueWalk(characterId, input) {
      return createJob("walk", characterId, input);
    },

    processJob(jobId) {
      if (active.has(jobId)) return active.get(jobId);
      const promise = runJob(jobId).finally(() => active.delete(jobId));
      active.set(jobId, promise);
      return promise;
    },

    getJob(jobId) {
      const job = jobs.get(jobId);
      return job ? publicCopy(job) : null;
    },

    async getCharacter(characterId) {
      const cached = characters.get(characterId);
      if (cached) return publicCopy(cached);
      const character = await pixelLab.getCharacter(characterId);
      characters.set(characterId, character);
      return publicCopy(character);
    },

    async getHealth() {
      if (!configured) return { configured: false, provider: "pixellab-v2" };
      const balance = await pixelLab.getBalance();
      return { configured: true, provider: "pixellab-v2", balance };
    },

    async exportCharacter(characterId, options = {}) {
      if (typeof exportBuilder !== "function") {
        const error = new Error("Forge export service is not configured.");
        error.code = "EXPORT_NOT_CONFIGURED";
        throw error;
      }
      const cached = exportsByCharacter.get(characterId);
      if (cached) return cached;
      const sourceRun = sourceRuns.get(characterId);
      if (!sourceRun) {
        const error = new Error("The original forge source is not available for this character.");
        error.code = "FORGE_SOURCE_NOT_FOUND";
        error.status = 409;
        throw error;
      }
      const walk = walkSettings.get(characterId) || {};
      const character = await this.getCharacter(characterId);
      const exported = await exportBuilder({
        character,
        ...sourceRun,
        prompt: walk.prompt || sourceRun.prompt,
        seed: walk.seed ?? sourceRun.seed,
        ...options,
      });
      exportsByCharacter.set(characterId, exported);
      return exported;
    },
  };
}
