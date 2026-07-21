import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

/** Fallback when package.json cannot be resolved (e.g. unusual packaging). */
const FALLBACK_VERSION = "1.2.0";

/**
 * Read the published package version from package.json next to dist/.
 */
export function getVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/version.js → ../package.json (published layout)
    const pkgPath = join(here, "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    /* try require resolve */
  }

  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    /* ignore */
  }

  return FALLBACK_VERSION;
}
