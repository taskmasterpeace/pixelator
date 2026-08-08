// Minimal IndexedDB-backed asset library (offline-first — every result auto-saves locally).
export type AssetKind = "image" | "animation" | "tile" | "voxel";
export interface Asset {
  id: string;
  kind: AssetKind;
  name: string;
  dataUrl: string;                 // PNG (sheet for animations) — the thing you can re-open/export
  meta?: Record<string, unknown>;  // frames, size, prompt, engine…
  createdAt: number;
}

const DB = "pixelator", STORE = "assets";
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { const d = req.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
function tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return db().then((d) => d.transaction(STORE, mode).objectStore(STORE));
}

export async function saveAsset(a: Omit<Asset, "id" | "createdAt"> & Partial<Pick<Asset, "id" | "createdAt">>): Promise<Asset> {
  const full: Asset = { id: a.id ?? `${a.kind}_${Date.now()}_${Math.round(performance.now())}`, createdAt: a.createdAt ?? Date.now(), ...a } as Asset;
  const store = await tx("readwrite");
  return new Promise((resolve, reject) => { const r = store.put(full); r.onsuccess = () => resolve(full); r.onerror = () => reject(r.error); });
}
export async function listAssets(): Promise<Asset[]> {
  const store = await tx("readonly");
  return new Promise((resolve, reject) => { const r = store.getAll(); r.onsuccess = () => resolve((r.result as Asset[]).sort((a, b) => b.createdAt - a.createdAt)); r.onerror = () => reject(r.error); });
}
export async function deleteAsset(id: string): Promise<void> {
  const store = await tx("readwrite");
  return new Promise((resolve, reject) => { const r = store.delete(id); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
}
