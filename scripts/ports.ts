import { createServer } from 'node:net';

/**
 * 从 startPort 开始找一个真正可监听的端口。
 * 避免上一轮冒烟被强制中断后端口残留（Windows 会出现 PID 已消失但仍占用的幽灵监听）。
 */
export async function freePort(startPort: number, tries = 40): Promise<number> {
  for (let offset = 0; offset < tries; offset++) {
    const port = startPort + offset;
    // eslint-disable-next-line no-await-in-loop
    const available = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
    if (available) return port;
  }
  throw new Error(`端口 ${startPort}-${startPort + tries - 1} 都被占用`);
}
