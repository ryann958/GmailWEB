import "dotenv/config";
import { loadConfig } from "./config.js";
import { createDatabasePool } from "./db.js";
import { createApp } from "./app.js";
import { createMailer } from "./mailer.js";

async function start() {
  const config = loadConfig();
  const pool = createDatabasePool(config);
  await pool.query("SELECT 1");

  const app = await createApp({
    pool,
    config,
    mailer: createMailer(config),
  });
  const server = app.listen(config.port, () => {
    console.info(`MailMu server listening on port ${config.port}.`);
  });

  const shutdown = async (signal) => {
    console.info(`Received ${signal}; shutting down.`);
    server.close(async (error) => {
      if (error) console.error("HTTP server shutdown failed:", error.message);
      await pool.end();
      process.exitCode = error ? 1 : 0;
    });
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

start().catch((error) => {
  console.error("MailMu server failed to start:", error.message);
  process.exitCode = 1;
});
