import { createServer } from 'node:http';

import { createScriptedRunner } from './agent/scripted-runner.js';
import { createApp } from './app.js';
import { createPostgresAuditLog } from './audit/write.js';
import { createIapVerifier } from './auth/iap.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createHttpDrive } from './retrieval/http-drive.js';

const config = loadConfig(process.env);
const sql = await openDatabase(config.databaseUrl);

createServer(
  createApp({
    verify: createIapVerifier(config.iap),
    drive: createHttpDrive({ baseUrl: config.driveUrl }),
    runner: createScriptedRunner({ baseUrl: config.llmUrl }),
    audit: createPostgresAuditLog(sql),
    now: () => new Date(),
  }),
).listen(config.port, '0.0.0.0');
