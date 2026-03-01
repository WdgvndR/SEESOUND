import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        // Proxy REST calls to FastAPI so the browser never hits a CORS wall
        proxy: {
            '/api': {
                target: 'http://localhost:8000',
                changeOrigin: true,
            },
            // WebSocket bridge → Python backend
            '/ws': {
                target: 'ws://localhost:8000',
                ws: true,
                changeOrigin: true,
            },
        },
    },
})
