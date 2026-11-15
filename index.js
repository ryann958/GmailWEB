import "dotenv/config";
import { createApp } from "./server/app.js";
import { loadConfig } from "./server/config.js";
import { createDatabasePool } from "./server/db.js";
import { createMailer } from "./server/mailer.js";

const config = loadConfig();
const pool = createDatabasePool(config);
const app = await createApp({
  pool,
  config,
  mailer: createMailer(config),
});

export default app;
