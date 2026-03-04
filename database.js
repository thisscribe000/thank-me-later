const Database = require('better-sqlite3');
const db = new Database('thank_me_later.db');

// Initialize Tables with Daily Tracking & Monetization columns
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    telegram_id TEXT UNIQUE,
    username TEXT,
    credits INTEGER DEFAULT 10,
    is_premium INTEGER DEFAULT 0,
    daily_text_count INTEGER DEFAULT 0,
    daily_voice_count INTEGER DEFAULT 0,
    last_reset TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    task TEXT,
    remind_at DATETIME,
    status TEXT DEFAULT 'pending',
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

module.exports = db;