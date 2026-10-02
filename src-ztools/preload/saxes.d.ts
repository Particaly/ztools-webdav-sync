/**
 * saxes 无官方 TypeScript 类型：此处声明本插件用到的最小使用面
 *（流式 XML 解析器：on/write/close；回调参数形状由调用侧自行解释）。
 */
declare module 'saxes' {
  export class SaxesParser {
    constructor(opts?: Record<string, unknown>)
    on(event: string, cb: (...args: any[]) => void): this
    write(chunk: string): this
    close(): this
  }
}
