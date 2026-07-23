import { defineConfig } from "vite";

// Tauri가 프론트를 여기서 개발(1420 고정)·빌드(dist)한다.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2021", outDir: "dist", emptyOutDir: true },
});
