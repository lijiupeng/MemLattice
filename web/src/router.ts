import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/cards' },
    {
      path: '/cards',
      name: 'cards',
      component: () => import('./views/CardsView.vue'),
      meta: { title: '记忆卡片', description: 'L2 事件卡：按热度排序，可检索、纠错、遗忘' },
    },
    {
      path: '/graph',
      name: 'graph',
      component: () => import('./views/GraphView.vue'),
      meta: { title: '联想图谱', description: '按簇聚合的记忆索引，双击节点展开下一跳' },
    },
    {
      path: '/recall',
      name: 'recall',
      component: () => import('./views/RecallView.vue'),
      meta: { title: '记忆检索', description: '输入一句话，看会想起哪些事：预算、强/弱关联与丢弃明细' },
    },
    {
      path: '/session',
      name: 'session',
      component: () => import('./views/SessionView.vue'),
      meta: {
        title: '会话预览',
        description: '模拟新会话开头：会被注入的那几行、占用预算与整理压力',
      },
    },
    {
      path: '/blocks',
      name: 'blocks',
      component: () => import('./views/BlocksView.vue'),
      meta: { title: '常驻层', description: '人设、规则与经验：每次会话开头一定会被看见的那几行' },
    },
    {
      path: '/candidates',
      name: 'candidates',
      component: () => import('./views/CandidatesView.vue'),
      meta: { title: '待审队列', description: '不达固化阈值的经验，人工确认后写入 L1' },
    },
    {
      path: '/trash',
      name: 'trash',
      component: () => import('./views/TrashView.vue'),
      meta: { title: '回收站', description: '软删 7 天内可恢复；物理清除保留快照' },
    },
    {
      path: '/audit',
      name: 'audit',
      component: () => import('./views/AuditView.vue'),
      meta: { title: '审计日志', description: '每次修改的操作者、时间与变更前后内容' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/SettingsView.vue'),
      meta: { title: '设置', description: '检索预算、淡忘周期、写入与巡检：改完即生效' },
    },
  ],
});
