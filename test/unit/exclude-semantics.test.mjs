/**
 * 排除匹配语义（services.mts 的 compileSyncExcludes 家族）独立单元测试。
 *
 * 覆盖「选择性同步树」落地（prefs.excludeRels 精确 rel）与用户 glob 规则
 *（prefs.excludePatterns）合并后的判定口径：
 *   X1 —— 精确 rel：文件 / 目录字面命中；子路径不误伤兄弟（资料/视频 vs 资料/视频2）
 *   X2 —— 祖先传播：取消勾选目录 ⇒ 整棵子树排除（任意深度）；勾选树 rel 无 glob 展开
 *   X3 —— glob 语义不回归：段级模式逐段命中、全路径模式精确命中（含通配符）
 *   X4 —— Depth:infinity 一致性修正：全路径 glob 命中祖先目录即排除后代
 *          （逐目录形态靠不入队剪枝本就成立，单请求形态靠祖先传播补齐）
 *   X5 —— 组合与边界：两套规则任一命中即排除；空输入返回 null（零开销直通）；
 *          超长 / 保留名（'.' / '/'）条目忽略
 *
 * 运行：npx vitest run test/unit（或 npm run test:unit）。
 * 结构说明：纯函数直检（services.sync._internals），用例间无顺序依赖；
 * check() 沿用软失败登记 + 末尾一次性抛出（与 store.test.mjs 一致）。
 */
import { test } from 'vitest'

// services.mts 在模块顶层挂 window.services（模块不导出对象本体）—— Node 直载
// 需先备好宿主对象，再从 window 取（与 e2e harness 的加载形态一致）
globalThis.window = globalThis.window || {}
await import('../../src-ztools/preload/services.mts')
const services = globalThis.window.services
const { compileSyncExcludes, compileExcludePatterns, compileExactRels } = services.sync._internals

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

test('排除匹配语义（精确 rel + 祖先传播 + glob 合并）', () => {
  // ---- X1 精确 rel ----
  const m = compileSyncExcludes(null, ['资料/视频/a.mp4'])
  check('X1 精确文件 rel 命中', m('资料/视频/a.mp4') === true)
  check('X1 兄弟路径不误伤（资料/视频/a.mp4 vs b.mp4）', m('资料/视频/b.mp4') === false)
  check('X1 祖先目录本身不因文件条目被排除', m('资料/视频') === false)

  const dir = compileSyncExcludes(null, ['资料/视频'])
  check('X1 精确目录 rel 命中', dir('资料/视频') === true)
  check('X1 兄弟目录不误伤（资料/视频2）', dir('资料/视频2') === false)
  check('X1 兄弟目录子文件不误伤', dir('资料/视频2/记事.txt') === false)

  // ---- X2 祖先传播（勾选树子树语义）----
  check('X2 一级子文件被排除', dir('资料/视频/a.mp4') === true)
  check('X2 深层子文件被排除（任意深度）', dir('资料/视频/sub/deep/文件.bin') === true)
  const root = compileSyncExcludes(null, ['归档'])
  check('X2 根级目录取消 ⇒ 整树排除', root('归档/2024/a.txt') === true && root('归档') === true)
  check('X2 同名段不误伤（归档2 / 备份/归档.txt 文件名）', root('归档2/a.txt') === false && root('备份/归档.txt') === false)
  // 勾选树 rel 无 glob 展开：通配符按字面
  const literal = compileSyncExcludes(null, ['a*b'])
  check('X2 通配符按字面（a*b 不展开）', literal('axb') === false && literal('a*b') === true)

  // ---- X3 glob 语义不回归 ----
  const g1 = compileSyncExcludes(['*.tmp'], null)
  check('X3 段级 glob 命中（根级）', g1('x.tmp') === true)
  check('X3 段级 glob 命中（深层文件名）', g1('资料/视频/y.tmp') === true)
  check('X3 段级 glob 不误伤（非 tmp）', g1('x.txt') === false)
  const g2 = compileSyncExcludes(['资料/视频/*'], null)
  check('X3 全路径 glob 命中（一层内）', g2('资料/视频/a.mp4') === true)
  // 「* 不跨 /」的本层语义 + 祖先传播：命中的层内目录（sub）其子树一并排除 ——
  // 与逐目录形态「目录未入队 ⇒ 子树剪枝」的既有行为一致（X4 的一致性修正）
  check('X3 命中层内目录 ⇒ 其子树一并排除（对齐逐目录剪枝）', g2('资料/视频/sub/b.mp4') === true)
  check('X3 全路径 glob 不命中其他目录', g2('资料/报告.docx') === false && g2('资料/其他/b.mp4') === false)

  // ---- X4 Depth:infinity 一致性（祖先传播修正全路径 glob 的后代排除）----
  const gdir = compileSyncExcludes(['资料/视频'], null)
  check('X4 全路径字面 glob 命中目录 ⇒ 深层后代排除（单请求形态对齐逐目录剪枝）', gdir('资料/视频/sub/b.mp4') === true)
  check('X4 祖先传播不扩大到兄弟', gdir('资料/视频2/b.mp4') === false)

  // ---- X5 组合与边界 ----
  const both = compileSyncExcludes(['*.log'], ['资料'])
  check('X5 两套规则任一命中即排除（glob 侧）', both('x.log') === true)
  check('X5 两套规则任一命中即排除（树侧）', both('资料/a.txt') === true)
  check('X5 两套规则都未命中不排除', both('docs/a.txt') === false)
  check('X5 双空输入 → null（零开销直通）', compileSyncExcludes(undefined, undefined) === null && compileSyncExcludes([], []) === null)
  check('X5 仅 glob 空 rel 集 → 等价 compileExcludePatterns', (() => {
    const a = compileSyncExcludes(['*.tmp'], [])
    const b = compileExcludePatterns(['*.tmp'])
    return !!a && !!b && a('z.tmp') === true && a('z.txt') === false
  })())
  check('X5 保留名 / 空串条目被忽略（不产生全量排除）', (() => {
    const m2 = compileSyncExcludes(null, ['.', '/', '', 'ok.txt'])
    return m2('任何/路径.txt') === false && m2('ok.txt') === true
  })())
  check('X5 超长条目忽略（>200 字符上限 → 无规则返回 null）', (() => {
    const long = 'a'.repeat(201)
    return compileSyncExcludes(null, [long]) === null
  })())

  const failed = results.filter((r) => !r.ok)
  if (failed.length) throw new Error(`排除语义单元测试 ${failed.length}/${results.length} 项失败：\n  ❌ ${failed.map((f) => f.name).join('\n  ❌ ')}`)
})
