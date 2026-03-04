const winkNLP = require('wink-nlp');
const model = require('wink-eng-lite-web-model');
const nlp = winkNLP(model);
const its = nlp.its;

function parseReminder(text) {
    const doc = nlp.readDoc(text);
    const lowerText = text.toLowerCase();
    let remindAt = new Date();
    let dateText = "Not specified";

    // 1. Handle "in X minutes" (including words like 'two')
    const minuteMatch = lowerText.match(/(\d+|one|two|three|four|five|ten|fifteen|thirty|mins?|minutes?)/g);
    if (lowerText.includes('min') || lowerText.includes('minute')) {
        const numMap = { one:1, two:2, three:3, four:4, five:5, ten:10, fifteen:15, thirty:30 };
        const amount = parseInt(minuteMatch[0]) || numMap[minuteMatch[0]] || 1;
        remindAt.setMinutes(remindAt.getMinutes() + amount);
        dateText = `${amount} minutes from now`;
    } 
    // 2. Handle "at X pm" or "by X:XX"
    else {
        const timeMatch = lowerText.match(/(\d{1,2})(:(\d{2}))?\s*(am|pm)?/i);
        if (timeMatch) {
            let hours = parseInt(timeMatch[1]);
            const minutes = timeMatch[3] ? parseInt(timeMatch[3]) : 0;
            const ampm = timeMatch[4] ? timeMatch[4].toLowerCase() : null;

            if (ampm === 'pm' && hours < 12) hours += 12;
            if (ampm === 'am' && hours === 12) hours = 0;
            
            // If no AM/PM and time is 'behind' us, assume PM (e.g., it's 2pm and you say 'at 5')
            if (!ampm && hours < remindAt.getHours()) hours += 12;

            remindAt.setHours(hours, minutes, 0, 0);
            dateText = remindAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
    }

    let task = text.replace(/remind me to|remind me about|at \d+.*|in \d+.*/gi, '').trim();

    return { 
        task: task || "Something important", 
        timeString: dateText,
        isoDate: remindAt.toISOString() 
    };
}

module.exports = { parseReminder };