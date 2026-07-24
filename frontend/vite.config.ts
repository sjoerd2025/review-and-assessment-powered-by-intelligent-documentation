import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  // SPA を配信するベースパス。S3+API Gateway 配信ではステージパス
  // （例: "/app/"）配下で配信されるため、ビルド時に環境変数で注入する。
  // 未設定時は "/"（CloudFront 配信の従来挙動）。
  // Base path the SPA is served under. The S3+API Gateway delivery injects
  // the stage path (e.g. "/app/") at build time; defaults to "/".
  base: process.env.VITE_APP_BASE_PATH || "/",
  plugins: [react()],
  server: {
    port: 5173,
  },
});
