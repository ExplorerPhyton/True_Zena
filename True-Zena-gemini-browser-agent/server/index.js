// Entry point. Deliberately tiny: its only job is to load .env.local
// *before* anything else runs.
//
// Why not just `import` app.js normally at the top of this file next to
// a process.loadEnvFile() call? Because ES module imports are hoisted -
// every static `import` in a file is resolved and evaluated before any of
// that file's own top-level code runs, no matter where the import
// statement is textually written. If app.js (or anything it imports) is
// a static import here, it would finish evaluating before
// process.loadEnvFile() below ever executes. Using a dynamic import()
// instead is a normal function call that runs exactly where it's
// written, so .env.local is guaranteed to be loaded first.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(here, "..", ".env.local"));
} catch {
  // .env.local is optional - real deployments set environment variables
  // directly instead of shipping a dotenv file.
}

const { startServer } = await import("./app.js");
startServer();
