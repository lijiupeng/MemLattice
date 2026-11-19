import { isCjkCodePoint } from './text.js';

/**
 * token 估算：中文按 1 字 1 token 保守计，其余按 3.5 字符 1 token。
 * 该估算只用于预算裁剪，宁严不松（G1：峰值 ≤1200）。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 3.5);
}

export function trimToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  let cjk = 0;
  let other = 0;
  let out = '';
  for (const ch of text) {
    const isCjk = isCjkCodePoint(ch.codePointAt(0) ?? 0);
    if (isCjk) cjk++;
    else other++;
    if (Math.ceil(cjk + other / 3.5) > maxTokens) break;
    out += ch;
  }
  return out;
}
