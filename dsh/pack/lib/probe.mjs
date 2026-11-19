import { spawn } from 'node:child_process';

/**
 * 装完必须真的连一次：迁移能不能跑、分词器能不能加载、库能不能打开，
 * 只有实际拉起来发 memory.start 才知道。缺了这步，用户是在 DSH 里看到「连接失败」才发现装坏的。
 */
export async function probe({ entry, env = {}, timeoutMs = 40_000 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve({ ...result, stderr: stderr.slice(-1500) });
    };

    timer = setTimeout(() => finish({ ok: false, reason: `握手超时（${timeoutMs}ms）` }), timeoutMs);

    const send = (payload) => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(payload)}\n`);
    };

    child.on('error', (err) => finish({ ok: false, reason: err.message }));
    child.on('exit', (code) => {
      if (!settled) finish({ ok: false, reason: `子进程提前退出（code=${code}）` });
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let index;
      while ((index = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.start', arguments: {} } });
          continue;
        }

        if (message.id === 2) {
          if (message.error) {
            finish({ ok: false, reason: message.error.message ?? 'memory.start 调用失败' });
            continue;
          }
          // 空库时 start 不产生召回记录，recall_id 可以为空；这里的判据是工具真的调通了
          const text = message.result?.content?.[0]?.text ?? '';
          let recallId = null;
          try {
            recallId = JSON.parse(text).recall_id ?? null;
          } catch {
            /* 返回体解析失败不影响连通性判断 */
          }
          finish({ ok: true, recallId });
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dsh-memlattice-installer', version: '0.1.0' },
      },
    });
  });
}
