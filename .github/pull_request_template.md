## 这个 PR 解决什么

<!-- 一句话说清问题；关联 issue 用 "Closes #123" -->

## 改了什么

<!-- 主要改动点，按文件或模块列 -->

## 怎么验证的

<!-- 勾选实际跑过的，不要勾没跑的 -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run smoke:sqlite`
- [ ] `npm run smoke`（PostgreSQL）
- [ ] `npm run smoke:http`
- [ ] 手动验证（说明步骤）

## 需要提醒的地方

<!-- 破坏性变更、行为差异、双后端不对称、需要重启才生效的项 -->

## 提交前自查

- [ ] 没有提交 `data/`、`dist/`、`.env` 或任何令牌
- [ ] 新增 SQL 在 SQLite 与 PostgreSQL 下都能跑（或明确说明只支持其中一端）
- [ ] 注释只写原因，不复述代码
- [ ] 没有留下注释掉的旧实现
