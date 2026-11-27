import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

const cloudflareConfigPath = process.env.CLOUDFLARE_CONFIG_PATH?.trim();

function fontCacheHeadersPlugin(): Plugin {
  return {
    name: 'font-cache-headers',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0];
        if (pathname.startsWith('/fonts/')) {
          const origWriteHead = res.writeHead.bind(res);
          res.writeHead = ((statusCode: number, ...args: unknown[]) => {
            const maybeHeaders = args[args.length - 1];
            if (maybeHeaders && typeof maybeHeaders === 'object' && !Array.isArray(maybeHeaders)) {
              const headerRecord = maybeHeaders as Record<string, unknown>;
              for (const key of Object.keys(headerRecord)) {
                if (key.toLowerCase() === 'cache-control') {
                  delete headerRecord[key];
                }
              }
            }
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            return origWriteHead(statusCode, ...(args as Parameters<typeof origWriteHead> extends [number, ...infer R] ? R : never[]));
          }) as typeof res.writeHead;
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare(cloudflareConfigPath ? { configPath: cloudflareConfigPath } : undefined),
    fontCacheHeadersPlugin(),
  ],
  server: {
    watch: {
      ignored: ['**/tests/**', '**/.wrangler/**', '**/dist/**'],
    },
  },
  environments: {
    client: {
      build: {
        rollupOptions: {
          output: {
            manualChunks(id) {
              const norm = id.replaceAll('\\', '/');
              if (!norm.includes('/node_modules/')) return undefined;
              if (norm.includes('/react/') || norm.includes('/react-dom/') || norm.includes('/scheduler/')) {
                return 'vendor-react';
              }
              if (norm.includes('/ogl/')) return 'vendor-ogl';
              if (norm.includes('/maplibre-gl/')) return 'vendor-maplibre';
              if (norm.includes('/astronomy-engine/')) return 'vendor-astronomy';
              if (norm.includes('/exifr/')) return 'vendor-exifr';
              if (norm.includes('/motion/') || norm.includes('/framer-motion/')) return 'vendor-motion';
              if (norm.includes('/lucide-react/')) return 'vendor-icons';
              return undefined;
            },
          },
        },
      },
    },
  },
});
