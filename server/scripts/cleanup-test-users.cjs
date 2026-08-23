const { DatabaseSync } = require('node:sqlite');
const { join } = require('node:path');

const dbPath = process.env.DB_PATH ?? join(process.cwd(), 'data', 'duekeeper.db');
const db = new DatabaseSync(dbPath);
const result = db
  .prepare("DELETE FROM users WHERE email LIKE 'prodcheck\\_%' ESCAPE '\\'")
  .run();
console.log(`cleanup: removed ${result.changes} test user(s)`);
