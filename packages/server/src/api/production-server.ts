import { startDevServer } from "./dev-server.js";

// A production deployment owns its schema lifecycle. Explicitly run the checked-in
// migrations before accepting traffic rather than relying on a deployment env var.
// The bundled entry point is authoritative even when the platform does not inject
// NODE_ENV, so production-only session safeguards cannot be accidentally disabled.
await startDevServer({ ...process.env, NODE_ENV: "production" }, { runMigrations: true });
