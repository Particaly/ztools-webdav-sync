/**
 * 「在资源管理器中定位」链路单元测试：joinLocalPath（本地根 + 远端 rel 换算本地
 * 完整路径，ConflictModal / PendingConflictsModal 的定位入口共用）与
 * store.revealLocalFile（宿主 API 选择：shellShowItemInFolder 定位选中优先，
 * 缺失或失败降级 shellOpenPath 打开所在目录，两类能力皆缺失给 toast 提示）。
 *
 * 运行：npx vitest run test/unit（或 npm run test:unit）
 * 结构说明：window.ztools 桩按用例重装（store 每次调用现读 window.ztools，不持
 * 引用，导入后再换桩即可生效）；check() 沿用软失败登记 + 末尾一次性抛出。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'
import { makeCheck, UNIT_HERE as HERE } from '../harness.mjs'

// 软失败登记收敛到 harness 的 makeCheck
const { check, results, assertAtEnd } = makeCheck()

// store.ts 导入期不触达 ztools（各方法调用时现读），空桩占位即可
globalThis.window = {}

const formatMod = await import(pathToFileURL(path.join(HERE, '..', '..', 'src', 'composables', 'format.ts')).href)
const storeMod = await import(pathToFileURL(path.join(HERE, '..', '..', 'src', 'composables', 'store.ts')).href)
const store = storeMod.useStore()

test('渲染层「在资源管理器中定位」：路径换算与宿主 API 选择', async () => {
  try {
    const { joinLocalPath } = formatMod

    // ---- joinLocalPath：Windows 盘符根 / POSIX 根 / 尾分隔符 / 多级 rel ----
    check('J1 Windows 盘符根 → 反斜杠拼接',
      joinLocalPath('C:\\sync\\docs', 'a/b/报告 final.docx') === 'C:\\sync\\docs\\a\\b\\报告 final.docx')
    check('J2 Windows 正斜杠手输根 → 反斜杠拼接',
      joinLocalPath('C:/sync/docs', 'a/b.txt') === 'C:\\sync\\docs\\a\\b.txt')
    check('J3 POSIX 根 → 正斜杠拼接',
      joinLocalPath('/home/user/sync', 'a/b.txt') === '/home/user/sync/a/b.txt')
    check('J4 根尾分隔符归一（不产生双分隔符）',
      joinLocalPath('C:\\sync\\docs\\', 'a.txt') === 'C:\\sync\\docs\\a.txt')
    check('J5 单段 rel',
      joinLocalPath('/srv/sync', 'README.md') === '/srv/sync/README.md')

    // ---- revealLocalFile：宿主 API 选择（store 现读 window.ztools）----
    const calls = []
    // R1 宿主支持 shellShowItemInFolder → 原样透传完整路径（定位并选中），不走降级
    window.ztools = {
      shellShowItemInFolder: (p) => calls.push(['reveal', p]),
      shellOpenPath: (p) => calls.push(['open', p]),
    }
    store.revealLocalFile('C:\\sync\\docs\\a\\b.txt')
    check('R1 优先 shellShowItemInFolder 透传完整路径',
      calls.length === 1 && calls[0][0] === 'reveal' && calls[0][1] === 'C:\\sync\\docs\\a\\b.txt', JSON.stringify(calls))

    // R2 旧宿主缺失 shellShowItemInFolder → 降级 shellOpenPath 打开所在目录
    calls.length = 0
    window.ztools = { shellOpenPath: (p) => calls.push(['open', p]) }
    store.revealLocalFile('C:\\sync\\docs\\a\\b.txt')
    check('R2 缺失定位 API → 降级打开所在目录',
      calls.length === 1 && calls[0][0] === 'open' && calls[0][1] === 'C:\\sync\\docs\\a', JSON.stringify(calls))

    // R3 定位抛错（如文件已被移走）→ 降级打开所在目录且不外抛
    calls.length = 0
    window.ztools = {
      shellShowItemInFolder: () => { throw new Error('gone') },
      shellOpenPath: (p) => calls.push(['open', p]),
    }
    let threw = false
    try { store.revealLocalFile('C:\\sync\\docs\\a\\b.txt') } catch (_) { threw = true }
    check('R3 定位失败 → 静默降级打开所在目录',
      !threw && calls.length === 1 && calls[0][0] === 'open' && calls[0][1] === 'C:\\sync\\docs\\a', `threw=${threw} ${JSON.stringify(calls)}`)

    // R4 两类 shell 能力皆缺失（旧宿主）→ 不抛错，走 toast 提示分支
    window.ztools = {}
    threw = false
    try { store.revealLocalFile('C:\\sync\\docs\\a\\b.txt') } catch (_) { threw = true }
    check('R4 能力缺失 → 静默不外抛（toast 提示）', !threw)
  } finally {
    window.ztools = undefined
  }
  assertAtEnd({
    passLine: (passed, total) => `「在资源管理器中定位」${passed}/${total} 项通过`,
    fail: (failed, total) => `「在资源管理器中定位」${failed.length}/${total} 项失败：\n${failed.map((r) => `- ${r.name}`).join('\n')}`,
  })
})
