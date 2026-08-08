// 2D → 3D voxelizer. Turns a pixel sprite into a voxel model by extruding each
// opaque pixel into a column along Z. Depth profile is either flat (2.5D slab) or
// "rounded" — thickness derived from a distance-to-edge transform so blobs bulge in
// the middle and taper at the silhouette (the GazPrash "single" mode idea).
export interface Voxel { x: number; y: number; z: number; r: number; g: number; b: number; }
export interface VoxResult { voxels: Voxel[]; w: number; h: number; d: number; }
export type DepthProfile = "flat" | "rounded";

const ALPHA = 24;

/** Multi-source BFS distance from the background → distance-to-edge for each opaque pixel. */
function distanceToEdge(occ: Uint8Array, w: number, h: number): Int32Array {
  const dist = new Int32Array(w * h).fill(-1);
  const q: number[] = [];
  // seeds: every background pixel, plus opaque pixels touching the canvas border
  for (let p = 0; p < w * h; p++) {
    if (!occ[p]) { dist[p] = 0; q.push(p); }
  }
  // border-touching opaque pixels count as edge (distance 0's neighbours)
  let head = 0;
  while (head < q.length) {
    const p = q[head++]; const x = p % w, y = (p - x) / w; const nd = dist[p] + 1;
    const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
    for (const n of nb) { if (n >= 0 && occ[n] && dist[n] < 0) { dist[n] = nd; q.push(n); } }
  }
  // opaque pixels never reached (fully enclosed with no bg path shouldn't happen) → give them max
  return dist;
}

export function voxelize(img: ImageData, opts: { maxDepth: number; profile: DepthProfile }): VoxResult {
  const { width: w, height: h, data } = img;
  const occ = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) occ[p] = data[p * 4 + 3] > ALPHA ? 1 : 0;

  let maxDist = 1;
  const dist = opts.profile === "rounded" ? distanceToEdge(occ, w, h) : null;
  if (dist) for (let p = 0; p < w * h; p++) if (dist[p] > maxDist) maxDist = dist[p];

  const voxels: Voxel[] = [];
  let maxD = 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (!occ[p]) continue;
    const i = p * 4, r = data[i], g = data[i + 1], b = data[i + 2];
    let depth: number;
    if (dist) {
      const t = Math.max(0.0001, dist[p] / maxDist);       // 0 at edge → 1 at core
      depth = 1 + Math.round((opts.maxDepth - 1) * Math.sqrt(t)); // sqrt → rounder shoulders
    } else {
      depth = opts.maxDepth;
    }
    if (depth > maxD) maxD = depth;
    const z0 = -((depth - 1) / 2);                          // centre the column on z=0
    for (let dz = 0; dz < depth; dz++) {
      voxels.push({ x, y: h - 1 - y, z: Math.round(z0 + dz), r, g, b }); // flip Y (image → world up)
    }
  }
  return { voxels, w, h, d: maxD };
}

/** Export the voxel set as a Wavefront OBJ — only faces exposed to empty space. */
export function voxelsToOBJ(res: VoxResult): string {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const set = new Set(res.voxels.map((v) => key(v.x, v.y, v.z)));
  const verts: string[] = []; const faces: string[] = []; const vmap = new Map<string, number>();
  const vi = (x: number, y: number, z: number) => {
    const k = key(x, y, z); let id = vmap.get(k);
    if (id === undefined) { verts.push(`v ${x} ${y} ${z}`); id = verts.length; vmap.set(k, id); }
    return id;
  };
  // 6 face definitions: normal offset + the 4 corner offsets (unit cube around voxel centre)
  const F: [number[], number[][]][] = [
    [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
    [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
    [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]],
    [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
    [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
  ];
  for (const v of res.voxels) {
    for (const [nrm, corners] of F) {
      if (set.has(key(v.x + nrm[0], v.y + nrm[1], v.z + nrm[2]))) continue; // hidden internal face
      const ids = corners.map((c) => vi(v.x + c[0], v.y + c[1], v.z + c[2]));
      faces.push(`f ${ids[0]} ${ids[1]} ${ids[2]} ${ids[3]}`);
    }
  }
  return `# Pixelator voxel export\n${verts.join("\n")}\n${faces.join("\n")}\n`;
}
