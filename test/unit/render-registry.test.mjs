/**
 * 渲染层注册表降级提示条可见性（src/composables/store-dirs.ts 的
 * registrySyncStripVisibleFor）单元测试。
 *
 * 背景：DirRow 的降级提示条文案三分支（pending / denied / 兜底「缺少内部 API」）
 * 没有 ok 形态 —— 授权批准后对账转 ok，提示条反而以「当前 ZTools 版本不支持自动
 * 安装同步的插件」的错误文案重新出现（误报：自动安装其实已在正常工作）。修复后
 * 可见性判定收口为纯函数：只有降级态（pending / denied / unavailable）出条，
 * ok = 对账通道健康绝不提示；「不再显示」按关闭时的状态指纹（状态一致不重复
 * 提示，状态变化后复出）。
 *
 * 运行：npx vitest run test/unit（或 npm run test:unit）
 * 结构说明：纯函数判定，用例间无共享状态；沿用 check 软失败登记 + 末尾一次性
 * 抛出（与 render-store.test.mjs 一致）。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'
import { makeCheck, UNIT_HERE as HERE } from '../harness.mjs'

const { check, assertAtEnd } = makeCheck()

// 导入前装最小 window 桩：store 域模块图加载期不触达宿主（window 引用都在函数体内），
// 桩只防「加载期守卫外引用」的意外形态
globalThis.window = {}

const dirsMod = await import(pathToFileURL(path.join(HERE, '..', '..', 'src', 'composables', 'store-dirs.ts')).href)
const registrySyncStripVisibleFor = dirsMod.registrySyncStripVisibleFor

test('注册表降级提示条可见性（RG1–RG7）', () => {
  try {
    // RG1 尚未对账（undefined）不出条：与 refreshPluginRegistryState 的「尚未对账
    // 保持现状」语义一致 —— 尚未同步过先让位给行级状态
    check('RG1 undefined 不出条', registrySyncStripVisibleFor(undefined, '') === false)

    // RG2 ok 不出条（本次回归的核心用例）：对账健康 = 自动安装已在工作；文案
    // 三分支没有 ok 形态，ok 出条必然误报「缺少内部 API」
    check('RG2 ok 不出条', registrySyncStripVisibleFor('ok', '') === false)

    // RG3 三种降级态都出条：pending 已提交授权申请 / denied 权限被拒 /
    // unavailable 宿主未注入 internal 命名空间
    check(
      'RG3 降级态出条',
      registrySyncStripVisibleFor('pending', '') === true &&
        registrySyncStripVisibleFor('denied', '') === true &&
        registrySyncStripVisibleFor('unavailable', '') === true
    )

    // RG4 「不再显示」指纹：关闭时记录的状态一致不再提示，状态变化后复出
    check('RG4a 指纹一致不出条', registrySyncStripVisibleFor('pending', 'pending') === false)
    check('RG4b 指纹不同复出', registrySyncStripVisibleFor('denied', 'pending') === true)

    // RG5 从未关闭形态：空串 / null / undefined 的 dismissed 等价（prefs 字段
    // 既有数据可能是任一空值形态）
    check(
      'RG5 dismissed 空值等价',
      registrySyncStripVisibleFor('unavailable', '') === true &&
        registrySyncStripVisibleFor('unavailable', null) === true &&
        registrySyncStripVisibleFor('unavailable', undefined) === true
    )

    // RG6 关闭过降级态后转 ok：不出条（ok 压过指纹 —— 修复前该形态正是用户撞见的
    // 误报路径：dismissed 记的是旧降级态，ok ≠ 指纹 → 提示条以错误文案复出）
    check('RG6 关闭过降级态后转 ok 不出条', registrySyncStripVisibleFor('ok', 'unavailable') === false)

    // RG7 ok 后再次降级（宿主回退 / internal 移除）：正常复出提示（指纹是旧
    // 降级态，与新状态不同）
    check('RG7 ok 后再次降级复出', registrySyncStripVisibleFor('denied', 'unavailable') === true)
  } catch (e) {
    check('unexpected error', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e))
  }

  assertAtEnd({
    fail: (failed, total) => `注册表提示条测试失败 ${failed.length}/${total} 条:\n${failed.map((f) => `  - ${f.name} ${f.detail}`).join('\n')}`,
  })
})
