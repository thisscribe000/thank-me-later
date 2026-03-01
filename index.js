require('dotenv').config();
const { Bot, session } = require('grammy');
const db = require('./database');
const { parseReminder } = require('./nlp-engine');
const ffmpeg = require('fluent-ffmpeg');
const { pipeline } = require('@xenova/transformers');
const fs = require('fs');
const { WaveFile } = require('wavefile');
const cron = require('node-cron');

// 1. SYSTEM CONFIG
ffmpeg.setFfmpegPath('/opt/homebrew/bin/ffmpeg');

const bot = new Bot(process.env.BOT_TOKEN);
let transcriber;

// 2. AI ENGINE: Load Whisper locally
async function loadAI() {
    console.log("⏳ Loading Whisper AI model locally...");
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
    console.log("✅ AI Model Loaded & Ready!");
}
loadAI();

// 3. STORAGE & SESSIONS
bot.use(session({ initial: () => ({ tempTask: null, tempTime: null, tempDate: null }) }));

// 4. USER REGISTRATION & CONTEXT
bot.use(async (ctx, next) => {
    if (ctx.from) {
        const userIdStr = ctx.from.id.toString();
        let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userIdStr);
        
        if (!user) {
            console.log(`🆕 Registering: ${ctx.from.username}`);
            db.prepare('INSERT INTO users (telegram_id, username, credits) VALUES (?, ?, ?)')
              .run(userIdStr, ctx.from.username || 'Anonymous', 10);
            user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userIdStr);
        }
        ctx.user = user; 
    }
    await next();
});

// --- COMMANDS ---

bot.command("start", (ctx) => {
    ctx.reply(`Welcome ${ctx.from.first_name}! 🕒\n\nYou have ${ctx.user.credits} credits remaining.\n\nSend me a text or voice note like: "Remind me to call the bank tomorrow at 10am".`);
});

bot.command("dashboard", async (ctx) => {
    const reminders = db.prepare(`
        SELECT task, remind_at FROM reminders 
        WHERE user_id = ? AND status = 'pending'
        ORDER BY remind_at ASC
    `).all(ctx.user.id);

    let reminderList = reminders.length > 0 
        ? reminders.map(r => `• ${r.task} (${new Date(r.remind_at).toLocaleString()})`).join('\n')
        : "No active reminders.";

    await ctx.reply(
        `📊 **THANK ME LATER DASHBOARD**\n\n` +
        `👤 **User:** ${ctx.from.username || 'Anonymous'}\n` +
        `🪙 **Credits:** ${ctx.user.credits}\n` +
        `⭐ **Status:** ${ctx.user.is_premium ? 'Later+ (Premium)' : 'Free Tier'}\n\n` +
        `🕒 **Active Reminders:**\n${reminderList}`,
        {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "💳 Buy Credits", callback_data: "buy_credits" }],
                    [{ text: "🗑️ Clear All Reminders", callback_data: "clear_all" }]
                ]
            }
        }
    );
});

// --- HANDLERS ---

bot.on("message:text", async (ctx) => {
    if (ctx.user.credits <= 0) return ctx.reply("🪫 Out of credits! Use /dashboard to upgrade.");

    const analysis = parseReminder(ctx.message.text);
    ctx.session.tempTask = analysis.task;
    ctx.session.tempTime = analysis.timeString;
    ctx.session.tempDate = analysis.isoDate;

    await ctx.reply(`Confirming:\n📝 *Task:* ${analysis.task}\n⏰ *When:* ${analysis.timeString}`, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [[
                { text: "✅ Log It", callback_data: "confirm" },
                { text: "❌ Cancel", callback_data: "cancel" }
            ]]
        }
    });
});

bot.on("message:voice", async (ctx) => {
    if (ctx.user.credits <= 0) return ctx.reply("⚠️ Out of credits! Upgrade for unlimited voice reminders.");

    const msg = await ctx.reply("🎙️ Thinking... (Processing locally)");
    
    try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
        const outputPath = `./voice-temp/${ctx.from.id}.wav`;

        ffmpeg(url)
            .toFormat('wav')
            .audioChannels(1)
            .audioFrequency(16000)
            .on('end', async () => {
                const buffer = fs.readFileSync(outputPath);
                const wav = new WaveFile(buffer);
                wav.toBitDepth('32f'); 
                const audioData = wav.getSamples();
                
                const output = await transcriber(audioData);
                const transcript = output.text;
                
                const analysis = parseReminder(transcript);
                ctx.session.tempTask = analysis.task;
                ctx.session.tempTime = analysis.timeString;
                ctx.session.tempDate = analysis.isoDate;

                await ctx.api.editMessageText(ctx.chat.id, msg.message_id, 
                    `I heard: "${transcript}"\n\nConfirming:\n📝 *Task:* ${analysis.task}\n⏰ *When:* ${analysis.timeString}`, {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "✅ Log It", callback_data: "confirm" },
                            { text: "❌ Cancel", callback_data: "cancel" }
                        ]]
                    }
                });
                
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            })
            .save(outputPath);
    } catch (err) {
        console.error("Voice Error:", err);
        ctx.reply("Sorry, I couldn't process that voice note.");
    }
});

// --- BUTTON CALLBACKS ---

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data === "confirm") {
        db.prepare('INSERT INTO reminders (user_id, task, remind_at, status) VALUES (?, ?, ?, ?)')
          .run(ctx.user.id, ctx.session.tempTask, ctx.session.tempDate, 'pending');

        db.prepare('UPDATE users SET credits = credits - 1 WHERE id = ?').run(ctx.user.id);

        await ctx.editMessageText(`🚀 *Log confirmed!* I'll remind you at ${ctx.session.tempTime}.\nRemaining credits: ${ctx.user.credits - 1}`);
    } 
    else if (data === "clear_all") {
        db.prepare("UPDATE reminders SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'")
          .run(ctx.user.id);
        await ctx.editMessageText("🗑️ All pending reminders have been cleared.");
    } 
    else if (data === "buy_credits") {
        await ctx.reply("💰 Payment integration (Telegram Stars) is coming next!");
    }
    else {
        await ctx.editMessageText("❌ Cancelled.");
    }
    await ctx.answerCallbackQuery();
});

// --- SCHEDULER ---

cron.schedule('* * * * *', async () => {
    const now = new Date().toISOString();
    const due = db.prepare(`
        SELECT reminders.id, reminders.task, users.telegram_id 
        FROM reminders 
        JOIN users ON reminders.user_id = users.id 
        WHERE reminders.remind_at <= ? AND reminders.status = 'pending'
    `).all(now);

    for (const rem of due) {
        try {
            await bot.api.sendMessage(rem.telegram_id, `🔔 **THANK ME LATER:**\n\nDon't forget: "${rem.task}"`);
            db.prepare("UPDATE reminders SET status = 'sent' WHERE id = ?").run(rem.id);
            console.log(`[SENT] Success: ${rem.task}`);
        } catch (err) {
            console.error("Delivery error:", err);
        }
    }
});

bot.catch((err) => console.error("CRITICAL ERROR:", err));

// --- PAYMENT HANDLERS (TELEGRAM STARS) ---

// 1. Send the Invoice when they click "Buy Credits"
bot.on("callback_query:data", async (ctx) => {
    if (ctx.callbackQuery.data === "buy_credits") {
        await ctx.replyWithInvoice(
            "100 Thank Me Later Credits", // Title
            "Unlock 100 high-priority AI voice transcriptions and reminders.", // Description
            "credits_100", // Payload (Internal ID)
            "XTR", // Currency for Telegram Stars
            [{ amount: 100, label: "100 Credits" }] // 100 Stars
        );
    }
    await ctx.answerCallbackQuery();
});

// 2. Answer the Pre-Checkout Query (Must respond within 10 seconds)
bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));

// 3. Handle Successful Payment
bot.on("message:successful_payment", async (ctx) => {
    const payload = ctx.message.successful_payment.invoice_payload;
    
    if (payload === "credits_100") {
        // Update the database
        db.prepare('UPDATE users SET credits = credits + 100 WHERE telegram_id = ?')
          .run(ctx.from.id.toString());
        
        await ctx.reply("🎉 Payment Successful! 100 credits have been added to your account. Use /dashboard to check your balance.");
        console.log(`[REVENUE] User ${ctx.from.id} bought 100 credits.`);
    }
});

bot.start();
console.log(">>> Thank Me Later Bot is officially running...");