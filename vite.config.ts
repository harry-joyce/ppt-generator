import { defineConfig, type Plugin } from "vite";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";

const require = createRequire(import.meta.url);

/** Resolve the single-thread ffmpeg core (ESM build) from node_modules. */
function resolveCoreFiles(): { js: string; wasm: string } {
  // `@ffmpeg/core` only exports its entry; require.resolve returns the UMD
  // bundle. The bundled ffmpeg worker is a *module* worker, so it imports the
  // core via dynamic `import()` and needs the ESM build (with a default export).
  const umd = require.resolve("@ffmpeg/core");
  const js = umd.replace(`${sep}umd${sep}`, `${sep}esm${sep}`);
  const wasm = resolve(dirname(js), "ffmpeg-core.wasm");
  return { js, wasm };
}

/**
 * Serve the ffmpeg core/wasm under `/ffmpeg/*` in dev and copy them into the
 * build output, so the ~31 MB wasm never has to be committed to the repo.
 */
function ffmpegCore(): Plugin {
  const { js, wasm } = resolveCoreFiles();
  return {
    name: "ffmpeg-core",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/ffmpeg/ffmpeg-core.js") {
          res.setHeader("Content-Type", "application/javascript");
          res.end(readFileSync(js));
          return;
        }
        if (req.url === "/ffmpeg/ffmpeg-core.wasm") {
          res.setHeader("Content-Type", "application/wasm");
          res.end(readFileSync(wasm));
          return;
        }
        next();
      });
    },
    writeBundle(options) {
      const outDir = options.dir ?? "dist";
      const dest = resolve(outDir, "ffmpeg");
      mkdirSync(dest, { recursive: true });
      copyFileSync(js, resolve(dest, "ffmpeg-core.js"));
      copyFileSync(wasm, resolve(dest, "ffmpeg-core.wasm"));
    },
  };
}

// Relative base so the build works from any GitHub Pages project sub-path.
export default defineConfig({
  base: "./",
  plugins: [ffmpegCore()],
  build: {
    outDir: "dist",
    target: "es2020",
  },
  // ffmpeg.wasm ships its own pre-built worker/core; don't let Vite pre-bundle it.
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
  },
});
