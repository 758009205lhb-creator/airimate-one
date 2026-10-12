/**
 * apps/renderer/vite.config.ts
 *
 * 关键点：
 *   - `base: './'` ⇒ 产物用相对路径，配合 `app://bundle/` 自定义协议加载（不依赖 file://）；
 *   - 单入口、单 chunk 策略不强制（three 体积大，拆包有利于缓存）；
 *   - 内部包用别名直接指向 **源码**，保证 Vite 编译的是最新 TS（避免先构建 dist 的顺序问题）；
 *   - 产物里不得出现 http(s) 外部引用（CSP self）。
 */
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

/**
 * sourcemap 默认**关闭**，需要时用 `AIRIMATE_SOURCEMAP=1` 显式打开。
 *
 * 为什么默认关：`.map` 内含**未压缩的原始源码**（连注释一起）。
 * 分发包扫描（A17 第 5 面）实测在载荷里命中 **58 个 `.map`** —— 也就是说
 * 默认构建会把完整实现细节随分发一起给出。开发时想看源码映射就显式开这个变量。
 */
const wantSourcemap = process.env.AIRIMATE_SOURCEMAP === '1'

export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@airimate/shared': r('../../packages/shared/src/index.ts'),
      '@airimate/motion-director': r('../../packages/motion-director/src/index.ts'),
      '@airimate/avatar-stage': r('../../packages/avatar-stage/src/index.ts'),
      '@airimate/radial-menu': r('../../packages/radial-menu/src/index.ts'),
      /**
       * ⚠ 这里曾有一行 `'@airimate/airi-core': .../packages/airi-core/src/index.ts` ——
       * 而 `packages/airi-core` **根本不存在**（根 package.json 的 build 脚本里也有同样的
       * 悬空引用，导致 `npm run build` 从未跑通过）。指向不存在的路径的别名不会报错，
       * 只会在真正 import 时才以"解析失败"的形式暴露 ⇒ 属于静默的配置债，已删除。
       */
      '@': r('./src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome128',
    sourcemap: wantSourcemap,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          vrm: ['@pixiv/three-vrm', '@pixiv/three-vrm-animation'],
          vendor: ['vue', 'pinia', 'marked', 'dompurify'],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    strictPort: false,
  },
})
