// Client for the local proxy (server/index.mjs). Start a job, poll to completion.

export interface Job<T = any> { id: string; status: "processing" | "succeeded" | "failed"; output: T | null; error: string | null; kind: string; meta: any; }

// Parse a response defensively — an empty body (proxy restarting → 502/blank) must not crash with
// "Unexpected end of JSON input"; surface a clear, actionable error instead.
async function safeJson(r: Response, label: string): Promise<any> {
  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`${label} failed (${r.status})${text ? `: ${text.slice(0, 140)}` : " — is the dev server (npm run dev) running?"}`);
  if (!text.trim()) throw new Error(`${label}: empty response — the proxy may be restarting. Try again.`);
  try { return JSON.parse(text); } catch { throw new Error(`${label}: unexpected response — ${text.slice(0, 100)}`); }
}

async function post(path: string, body: unknown): Promise<{ id: string }> {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => { throw new Error(`Can't reach ${path} — is the dev server running?`); });
  return safeJson(r, path);
}

export async function pollJob<T = any>(id: string, onTick?: (j: Job<T>) => void, intervalMs = 900): Promise<Job<T>> {
  let softErrors = 0;
  for (;;) {
    let j: Job<T>;
    try { j = await safeJson(await fetch(`/api/status/${id}`), "status"); softErrors = 0; }
    catch (e) { if (++softErrors > 6) throw e; await new Promise((r) => setTimeout(r, intervalMs)); continue; } // tolerate brief proxy restarts
    onTick?.(j);
    if (j.status === "succeeded" || j.status === "failed") return j;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export interface GenerateReq { prompt: string; styleKey?: string; size?: number; tier?: "fast" | "plus"; seed?: number; view?: "side" | "isometric" | "topdown"; }
export interface GenerateOut { images: string[]; cost?: number; balance?: number; }
export async function generate(req: GenerateReq): Promise<Job<GenerateOut>> {
  const { id } = await post("/api/generate", req);
  return pollJob<GenerateOut>(id);
}

export interface AnimateReq { image: string; action?: string; frames?: number; size?: number; prompt?: string; palette?: string; }
export interface AnimateOut { sheet?: string; frameUrls?: string[]; frames: number; frameW: number; frameH: number; cols?: number; rows?: number; topdown?: boolean; cost?: number; balance?: number; }
export async function animate(req: AnimateReq): Promise<Job<AnimateOut>> {
  const { id } = await post("/api/animate", req);
  return pollJob<AnimateOut>(id);
}

export interface Health { mock: boolean; live?: boolean; provider?: string; animate?: string; balance?: number; credits?: number; }
export interface TilesReq { prompt: string; size?: number; seamless?: boolean; kind?: string; }
export async function tiles(req: TilesReq): Promise<Job<GenerateOut>> {
  const { id } = await post("/api/tiles", req);
  return pollJob<GenerateOut>(id);
}

export async function health(): Promise<Health> {
  try { return await (await fetch("/api/health")).json(); } catch { return { mock: true }; }
}
