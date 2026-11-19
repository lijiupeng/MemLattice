/* eslint-disable no-console */
/**
 * HTTP 层冒烟：真实启动 dist/index.js，验证鉴权、REST、静态资源与 MCP Streamable HTTP（含会话头）。
 * 前置：npm run build && npm run web:build
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

import { freePort } from './ports.js';

const TOKEN = 'smoke-token';
let APP_PORT = 0;
let BASE = '';
const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function req(
  path: string,
  init: RequestInit & { token?: string | null; origin?: string } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  if (init.origin) headers.origin = init.origin;
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

async function mcp(
  payload: unknown,
  sessionId?: string,
): Promise<{ status: number; body: any; sessionId?: string }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TOKEN}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const sid = res.headers.get('mcp-session-id') ?? sessionId;
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  let body: any = null;
  if (text) {
    if (contentType.includes('text/event-stream')) {
      const line = text.split('\n').find((l) => l.startsWith('data:'));
      body = line ? JSON.parse(line.replace(/^data:\s*/, '')) : null;
    } else {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
  }
  return { status: res.status, body, sessionId: sid };
}

async function waitForHealth(timeoutMs = 40_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not ready */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'memlattice-http-pg-'));
  const pgPort = await freePort(55460);
  APP_PORT = await freePort(8790);
  BASE = `http://127.0.0.1:${APP_PORT}`;
  console.log(`使用端口：pg=${pgPort} app=${APP_PORT}`);
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port: pgPort,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });

  let child: ChildProcess | null = null;

  const shutdown = async (code: number): Promise<void> => {
    child?.kill('SIGKILL');
    await pg.stop().catch(() => {});
    process.exit(code);
  };
  process.once('SIGINT', () => void shutdown(130));
  process.once('SIGTERM', () => void shutdown(143));

  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('memlattice');

    child = spawn(process.execPath, ['dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(APP_PORT),
        HOST: '127.0.0.1',
        DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${pgPort}/memlattice`,
        MEMLATTICE_TOKEN: TOKEN,
        WORKER_ENABLED: 'false',
        // 审核链路用例需要名单生效：显式配置，不依赖代码默认值
        BLOCK_APPROVAL_LABELS: 'rules,persona',
        LOG_LEVEL: 'warn',
        RUN_MIGRATIONS: 'true',
        WEB_DIR: join(process.cwd(), 'web', 'dist'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout?.on('data', (chunk) => {
      serverLog += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      serverLog += String(chunk);
    });

    const ready = await waitForHealth();
    check('服务启动并健康检查通过', ready);
    if (!ready) {
      console.log(serverLog.slice(-2000));
      return;
    }

    const noAuth = await req('/api/cards', { token: null });
    check('无 token 请求被拒（FR-11）', noAuth.status === 401 && noAuth.body?.error?.code === 'E_AUTH', `status=${noAuth.status}`);

    const listEmpty = await req('/api/cards');
    check('鉴权后可读取列表', listEmpty.status === 200 && Array.isArray(listEmpty.body?.items));

    const badOrigin = await req('/api/write', {
      method: 'POST',
      origin: 'https://evil.example',
      body: JSON.stringify({ messages: [{ role: 'user', content: '测试' }] }),
    });
    check('跨站 Origin 被拒（NFR-04）', badOrigin.status === 403, `status=${badOrigin.status}`);

    const writeRes = await req('/api/write', {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          { role: 'user', content: '股票行情怎么样，新能源和算力选哪个好？帮我推荐一个方向。' },
          { role: 'assistant', content: '结论：新能源资金流出，算力更强，建议减新能源仓位到三成，保留底仓。' },
        ],
        close: true,
        scope: 'http-smoke',
        card: {
          summary:
            '股票行情与新能源、算力方向的选择讨论：用户要在两个方向中选一个并希望得到明确推荐。结论是减新能源仓位、优先算力方向，保留底仓观察。',
          intent: '求推荐',
          keywords: ['股票行情', '新能源', '算力', '仓位', '推荐'],
          importance: 0.8,
        },
      }),
    });
    check(
      '写入并浓缩为事件卡',
      writeRes.status === 200 && typeof writeRes.body?.card_id === 'number',
      `card=${writeRes.body?.card_id}`,
    );

    const cardDetail = await req(`/api/cards/${writeRes.body?.card_id}`);
    check(
      '关键词采用调用方传参（服务端不生成）',
      JSON.stringify(cardDetail.body?.card?.keywords) ===
        JSON.stringify(['股票行情', '新能源', '算力', '仓位', '推荐']) &&
        cardDetail.body?.card?.intent === '求推荐',
      `keywords=${JSON.stringify(cardDetail.body?.card?.keywords)}`,
    );

    const recallRes = await req('/api/recall', {
      method: 'POST',
      body: JSON.stringify({ query: '股票行情新能源算力怎么选', budget_tokens: 1200 }),
    });
    check(
      'recall 端到端可用且不超预算（G1）',
      recallRes.status === 200 && recallRes.body.budget_used <= 1200,
      `used=${recallRes.body?.budget_used}`,
    );

    const overBudget = await req('/api/recall', {
      method: 'POST',
      body: JSON.stringify({ query: '股票', budget_tokens: 9999 }),
    });
    check(
      '超系统上限返回 E_BUDGET_EXCEEDED',
      overBudget.status === 422 && overBudget.body?.error?.code === 'E_BUDGET_EXCEEDED',
      `status=${overBudget.status}`,
    );

    // ---- 重复性判定：同会话续写并入原卡 ----
    const appendFirst = await req('/api/write', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'http-append',
        close: true,
        messages: [
          { role: 'user', content: '发布流程改成金丝雀：先 10% 流量，异常自动回滚。' },
          { role: 'assistant', content: '金丝雀阶段盯错误率和延迟，超阈自动回滚。' },
        ],
        card: {
          summary: '发布流程改为金丝雀：先放 10% 流量，监控错误率与延迟，异常时自动回滚到上一版本。',
          keywords: ['发布', '金丝雀', '回滚'],
          intent: '决策',
        },
      }),
    });
    const appendSecond = await req('/api/write', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'http-append',
        append_to: appendFirst.body?.card_id,
        messages: [
          { role: 'user', content: '继续：金丝雀放到 30%，加灰度白名单。' },
          { role: 'assistant', content: '好，30% 阶段加白名单，回滚阈值不变。' },
        ],
        card: {
          summary: '继续完善发布：金丝雀扩到 30% 并加入灰度白名单，自动回滚阈值保持不变。',
          keywords: ['发布', '金丝雀', '灰度'],
          intent: '决策',
        },
      }),
    });
    check(
      'append_to 未 close 也立即并入并返回 target_card_id（REST）',
      appendSecond.body?.appended === true &&
        appendSecond.body?.card_id === appendFirst.body?.card_id &&
        appendSecond.body?.target_card_id === appendFirst.body?.card_id &&
        appendSecond.body?.card_pending === false,
      `card=${appendSecond.body?.card_id} target=${appendSecond.body?.target_card_id}`,
    );

    const noAppend = await req('/api/write', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'http-append',
        close: true,
        messages: [
          { role: 'user', content: '同一件事再记：下周金丝雀到 50%。' },
          { role: 'assistant', content: '收到，下周 50%，阈值不变。' },
        ],
        card: {
          summary: '发布计划：下周把金丝雀流量提到 50%，回滚阈值与白名单策略保持不变。',
          keywords: ['发布', '金丝雀', '计划'],
          intent: '决策',
        },
      }),
    });
    check(
      '未传 append_to 时服务端不擅自合并',
      noAppend.body?.appended !== true && noAppend.body?.card_id !== appendFirst.body?.card_id,
      `card=${noAppend.body?.card_id}`,
    );

    const replaceRes = await req('/api/write', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'http-append',
        append_to: appendFirst.body?.card_id,
        summary_mode: 'replace',
        messages: [
          { role: 'user', content: '结论更新：改为蓝绿发布，金丝雀只用于回滚验证。' },
          { role: 'assistant', content: '收到，蓝绿为主。' },
        ],
        card: {
          summary: '发布方案改为蓝绿：两套环境切换，金丝雀仅保留用于回滚验证，白名单与阈值不变。',
          keywords: ['发布', '蓝绿', '回滚'],
          intent: '决策',
        },
      }),
    });
    const replacedCard = await req(`/api/cards/${appendFirst.body?.card_id}`);
    check(
      'summary_mode=replace 覆盖原摘要（REST）',
      replaceRes.body?.appended === true &&
        String(replacedCard.body?.card?.summary ?? '').startsWith('发布方案改为蓝绿') &&
        !String(replacedCard.body?.card?.summary ?? '').includes('追加'),
      `summary=${String(replacedCard.body?.card?.summary ?? '').slice(0, 20)}`,
    );

    const mergedCard = await req(`/api/cards/${appendFirst.body?.card_id}`);
    check(
      '并入后版本递增且关键词取并集',
      Number(mergedCard.body?.card?.version) >= 2 &&
        Array.isArray(mergedCard.body?.card?.keywords) &&
        mergedCard.body?.card?.keywords.includes('灰度'),
      `v=${mergedCard.body?.card?.version} kw=${JSON.stringify(mergedCard.body?.card?.keywords)}`,
    );

    const graphRes = await req('/api/graph?limit=100');
    check(
      '图谱接口返回节点与簇（FR-12）',
      graphRes.status === 200 && graphRes.body.nodes.length >= 1 && graphRes.body.clusters.length >= 1,
      `nodes=${graphRes.body?.nodes?.length} clusters=${graphRes.body?.clusters?.length}`,
    );

    // ---- 径向全图：L1 根 + 全部事件卡 + 全部关键词 ----
    const radialRes = await req('/api/graph/radial?min_cards=1');
    const radialNodes: Array<{ id: string; type: string }> = radialRes.body?.nodes ?? [];
    check(
      '径向图谱返回根+全部卡+全部词',
      radialRes.status === 200 &&
        radialNodes.some((n) => n.id === 'l1:root') &&
        radialNodes.some((n) => n.type === 'card') &&
        radialNodes.some((n) => n.type === 'term') &&
        (radialRes.body?.edges ?? []).some((e: { type: string }) => e.type === 'holds') &&
        (radialRes.body?.edges ?? []).some((e: { type: string }) => e.type === 'mentions'),
      `nodes=${radialNodes.length} edges=${radialRes.body?.edges?.length}`,
    );

    const indexRes = await req('/', { headers: { accept: 'text/html' } });
    check(
      'SPA 静态资源由同一服务托管',
      indexRes.status === 200 && String(indexRes.body).includes('id="app"'),
      `status=${indexRes.status}`,
    );

    const metricsRes = await req('/api/metrics');
    check(
      '指标接口可用（NFR-07）',
      metricsRes.status === 200 && metricsRes.body?.counts?.cards >= 1,
      `cards=${metricsRes.body?.counts?.cards}`,
    );

    // ---- MCP：initialize → tools/list → tools/call ----
    const init = await mcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'http-smoke', version: '1.0.0' },
      },
    });
    check(
      'MCP initialize 成功并下发会话头',
      init.status === 200 && init.body?.result?.serverInfo?.name === 'memlattice' && Boolean(init.sessionId),
      `status=${init.status}`,
    );

    const sid = init.sessionId;
    await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);

    const toolsList = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
    const toolNames = (toolsList.body?.result?.tools ?? []).map((tool: { name: string }) => tool.name);
    check(
      'MCP 暴露 13 个工具（G5）',
      toolNames.length === 13 &&
        [
          'memory.start',
          'memory.recall',
          'memory.inspect',
          'memory.expand',
          'memory.sleep',
          'memory.triage',
          'memory.write',
          'memory.write.batch',
          'memory.cards',
          'memory.feedback',
          'memory.correct',
          'memory.forget',
          'memory.pending',
        ].every((name) => toolNames.includes(name)),
      toolNames.join(','),
    );

    const tools = toolsList.body?.result?.tools ?? [];
    const expandSchema = tools.find((tool: { name: string }) => tool.name === 'memory.expand')?.inputSchema;
    check(
      'expand 不再声明未实现的 depth 参数',
      expandSchema?.properties?.depth === undefined && Boolean(expandSchema?.properties?.term),
    );

    const sleepCall = await mcp(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'memory.sleep', arguments: { limit: 3 } },
      },
      sid,
    );
    const sleepText = sleepCall.body?.result?.content?.[0]?.text;
    const sleepResult = typeof sleepText === 'string' ? JSON.parse(sleepText) : null;
    check(
      'memory.sleep 返回压力与清单',
      ['low', 'medium', 'high'].includes(sleepResult?.level) &&
        typeof sleepResult?.counts?.fading === 'number' &&
        Array.isArray(sleepResult?.queues?.doubtful),
      `level=${sleepResult?.level} reasons=${sleepResult?.reasons?.length ?? 0}`,
    );

    const triageCall = await mcp(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'memory.triage',
          arguments: { items: [{ type: 'term', id: 1 }], reason: 'http 冒烟' },
        },
      },
      sid,
    );
    const triageText = triageCall.body?.result?.content?.[0]?.text;
    const triageResult = typeof triageText === 'string' ? JSON.parse(triageText) : null;
    check(
      'memory.triage 接受批量标记',
      triageResult?.marked === 1,
      `marked=${triageResult?.marked}`,
    );

    const feedbackSchema = tools.find(
      (tool: { name: string }) => tool.name === 'memory.feedback',
    )?.inputSchema;
    check(
      'feedback 只声明 card_id 与 verdict 三态',
      JSON.stringify(feedbackSchema?.properties?.verdict?.enum) ===
        JSON.stringify(['wrong', 'irrelevant', 'helpful']) &&
        Array.isArray(feedbackSchema?.required) &&
        feedbackSchema.required.includes('card_id'),
    );

    const correctSchema = tools.find((tool: { name: string }) => tool.name === 'memory.correct')?.inputSchema;
    check(
      'correct 的 patch 声明了 card/block/term 字段',
      Boolean(correctSchema?.properties?.patch?.properties?.content) &&
        Boolean(correctSchema?.properties?.patch?.properties?.keywords),
    );

    const instructions = String(init.body?.result?.instructions ?? '');
    check('initialize instructions 覆盖 append_to 与审核语义', /append_to/.test(instructions) && /pending_approval/.test(instructions));

    const callTool = await mcp(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'memory.recall', arguments: { query: '股票行情', budget_tokens: 600 } },
      },
      sid,
    );
    const text = callTool.body?.result?.content?.[0]?.text;
    const parsed = typeof text === 'string' ? JSON.parse(text) : null;
    check(
      'MCP tools/call 完成一次真实召回',
      callTool.status === 200 && parsed?.budget_limit === 600 && parsed?.budget_used <= 600,
      `used=${parsed?.budget_used}`,
    );

    const writeTool = await mcp(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'memory.write',
          arguments: {
            messages: [{ role: 'user', content: '记一下：我后端偏好用 TypeScript。' }],
            close: true,
            card: {
              keywords: ['TypeScript', '后端偏好', '技术栈'],
              intent: '信息同步',
              summary:
                '用户表明后端技术栈偏好为 TypeScript：后续架构与示例默认按 TypeScript 方案给出，除非用户明确要求改用其它语言。',
            },
          },
        },
      },
      sid,
    );
    const writeToolText = writeTool.body?.result?.content?.[0]?.text;
    const writeToolResult = typeof writeToolText === 'string' ? JSON.parse(writeToolText) : null;
    check(
      'MCP write 接受 card 参数并立即成卡',
      writeToolResult?.card_pending === false && typeof writeToolResult?.card_id === 'number',
      `card=${writeToolResult?.card_id}`,
    );

    const mcpCard = await req(`/api/cards/${writeToolResult?.card_id}`);
    check(
      'MCP 传入的关键词原样落库',
      JSON.stringify(mcpCard.body?.card?.keywords) ===
        JSON.stringify(['TypeScript', '后端偏好', '技术栈']),
      `keywords=${JSON.stringify(mcpCard.body?.card?.keywords)}`,
    );

    const feedbackRes = await req(`/api/cards/${writeToolResult?.card_id}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ verdict: 'wrong', note: 'http 冒烟：验证 REST 表态' }),
    });
    check(
      'REST feedback 下调置信度',
      feedbackRes.status === 200 && Math.abs(Number(feedbackRes.body?.confidence) - 0.6) < 1e-9,
      `status=${feedbackRes.status} confidence=${feedbackRes.body?.confidence}`,
    );

    const badVerdict = await req(`/api/cards/${writeToolResult?.card_id}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ verdict: 'nonsense' }),
    });
    check('REST feedback 拒绝非法 verdict', badVerdict.status === 400, `status=${badVerdict.status}`);

    // ---- L1 块：MCP 可写，rules 默认进人工审核 ----
    const ruleCorrection = await mcp(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'memory.correct',
          arguments: {
            target: { type: 'block', label: 'rules' },
            patch: { content: '模型提议：回答前先给结论，并标注不确定性。' },
            reason: 'MCP 冒烟：规则变更',
          },
        },
      },
      sid,
    );
    const ruleText = ruleCorrection.body?.result?.content?.[0]?.text;
    const ruleResult = typeof ruleText === 'string' ? JSON.parse(ruleText) : null;
    check(
      'MCP 写 rules 进入人工审核队列',
      ruleResult?.pending_approval === true && typeof ruleResult?.candidate_id === 'number',
      `candidate=${ruleResult?.candidate_id}`,
    );

    const approveBlock = await req(`/api/candidates/${ruleResult?.candidate_id}/approve`, { method: 'POST' });
    check(
      '人工批准后写入 L1',
      approveBlock.status === 200 && typeof approveBlock.body?.block_id === 'number',
      `status=${approveBlock.status}`,
    );

    const pendingQuery = await mcp(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'memory.pending', arguments: { candidate_id: ruleResult?.candidate_id } },
      },
      sid,
    );
    const pendingText = pendingQuery.body?.result?.content?.[0]?.text;
    const pendingResult = typeof pendingText === 'string' ? JSON.parse(pendingText) : null;
    check(
      'memory.pending 可查候选审核结果',
      pendingResult?.items?.[0]?.status === 'approved' &&
        pendingResult?.items?.[0]?.candidate_id === ruleResult?.candidate_id,
      `status=${pendingResult?.items?.[0]?.status}`,
    );

    const blocksRes = await req('/api/blocks');
    const rulesBlock = Array.isArray(blocksRes.body)
      ? blocksRes.body.find((item: { label: string }) => item.label === 'rules')
      : null;
    check(
      'rules 内容在批准后生效',
      String(rulesBlock?.content ?? '').includes('模型提议'),
      String(rulesBlock?.content ?? '').slice(0, 30),
    );

    const startPreview = await req('/api/start/preview');
    check(
      'start 预览返回常驻块且不落快照',
      startPreview.status === 200 &&
        Array.isArray(startPreview.body?.blocks) &&
        startPreview.body.blocks.length >= 1 &&
        startPreview.body?.recall_id === undefined &&
        typeof startPreview.body?.maintenance?.level === 'string',
      `blocks=${startPreview.body?.blocks?.length} recall_id=${startPreview.body?.recall_id ?? 'none'}`,
    );

    const cardsSearch = await mcp(
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'memory.cards', arguments: { q: '金丝雀', page_size: 5 } },
      },
      sid,
    );
    const cardsText = cardsSearch.body?.result?.content?.[0]?.text;
    const cardsResult = typeof cardsText === 'string' ? JSON.parse(cardsText) : null;
    check(
      'memory.cards 可按关键词搜卡并返回 id',
      cardsResult?.total >= 1 && cardsResult?.items?.[0]?.card_id > 0,
      `total=${cardsResult?.total}`,
    );

    const unknownSession = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, 'not-a-session');
    check('无效会话被拒（会话头校验）', unknownSession.status === 404, `status=${unknownSession.status}`);

    // ---- 清除路径：与 Web 端"物理清除"完全一致的调用 ----
    const cardId = writeRes.body?.card_id as number;
    const purgeRes = await req(`/api/cards/${cardId}?mode=purge&confirm=true`, { method: 'DELETE' });
    check(
      '物理清除卡片成功并落快照（FR-16）',
      purgeRes.status === 200 && typeof purgeRes.body?.trash_id === 'number',
      `status=${purgeRes.status} body=${JSON.stringify(purgeRes.body).slice(0, 200)}`,
    );

    const trashRes = await req('/api/trash');
    const snapshot = Array.isArray(trashRes.body)
      ? trashRes.body.find((item: { id: number }) => item.id === purgeRes.body?.trash_id)
      : undefined;
    check('回收站可见该快照', Boolean(snapshot), `items=${Array.isArray(trashRes.body) ? trashRes.body.length : 'n/a'}`);

    const restoreRes = await req(`/api/trash/${purgeRes.body?.trash_id}/restore`, { method: 'POST' });
    check('快照可恢复', restoreRes.status === 200, `status=${restoreRes.status} body=${JSON.stringify(restoreRes.body).slice(0, 200)}`);

    const restoreCheck = await req(`/api/cards/${cardId}`);
    check('恢复后卡片可读取', restoreCheck.status === 200 && restoreCheck.body?.card?.id === cardId, `status=${restoreCheck.status}`);

    const settingsRes = await req('/api/settings');
    const settingEntries: any[] = Array.isArray(settingsRes.body?.entries) ? settingsRes.body.entries : [];
    check(
      '设置接口返回分组与全部可调项',
      settingsRes.status === 200 && Array.isArray(settingsRes.body?.groups) && settingEntries.length >= 20,
      `entries=${settingEntries.length}`,
    );

    const halfDefault = settingEntries.find((item) => item.key === 'life.cardHalfLifeDays')?.default;

    const putRes = await req('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ values: { 'life.cardHalfLifeDays': 45 } }),
    });
    const afterPut = await req('/api/settings');
    const halfEntry = afterPut.body?.entries?.find((item: { key: string }) => item.key === 'life.cardHalfLifeDays');
    check(
      '页面保存参数后立即生效并标记来源',
      putRes.status === 200 && halfEntry?.value === 45 && halfEntry?.source === 'db',
      `status=${putRes.status} value=${halfEntry?.value} source=${halfEntry?.source}`,
    );

    const badPut = await req('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ values: { 'life.cardHalfLifeDays': 0 } }),
    });
    check(
      '越界参数被拒（E_INVALID）',
      badPut.status === 400 && badPut.body?.error?.code === 'E_INVALID',
      `status=${badPut.status}`,
    );

    const resetRes = await req('/api/settings/life.cardHalfLifeDays', { method: 'DELETE' });
    check(
      '单项可恢复为默认值',
      resetRes.status === 200 && resetRes.body?.value === halfDefault,
      `status=${resetRes.status} value=${resetRes.body?.value} default=${halfDefault}`,
    );

    const failed = checks.filter((item) => !item.ok);
    console.log(`\n共 ${checks.length} 项 HTTP 检查，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    child?.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      await pg.stop();
    } catch {
      /* ignore */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main()
  // 子进程与嵌入式库停完后仍有残留句柄，显式退出以免 CI 卡在等待
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err: unknown) => {
    console.error('HTTP 冒烟失败：', err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
