import type { ForgeDirection } from "./characterForge.ts";

export type ForgeJobStatus = "queued" | "processing" | "resumable" | "succeeded" | "failed";

export interface ForgeUpstreamJob {
  id: string;
  direction: ForgeDirection | null;
  status: "processing" | "completed";
}

export interface ForgeJob {
  id: string;
  kind: "identity" | "walk" | "export";
  status: ForgeJobStatus;
  progress: number;
  characterId: string | null;
  upstreamJobIds: string[];
  upstreamJobs: ForgeUpstreamJob[];
  usage: number;
  result: unknown;
  error: { code: string; message: string; status: number | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ForgeHealth {
  configured: boolean;
  provider: "pixellab-v2";
  balance?: {
    credits?: { type: string; usd: number };
    subscription?: { type?: string; status?: string; plan?: string; generations: number; total: number };
  };
}

export interface ForgeCharacterInput {
  name: string;
  sourceName?: string;
  description: string;
  referenceImage: string;
  seed: number;
}

export interface ForgeAnimationDirection {
  direction: ForgeDirection;
  frame_count: number;
  frames: string[];
}

export interface ForgeAnimationGroup {
  animation_type: string;
  display_name?: string | null;
  animation_group_id?: string | null;
  directions: ForgeAnimationDirection[];
}

export interface ForgeCharacterDetail {
  id: string;
  name: string;
  status: string;
  rotation_urls: Partial<Record<ForgeDirection, string>>;
  animations: ForgeAnimationGroup[];
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ForgeApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ForgeApiError";
    this.code = code;
    this.status = status;
  }
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<T> {
  const response = await fetchImpl(path, init);
  const body = await response.json().catch(() => null) as { code?: string; message?: string } | null;
  if (!response.ok) {
    throw new ForgeApiError(
      body?.message || `Forge request failed with status ${response.status}.`,
      body?.code || "FORGE_ERROR",
      response.status,
    );
  }
  return body as T;
}

export function getForgeHealth(fetchImpl: FetchLike = globalThis.fetch): Promise<ForgeHealth> {
  return requestJson<ForgeHealth>("/api/forge/health", {}, fetchImpl);
}

export function createForgeCharacter(
  input: ForgeCharacterInput,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<ForgeJob> {
  return requestJson<ForgeJob>(
    "/api/forge/characters",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    fetchImpl,
  );
}

export function createForgeWalk(
  characterId: string,
  input: { prompt: string; seed: number },
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<ForgeJob> {
  return requestJson<ForgeJob>(
    `/api/forge/characters/${encodeURIComponent(characterId)}/walk`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    fetchImpl,
  );
}

export function getForgeCharacter<T = unknown>(
  characterId: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<T> {
  return requestJson<T>(`/api/forge/characters/${encodeURIComponent(characterId)}`, {}, fetchImpl);
}

export async function pollForgeJob(
  jobId: string,
  onProgress: (job: ForgeJob) => void,
  options: {
    intervalMs?: number;
    maxAttempts?: number;
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
  } = {},
): Promise<ForgeJob> {
  const {
    intervalMs = 2000,
    maxAttempts = 450,
    signal,
    fetchImpl = globalThis.fetch,
  } = options;
  const localController = signal ? null : new AbortController();
  const requestSignal = signal || localController?.signal;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (requestSignal?.aborted) throw new DOMException("Forge polling aborted.", "AbortError");
    const job = await requestJson<ForgeJob>(
      `/api/forge/jobs/${encodeURIComponent(jobId)}`,
      { signal: requestSignal },
      fetchImpl,
    );
    onProgress(job);
    if (job.status === "succeeded") return job;
    if (job.status === "failed") {
      throw new ForgeApiError(
        job.error?.message || "The character forge job failed.",
        job.error?.code || "FORGE_JOB_FAILED",
        job.error?.status || 502,
      );
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new ForgeApiError("The local forge job did not finish before the polling limit.", "LOCAL_TIMEOUT", 504);
}

export function forgeExportUrl(characterId: string): string {
  return `/api/forge/characters/${encodeURIComponent(characterId)}/export`;
}
