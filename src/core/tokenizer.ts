import { hasCjk, isCjkCodePoint } from './text.js';

export interface Tokenizer {
  readonly name: string;
  cut(text: string): string[];
}

const STOPWORDS = new Set(
  (
    '的 了 是 在 和 与 就 都 也 还 而 及 或 被 把 对 从 到 为 以 于 之 其 该 这 那 这个 那个 这些 那些 ' +
    '我 你 他 她 它 我们 你们 他们 自己 什么 怎么 怎样 如何 为什么 哪个 哪些 多少 是否 可以 需要 应该 ' +
    '一个 一些 一下 现在 今天 明天 昨天 时候 问题 情况 方面 进行 通过 已经 没有 不是 就是 但是 因为 所以 ' +
    'the a an and or of to in on for with is are was were be been it this that these those i you he she we they ' +
    'what how why when where which do does did can could should would'
  ).split(/\s+/),
);

const PUNCT_ONLY = /^[\p{P}\p{S}\s]+$/u;

export function isUsefulToken(token: string): boolean {
  const t = token.trim();
  if (t.length < 2) return false;
  if (PUNCT_ONLY.test(t)) return false;
  if (STOPWORDS.has(t.toLowerCase())) return false;
  if (/^\d+$/.test(t)) return false;
  return true;
}

export function uniqueTokens(tokens: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tokens) {
    const t = raw.trim().toLowerCase();
    if (!t || seen.has(t) || !isUsefulToken(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 无原生分词器时的降级：中文按二元组切分，拉丁按词切分，保证不会把"选哪个好"切成单字。 */
export function createFallbackTokenizer(): Tokenizer {
  return {
    name: 'fallback-bigram',
    cut(text: string): string[] {
      const out: string[] = [];
      const latin = text.match(/[A-Za-z][A-Za-z0-9_+#.-]*/g) ?? [];
      out.push(...latin);

      let run = '';
      const flush = (): void => {
        if (run.length >= 2) {
          if (run.length <= 4) {
            out.push(run);
          }
          for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
        }
        run = '';
      };
      for (const ch of text) {
        const cp = ch.codePointAt(0) ?? 0;
        if (isCjkCodePoint(cp) && !/[\u3000-\u303f\uff00-\uffef]/.test(ch)) {
          run += ch;
        } else {
          flush();
        }
      }
      flush();
      return out;
    },
  };
}

interface JiebaModule {
  cut(text: string, hmm?: boolean): string[];
}

let cached: Tokenizer | undefined;
let cachedPromise: Promise<Tokenizer> | undefined;

export async function createTokenizer(): Promise<Tokenizer> {
  if (cached) return cached;
  if (cachedPromise) return cachedPromise;
  cachedPromise = (async (): Promise<Tokenizer> => {
    try {
      const specifier = '@node-rs/jieba';
      const mod = (await import(specifier)) as unknown as JiebaModule;
      if (typeof mod.cut !== 'function') throw new Error('cut() missing');
      cached = {
        name: 'jieba',
        cut: (text: string) => mod.cut(text, true),
      };
    } catch {
      cached = createFallbackTokenizer();
    }
    return cached;
  })();
  return cachedPromise;
}

export function tokenizeKeywords(tokenizer: Tokenizer, text: string): string[] {
  if (!hasCjk(text)) {
    return uniqueTokens(tokenizer.cut(text));
  }
  return uniqueTokens(tokenizer.cut(text));
}
