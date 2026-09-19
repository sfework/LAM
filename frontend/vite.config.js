import { defineConfig } from 'vite';
import plugin from '@vitejs/plugin-react';

// 前端与后端同域同端口（DESIGN 决策 46）：
//   - 生产：vite build 产出 frontend/dist，由主服务在 :8790 直接托管（后端 SPA 回退）。
//   - 开发：Vite dev server（:5173），把后端前缀代理到 :8790，开发期同样同源、无 CORS。
// base 固定 '/'：产物用绝对路径 /assets/*，与 SPA 回退（根路径挂载）一致。
export default defineConfig({
    plugins: [plugin()],
    base: '/',
    server: {
        port: 5173,
        proxy: {
            '/api': { target: 'http://localhost:8790', changeOrigin: true },
            '/internal': { target: 'http://localhost:8790', changeOrigin: true },
            '/mcp': { target: 'http://localhost:8790', changeOrigin: true },
            '/health': { target: 'http://localhost:8790', changeOrigin: true },
        },
    },
    optimizeDeps: {
        include: [
            'react', 'react-dom', 'react-router-dom',
            '@douyinfe/semi-ui', '@douyinfe/semi-icons', '@douyinfe/semi-foundation',
        ],
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        // 管理后台为内部工具，整包体积不做强制分割；调高阈值以消除默认 500kB 提示。
        // 当前主 chunk 约 1.5MB（gzip 约 420kB），本地托管无带宽压力，阈值设为 2000。
        chunkSizeWarningLimit: 2000,
        rolldownOptions: {
            // lottie-web（Semi 传递依赖）在动画表达式功能里使用直接 eval，属第三方源码，
            // 我们无法修改也无需处理——关闭该项检查，避免每次 build 刷-security-警告。
            // moduleLevelDirective：@mdx-js/mdx、hast-util-to-estree 等 Semi 传递依赖源码里的
            //   'use client' 等模块级指令，打包后语义提示，同样为第三方且不影响功能——关闭。
            // pluginTimings：构建插件钩子耗时统计输出，纯信息，关闭以保持日志干净。
            checks: { eval: false, moduleLevelDirective: false, pluginTimings: false },
        },
    },
});
