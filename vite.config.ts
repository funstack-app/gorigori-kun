import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // ─────────────────────────────────────────────────────────────
  // 改変防止 Lv1 (2026-05-15): 配布版の JS を改変しづらくする
  //
  //  - terser でコード圧縮 + 変数名 mangle
  //  - コメント全削除、console.log 削除
  //  - sourcemap 出力なし (配布版に元コードを残さない)
  //
  // 完全防御は不可能だが、素人による改変・再配布のハードルは大きく上がる。
  // ─────────────────────────────────────────────────────────────
  build: {
    minify: "terser",
    sourcemap: false,
    terserOptions: {
      compress: {
        drop_console: false, // エラー追跡のため console.error は残す
        passes: 2,
      },
      mangle: {
        toplevel: true,
      },
      format: {
        comments: false,
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
