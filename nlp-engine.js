const winkNLP = require('wink-nlp');
const model = require('wink-eng-lite-web-model');
const nlp = winkNLP(model);
const its = nlp.its;

function parseReminder(text) {
    const doc = nlp.readDoc(text);
    // 1. Extract potential dates and quantities (like 'two' or '2')
    const entities = doc.entities().out(); 
    const types = doc.entities().out(its.type);
    
    let dateText = "Not specified";
    let remindAt = new Date();

    // 2. Look for explicit dates or time duration keywords
    const lowerText = text.toLowerCase();
    
    if (lowerText.includes('minute')) {
        // Extract the number (handle "two" or "2")
        const match = lowerText.match(/(\d+|one|two|three|four|five|ten|fifteen|thirty)/);
        const numMap = { one:1, two:2, three:3, four:4, five:5, ten:10, fifteen:15, thirty:30 };
        const mins = match ? (parseInt(match[0]) || numMap[match[0]]) : 1;
        
        remindAt.setMinutes(remindAt.getMinutes() + mins);
        dateText = `${mins} minutes from now`;
    } else if (lowerText.includes('tomorrow')) {
        remindAt.setDate(remindAt.getDate() + 1);
        remindAt.setHours(9, 0, 0);
        dateText = "Tomorrow at 9 AM";
    }

    // 3. Clean the task name
    let task = text.replace(/remind me to/i, '').trim();
    if (dateText !== "Not specified") {
        // Remove the time phrase from the task so it's just the action
        task = task.replace(/in \d+ minutes|in two minutes|tomorrow/i, '').trim();
    }

    return { 
        task: task || "Something important", 
        timeString: dateText,
        isoDate: remindAt.toISOString() 
    };
}

module.exports = { parseReminder };