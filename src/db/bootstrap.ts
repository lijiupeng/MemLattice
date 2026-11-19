import type { AppConfig } from '../config.js';
import type { Sql } from './client.js';

export interface DefaultBlock {
  label: 'persona' | 'rules' | 'skills';
  slot: string;
  charLimit: number;
  readOnly: boolean;
  content: string;
}

/** FR-01：三类块与默认字符上限。rules 只允许人工修改。 */
export const DEFAULT_BLOCKS: DefaultBlock[] = [
  {
    label: 'persona',
    slot: 'default',
    // 与 SurfCore 的 persona.compactChars 对齐：2200 字，够放一整张人格卡
    charLimit: 2200,
    readOnly: false,
    content: '',
  },
  {
    label: 'rules',
    slot: 'default',
    charLimit: 2000,
    readOnly: true,
    content: '',
  },
  {
    label: 'skills',
    slot: 'default',
    charLimit: 4000,
    readOnly: false,
    content: '',
  },
];

export async function ensureUser(sql: Sql, cfg: AppConfig): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    INSERT INTO app_user (external_id, display_name)
    VALUES (${cfg.user.externalId}, ${cfg.user.displayName})
    ON CONFLICT (external_id) DO UPDATE
      SET display_name = COALESCE(app_user.display_name, EXCLUDED.display_name)
    RETURNING id`;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('无法创建默认用户');
  return Number(id);
}

export async function ensureBlocks(sql: Sql, userId: number): Promise<void> {
  for (const block of DEFAULT_BLOCKS) {
    await sql`
      INSERT INTO mem_block (user_id, label, slot, content, char_limit, read_only, source)
      VALUES (${userId}, ${block.label}, ${block.slot}, ${block.content}, ${block.charLimit}, ${block.readOnly}, 'human')
      ON CONFLICT (user_id, label, slot) WHERE deleted_at IS NULL DO NOTHING`;
  }
  // skills 的 default 槽是「通用经验」条目（会参与 L1 注入）；按词条目用 skill:<term_id>
  await sql`
    UPDATE mem_block SET char_limit = 4000
    WHERE user_id = ${userId} AND label = 'skills' AND slot = 'default'`;
  // 老库的 persona 还停在 2000：建表是 DO NOTHING，不补这一句就永远升不上去
  await sql`
    UPDATE mem_block SET char_limit = 2200
    WHERE user_id = ${userId} AND label = 'persona' AND slot = 'default' AND char_limit < 2200`;
}

export async function bootstrap(sql: Sql, cfg: AppConfig): Promise<number> {
  const userId = await ensureUser(sql, cfg);
  await ensureBlocks(sql, userId);
  return userId;
}
