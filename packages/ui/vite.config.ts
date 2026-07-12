import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 9101,
    proxy: {
      "/api": "http://127.0.0.1:9100",
    },
  },
});
