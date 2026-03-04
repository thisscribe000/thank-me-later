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

// 2. AI ENGINE
async function loadAI() {
    console.log("⏳ Loading Whisper AI model locally...");
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
    console.log("✅ AI Model Loaded & Ready!");
}
loadAI();

// 3. SESSIONS
bot.use(session({ initial: () => ({ tempTask: null, tempTime: null, tempDate: null }) }));

// 4. USER REGISTRATION & DAILY RESET MIDDLEWARE
bot.use(async (ctx, next) => {
    if (ctx.from) {
        const userIdStr = ctx.from.id.toString();
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        
        let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userIdStr);
        
        if (!user) {
            console.log(`🆕 Registering: ${ctx.from.username}`);
            db.prepare('INSERT INTO users (telegram_id, username, credits, last_reset) VALUES (?, ?, ?, ?)')
              .run(userIdStr, ctx.from.username || 'Anonymous', 10, today);
            user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userIdStr);
        }

        // Reset daily limits if it's a new day
        if (user.last_reset !== today) {
            db.prepare('UPDATE users SET daily_text_count = 0, daily_voice_count = 0, last_reset = ? WHERE id = ?')
              .run(today, user.id);
            user.daily_text_count = 0;
            user.daily_voice_count = 0;
        }
        
        ctx.user = user; 
    }
    await next();
});

// --- COMMANDS ---

bot.command("start", (ctx) => {
    ctx.reply(`Welcome ${ctx.from.first_name}! 🕒\n\nDaily Free: 4 Text / 1 Voice\nYour Credits: ${ctx.user.credits}\n\nTry: "Remind me to check the oven in 5 minutes"`);
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
        `📊 **DASHBOARD**\n\n` +
        `🪙 Credits: ${ctx.user.credits}\n` +
        `📝 Daily Texts: ${ctx.user.daily_text_count}/4\n` +
        `🎙️ Daily Voice: ${ctx.user.daily_voice_count}/1\n\n` +
        `🕒 **Active Reminders:**\n${reminderList}`,
        {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "💳 Buy 50 Credits (150 Stars)", callback_data: "buy_credits" }],
                    [{ text: "🗑️ Clear All", callback_data: "clear_all" }]
                ]
            }
        }
    );
});

// --- MESSAGE HANDLERS ---

bot.on("message:text", async (ctx) => {
    // Allowance Check
    if (ctx.user.daily_text_count >= 4 && ctx.user.credits <= 0) {
        return ctx.reply("🪫 Daily free limit reached! Use /dashboard to get more credits.");
    }

    const analysis = parseReminder(ctx.message.text);
    ctx.session.tempTask = analysis.task;
    ctx.session.tempTime = analysis.timeString;
    ctx.session.tempDate = analysis.isoDate;

    await ctx.reply(`Confirming:\n📝 *Task:* ${analysis.task}\n⏰ *When:* ${analysis.timeString}`, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [[
                { text: "✅ Log It", callback_data: "confirm_text" },
                { text: "❌ Cancel", callback_data: "cancel" }
            ]]
        }
    });
});

bot.on("message:voice", async (ctx) => {
    // Allowance Check
    if (ctx.user.daily_voice_count >= 1 && ctx.user.credits <= 0) {
        return ctx.reply("🎙️ Daily voice limit reached! Use text or upgrade at the /dashboard.");
    }

    const msg = await ctx.reply("🎙️ Thinking... (Processing locally)");
    
    try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
        const outputPath = `./voice-temp/${ctx.from.id}.wav`;

        ffmpeg(url).toFormat('wav').audioChannels(1).audioFrequency(16000).on('end', async () => {
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
                `I heard: "${transcript}"\n\nConfirm:\n📝 *Task:* ${analysis.task}\n⏰ *When:* ${analysis.timeString}`, {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [[
                        { text: "✅ Log It", callback_data: "confirm_voice" },
                        { text: "❌ Cancel", callback_data: "cancel" }
                    ]]
                }
            });
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        }).save(outputPath);
    } catch (err) {
        ctx.reply("Could not process voice note.");
    }
});

// --- CALLBACK QUERIES ---

// --- 1. BUTTON CALLBACK HANDLER ---
bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // A. Handle Confirmation (Deducting Allowance/Credits)
    if (data.startsWith("confirm")) {
        try {
            if (data === "confirm_voice" && ctx.user.daily_voice_count < 1) {
                db.prepare('UPDATE users SET daily_voice_count = daily_voice_count + 1 WHERE id = ?').run(ctx.user.id);
            } else if (data === "confirm_text" && ctx.user.daily_text_count < 4) {
                db.prepare('UPDATE users SET daily_text_count = daily_text_count + 1 WHERE id = ?').run(ctx.user.id);
            } else {
                db.prepare('UPDATE users SET credits = credits - 1 WHERE id = ?').run(ctx.user.id);
            }

            db.prepare('INSERT INTO reminders (user_id, task, remind_at, status) VALUES (?, ?, ?, ?)')
              .run(ctx.user.id, ctx.session.tempTask, ctx.session.tempDate, 'pending');

            await ctx.editMessageText(`🚀 *Confirmed!* I'll remind you about "${ctx.session.tempTask}" at ${ctx.session.tempTime}.`);
        } catch (err) {
            console.error("Confirm error:", err);
            await ctx.reply("❌ Error saving reminder. Please try again.");
        }
    } 
    // B. Handle Invoice Trigger
    else if (data === "buy_credits") {
        await ctx.replyWithInvoice(
            "Later+ Lite (150 Credits)", 
            "Get 150 extra voice/text reminders. No daily limits, no expiry!", 
            "credits_150", 
            "XTR", 
            [{ amount: 150, label: "150 Credits" }] 
        );
    }
    // C. Handle Clear All
    else if (data === "clear_all") {
        db.prepare("UPDATE reminders SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'").run(ctx.user.id);
        await ctx.editMessageText("🗑️ All pending reminders have been cleared.");
    }
    // D. Handle Cancel
    else if (data === "cancel") {
        await ctx.editMessageText("❌ Action cancelled.");
    }

    await ctx.answerCallbackQuery();
});

// --- 2. PAYMENT HANDLERS (MUST BE OUTSIDE BUTTON HANDLER) ---

// Required: Approve pre-checkout within 10 seconds
bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));

// Handle the final success
bot.on("message:successful_payment", async (ctx) => {
    if (ctx.message.successful_payment.invoice_payload === "credits_150") {
        db.prepare('UPDATE users SET credits = credits + 150 WHERE telegram_id = ?')
          .run(ctx.from.id.toString());
        
        await ctx.reply("🎉 Success! 150 Credits added. Your limits are now bypassed until credits run out.");
        console.log(`[REVENUE] User ${ctx.from.id} purchased 150 Credits.`);
    }
});
// --- PAYMENTS & SCHEDULER ---

bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));

bot.on("message:successful_payment", async (ctx) => {
    if (ctx.message.successful_payment.invoice_payload === "credits_50") {
        db.prepare('UPDATE users SET credits = credits + 50 WHERE telegram_id = ?').run(ctx.from.id.toString());
        await ctx.reply("🎉 50 credits added! Thank you for supporting the project.");
    }
});

cron.schedule('* * * * *', async () => {
    const now = new Date().toISOString();
    const due = db.prepare(`
        SELECT reminders.id, reminders.task, users.telegram_id FROM reminders 
        JOIN users ON reminders.user_id = users.id 
        WHERE reminders.remind_at <= ? AND reminders.status = 'pending'
    `).all(now);

    for (const rem of due) {
        try {
            await bot.api.sendMessage(rem.telegram_id, `🔔 **REMINDER:** ${rem.task}`);
            db.prepare("UPDATE reminders SET status = 'sent' WHERE id = ?").run(rem.id);
        } catch (err) { console.error(err); }
    }
});

bot.start();
console.log(">>> Thank Me Later Bot is officially running...");