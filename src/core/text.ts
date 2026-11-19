import { createHash } from 'node:crypto';

/** 全角转半角 + 小写 + 压缩空白，用于词典匹配与去重。 */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef)
  );
}

export function hasCjk(text: string): boolean {
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/** 按字符截断，不切断代理对，超长补省略号。 */
export function clampText(text: string, maxChars: number): string {
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  if (maxChars <= 1) return chars.slice(0, Math.max(0, maxChars)).join('');
  return chars.slice(0, maxChars - 1).join('') + '…';
}

export function hashContent(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

export function uniq<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 简易相似度：字符二元组 Dice 系数，用于别名/合并候选。 */
export function diceSimilarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  // 短词（如"股票/股市"）二元组没有交集，退化为字符重叠度
  if (x.length < 3 || y.length < 3) {
    const setA = new Set([...x]);
    const setB = new Set([...y]);
    let shared = 0;
    for (const ch of setA) if (setB.has(ch)) shared += 1;
    return (2 * shared) / (setA.size + setB.size);
  }
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(x);
  const gb = grams(y);
  let inter = 0;
  for (const [g, c] of ga) inter += Math.min(c, gb.get(g) ?? 0);
  const total = x.length - 1 + (y.length - 1);
  return total === 0 ? 0 : (2 * inter) / total;
}
