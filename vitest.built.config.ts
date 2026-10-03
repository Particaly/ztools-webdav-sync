import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.js'

/**
 * built 双轨：与基础配置一致，仅注入 WDSYNC_E2E_PRELOAD=built（setupShard 据此加载
 * esbuild 构建产物 src-ztools/preload/dist/services.js）。经 test.env 注入而非 shell
 * 前缀，Windows 下同样可用。使用前须先构建一次（npm run build:preload）。
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      env: { WDSYNC_E2E_PRELOAD: 'built' },
    },
  }),
)
