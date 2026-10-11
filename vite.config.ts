// Vite builds and serves the web page in web/.
//
// The root is web/, so its pages are served at the site root. Only the real
// page, web/index.html, is built into web/dist/; the development page
// web/dev.html and the stand-in wallet it loads (web/dev/) are served by the
// development server only and never built.

import path from "node:path";

import { defineConfig } from "vite";

const WEB = path.join(import.meta.dirname, "web");

export default defineConfig({
  root: WEB,
  build: {
    outDir: path.join(WEB, "dist"),
    emptyOutDir: true,
    rolldownOptions: {
      input: path.join(WEB, "index.html"),
    },
  },
});
