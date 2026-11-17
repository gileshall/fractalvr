import basicSsl from '@vitejs/plugin-basic-ssl';
import { editionPlugin, buildStamp } from './edition.vite.js';

// WebXR needs a secure context. https for LAN/headset use; NO_SSL=1 for plain localhost testing.

const here = (p) => new URL(p, import.meta.url).pathname;
const edition = editionPlugin(here);

// Which code a page is running (edition.vite.js).
const BUILD = buildStamp(here);

// The same, where a page can ask for it: an old page learns it is old (src/fresh.js).
const live = {
  name: 'build-json',
  configureServer(server) {
    server.middlewares.use('/build.json', (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(BUILD));
    });
  },
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify(BUILD) });
  },
};

export default ({ mode }) => ({
  define: { __BUILD__: JSON.stringify({ ...BUILD, mode }) },
  plugins: process.env.NO_SSL ? [edition, live] : [basicSsl(), edition, live],
  server: { port: 5173 },
});
