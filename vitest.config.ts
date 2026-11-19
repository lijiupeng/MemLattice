import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 只跑项目自己的测试：默认的全局匹配会把编辑器/助手目录里的测试一并抓进来，
  // 那些用例依赖本机工具（如 ffmpeg），会让本地 npm test 无缘无故变红。
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
