import { defineConfig } from 'vitest/config'

/**
 * 测试体系（vitest 迁移后）：
 * - test/unit/store.test.mjs        存储层单元测试
 * - test/shard-*.test.mjs           同步引擎 e2e 分片（每文件独立 dav-server / 端口 / 根目录，
 *                                   vitest 按文件并行；文件内保持原节顺序）
 * - 档位标签：slowSection 登记的节带 `slow` tag —— 日常 `npm run test:fast`（--tag '!slow'）
 *   跳过；发版 `npm test` 全量；`npm run test:slow` 单独回归等待型用例。
 *   注意：全 fast 的分片文件在 slow 过滤下整文件跳过、afterAll 不会执行 —— dav-server
 *   的父进程死亡看门狗（WDSYNC_DAV_EXIT_WITH）保证这类路径不残留占端口的子进程。
 * 注意：本文件必须保持独立（不引入 vite.config.js 的 Vue/UnoCSS 插件链），
 * vitest 会优先读取 vitest.config.* 而非 vite.config.*。
 */
export default defineConfig({
  test: {
    include: ['test/unit/*.test.mjs', 'test/shard-*.test.mjs'],
    // vitest 5：使用 tag 前必须在此声明。fast = 快组（日常回归全跑）；
    // slow = 慢组（真实墙钟等待型，发版或 test:slow 单独回归）
    tags: [
      { name: 'fast', description: '快组（日常回归全跑）' },
      { name: 'slow', description: '慢组（真实墙钟等待型）' },
    ],
    // forks 池：每个测试文件独占一个子进程 —— global.window / preload 单例天然隔离，
    // 文件内 spawn dav-server、长定时器与 afterAll 清理都与旧单进程行为一致
    pool: 'forks',
    fileParallelism: true,
    // e2e 节含真实墙钟等待（心跳 5s / 退避 / 节流传输马拉松），超时放宽到 5 分钟
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // 迁移期与旧 node 脚本对拍时需要稳定输出；关闭重试保持失败语义
    retry: 0,
  },
})
