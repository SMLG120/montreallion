// MapLibre 6 loads its web worker from a file next to its own module (import.meta.url).
// Once bundled, that URL points into /_next/static and 404s, so the map never draws tiles or layers.
// We serve the worker from public/ instead (see setWorkerUrl in src/components/map/map-view.tsx).
// Runs before `dev` and `build` so the copy always matches the installed maplibre-gl version.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve("maplibre-gl/package.json"));
const outDir = join(process.cwd(), "public", "vendor");
mkdirSync(outDir, { recursive: true });
copyFileSync(join(pkgDir, "dist", "maplibre-gl-worker.mjs"), join(outDir, "maplibre-gl-worker.mjs"));
