import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' 讓網站可部署在 GitHub Pages 子路徑或任何靜態主機
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 600 },
});
