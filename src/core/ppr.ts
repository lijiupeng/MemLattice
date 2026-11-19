export interface PprEdge {
  src: number;
  dst: number;
  weight: number;
}

export interface PprOptions {
  damping?: number;
  iterations?: number;
}

/**
 * 个性化 PageRank，跑在局部子图上（8.2：全图 PPR 不可行，子图规模下 20 次迭代约 5–15ms）。
 * 返回按最大值归一化到 [0,1] 的分数。
 */
export function personalizedPageRank(
  nodeIds: readonly number[],
  edges: readonly PprEdge[],
  seeds: ReadonlyMap<number, number>,
  options: PprOptions = {},
): Map<number, number> {
  const damping = options.damping ?? 0.85;
  const iterations = options.iterations ?? 20;
  const n = nodeIds.length;
  const result = new Map<number, number>();
  if (n === 0) return result;

  const index = new Map<number, number>();
  for (let i = 0; i < n; i++) index.set(nodeIds[i] as number, i);

  const outAdj: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  const outWeight = new Float64Array(n);
  for (const e of edges) {
    const s = index.get(e.src);
    const d = index.get(e.dst);
    if (s === undefined || d === undefined) continue;
    if (!(e.weight > 0)) continue;
    (outAdj[s] as Array<[number, number]>).push([d, e.weight]);
    outWeight[s] = (outWeight[s] as number) + e.weight;
  }

  // 个性化向量：种子加权分布；无种子退化为均匀分布。
  const p = new Float64Array(n);
  let seedMass = 0;
  for (const [id, w] of seeds) {
    const i = index.get(id);
    if (i === undefined || !(w > 0)) continue;
    p[i] = (p[i] as number) + w;
    seedMass += w;
  }
  if (seedMass === 0) {
    for (let i = 0; i < n; i++) p[i] = 1 / n;
  } else {
    for (let i = 0; i < n; i++) p[i] = (p[i] as number) / seedMass;
  }

  let r = Float64Array.from(p);
  let next = new Float64Array(n);
  for (let iter = 0; iter < iterations; iter++) {
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if ((outWeight[i] as number) === 0) dangling += r[i] as number;
    }
    for (let i = 0; i < n; i++) next[i] = (1 - damping) * (p[i] as number);
    for (let i = 0; i < n; i++) {
      const ri = r[i] as number;
      if (ri === 0) continue;
      const ow = outWeight[i] as number;
      if (ow === 0) continue;
      for (const [target, w] of outAdj[i] as Array<[number, number]>) {
        next[target] = (next[target] as number) + (damping * ri * w) / ow;
      }
    }
    if (dangling > 0) {
      for (let i = 0; i < n; i++) {
        next[i] = (next[i] as number) + damping * dangling * (p[i] as number);
      }
    }
    const tmp = r;
    r = next;
    next = tmp;
  }

  let max = 0;
  for (let i = 0; i < n; i++) max = Math.max(max, r[i] as number);
  for (let i = 0; i < n; i++) {
    result.set(nodeIds[i] as number, max > 0 ? (r[i] as number) / max : 0);
  }
  return result;
}
