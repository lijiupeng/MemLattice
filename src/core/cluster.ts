export interface ClusterNodeInput {
  id: number;
  name: string;
  kind: string;
  heat: number;
  weight?: number;
}

export interface ClusterEdgeInput {
  src: number;
  dst: number;
}

export interface GraphCluster {
  id: string;
  name: string;
  node_count: number;
  heat: number;
  kind: string;
}

export interface ClusterAssignment {
  assignments: Map<number, string>;
  clusters: GraphCluster[];
}

const KIND_LABEL: Record<string, string> = {
  entity: '实体',
  intent: '意图',
  concept: '概念',
};

/**
 * 图谱首屏的簇划分：优先取图结构（连通分量），结构不足时按 kind 兜底。
 * 簇是显示层概念，不落库（原则 1：单一真相源，图只是索引）。
 */
export function clusterGraph(
  nodes: readonly ClusterNodeInput[],
  edges: readonly ClusterEdgeInput[],
  options: { maxClusterSize?: number } = {},
): ClusterAssignment {
  const maxSize = Math.max(3, options.maxClusterSize ?? 30);
  const assignments = new Map<number, string>();
  if (nodes.length === 0) return { assignments, clusters: [] };

  const parent = new Map<number, number>();
  for (const node of nodes) parent.set(node.id, node.id);

  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) {
      const next = parent.get(root);
      if (next === undefined) break;
      root = next;
    }
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      if (next === undefined) break;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.src) || !nodeIds.has(edge.dst)) continue;
    union(edge.src, edge.dst);
  }

  const groups = new Map<number, ClusterNodeInput[]>();
  for (const node of nodes) {
    const root = find(node.id);
    const list = groups.get(root) ?? [];
    list.push(node);
    groups.set(root, list);
  }

  const chunks: ClusterNodeInput[][] = [];
  for (const group of groups.values()) {
    if (group.length <= maxSize) {
      chunks.push(group);
      continue;
    }
    // 超大分量按 kind 分组，再按热度切片
    const byKind = new Map<string, ClusterNodeInput[]>();
    for (const node of group) {
      const list = byKind.get(node.kind) ?? [];
      list.push(node);
      byKind.set(node.kind, list);
    }
    for (const list of byKind.values()) {
      list.sort((a, b) => b.heat - a.heat);
      for (let i = 0; i < list.length; i += maxSize) {
        chunks.push(list.slice(i, i + maxSize));
      }
    }
  }

  chunks.sort((a, b) => sumHeat(b) - sumHeat(a));

  const clusters: GraphCluster[] = [];
  chunks.forEach((chunk, index) => {
    const id = `cl:${index + 1}`;
    const sorted = [...chunk].sort((a, b) => b.heat - a.heat);
    const top = sorted[0];
    const kind = dominantKind(chunk);
    const name =
      chunk.length === 1
        ? (top?.name ?? '单点簇')
        : `${top?.name ?? '簇'} 等 ${chunk.length} 个词`;
    for (const node of chunk) assignments.set(node.id, id);
    clusters.push({
      id,
      name,
      node_count: chunk.length,
      heat: Math.round(sumHeat(chunk) * 10000) / 10000,
      kind,
    });
  });

  return { assignments, clusters };
}

function sumHeat(nodes: readonly ClusterNodeInput[]): number {
  return nodes.reduce((sum, n) => sum + (Number.isFinite(n.heat) ? n.heat : 0), 0);
}

function dominantKind(nodes: readonly ClusterNodeInput[]): string {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  let best = 'concept';
  let max = -1;
  for (const [kind, count] of counts) {
    if (count > max) {
      max = count;
      best = kind;
    }
  }
  return KIND_LABEL[best] ?? best;
}
