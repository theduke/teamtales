import { startDevServer } from "./dev-server.js";

// A production deployment owns its schema lifecycle. Explicitly run the checked-in
// migrations before accepting traffic rather than relying on a deployment env var.
await startDevServer(process.env, { runMigrations: true });
