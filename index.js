require('dotenv').config();
const { Bot } = require('grammy');
const db = require('./database');

// Create the bot instance using your .env token
const bot = new Bot(process.env.BOT_TOKEN);

// Middleware to register/check user in our local DB
bot.use(async (ctx, next) => {
    if (ctx.from) {
        const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(ctx.from.id.toString());
        
        if (!user) {
            db.prepare('INSERT INTO users (telegram_id, username, credits) VALUES (?, ?, ?)')
              .run(ctx.from.id.toString(), ctx.from.username || 'Anonymous', 10); // 10 free credits to start
            console.log(`New user registered: ${ctx.from.username}`);
        }
    }
    await next();
});

// The /start command
bot.command("start", (ctx) => {
    ctx.reply("Welcome to 'Thank Me Later'! 🕒\n\nSend me a text or a voice note of what you want to remember, and I'll handle the rest.");
});

// Error handling
bot.catch((err) => console.error("Bot Error:", err));

// Start the bot (Long Polling)
bot.start();
console.log("Thank Me Later Bot is running...");