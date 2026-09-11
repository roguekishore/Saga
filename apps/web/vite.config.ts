import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vendor split policy: the initial request loads react + the shell and
 * nothing else. Chart runtimes, the graph stack, and three.js each live in
 * their own chunk and arrive only when a route that uses them mounts.
 */
function vendorChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;
  if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/.test(id)) {
    return 'react';
  }
  if (/[\\/]node_modules[\\/](recharts|victory-vendor|d3-[^\\/]+|recharts-scale)[\\/]/.test(id)) {
    return 'charts';
  }
  if (/[\\/]node_modules[\\/](echarts|zrender)[\\/]/.test(id)) return 'echarts';
  if (/[\\/]node_modules[\\/](@xyflow|elkjs)[\\/]/.test(id)) return 'graph';
  if (/[\\/]node_modules[\\/](three|@react-three)[\\/]/.test(id)) return 'three';
  if (/[\\/]node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/.test(id)) {
    return 'motion';
  }
  return undefined;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8788',
      '/ws': { target: 'ws://127.0.0.1:8788', ws: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: { manualChunks: vendorChunk },
    },
  },
});
