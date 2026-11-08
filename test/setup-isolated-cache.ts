import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll } from "vitest";

/**
 * Point the default cache at a throwaway directory for every test file.
 * Without this, tests that call findModels()/main() with a mocked fetch and
 * no cacheOptions write fixture data into the developer's REAL per-user
 * cache (e.g. %LOCALAPPDATA%\smallm\cache), and the next real `smallm`
 * run serves those fake results until they expire. defaultCacheDir()
 * checks XDG_CACHE_HOME first on every platform, and is evaluated lazily,
 * so setting it here (before any test runs) is enough.
 */
const isolatedCacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "smallm-test-cache-home-"));
process.env.XDG_CACHE_HOME = isolatedCacheHome;

afterAll(() => {
  fs.rmSync(isolatedCacheHome, { recursive: true, force: true });
});
