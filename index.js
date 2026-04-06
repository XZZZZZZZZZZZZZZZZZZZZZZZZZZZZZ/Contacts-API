require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8000;
const { MONGODB_URI, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, INSTANCE_ID, API_TOKEN } = process.env;
const GREEN_API_HOST = 'https://api.green-api.com';

// --- חיבור למסד הנתונים ---
mongoose.connect(MONGODB_URI || 'mongodb://localhost:27017/status_bot_db')
    .then(() => console.log('✅ מסד נתונים מחובר בהצלחה'))
    .catch(err => console.log('❌ שגיאת חיבור למסד נתונים:', err));

// סכמה לניהול מצב השיחה (כדי לדעת מתי אנחנו מחכים לשם)
const ChatStateSchema = new mongoose.Schema({
    chatId: String,
    state: { type: String, default: 'IDLE' }
});
const ChatState = mongoose.model('ChatState', ChatStateSchema);

// סכמה לשמירת ההרשאה של גוגל
const SystemSchema = new mongoose.Schema({ key: String, tokens: Object });
const System = mongoose.model('System', SystemSchema);

// --- הגדרת גוגל ---
const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
);

async function loadGoogleAuth() {
    const authData = await System.findOne({ key: 'google_auth' });
    if (authData && authData.tokens) {
        oauth2Client.setCredentials(authData.tokens);
    }
}
loadGoogleAuth();

// --- פונקציה לשליחת הודעת וואטסאפ ---
async function sendWAMessage(chatId, message) {
    if (!INSTANCE_ID || !API_TOKEN) return;
    const url = `${GREEN_API_HOST}/waInstance${INSTANCE_ID}/sendMessage/${API_TOKEN}`;
    await axios.post(url, { chatId, message }).catch(e => console.log("❌ שגיאה בשליחת וואטסאפ:", e.message));
}

// ==========================================
// 1. הנגשה: אישור ראשוני מול גוגל
// ==========================================
app.get('/auth/google', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline', 
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/contacts'] 
    });
    res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
    try {
        const { tokens } = await oauth2Client.getToken(req.query.code);
        oauth2Client.setCredentials(tokens);
        await System.findOneAndUpdate({ key: 'google_auth' }, { tokens: tokens }, { upsert: true });
        res.send(`<h1 style="color: green; text-align: center; margin-top: 50px;">✅ סנכרון אנשי הקשר בוצע בהצלחה! הבוט באוויר.</h1>`);
    } catch (error) {
        res.status(500).send('❌ שגיאה באימות מול גוגל');
    }
});

// ==========================================
// 2. הבוט עצמו (Webhook מוואטסאפ)
// ==========================================
app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.typeWebhook !== 'incomingMessageReceived') return res.sendStatus(200);

    const chatId = body.senderData?.chatId;
    let text = (body.messageData?.textMessageData?.textMessage || body.messageData?.extendedTextMessageData?.text || "").trim();
    
    if (!chatId || !text) return res.sendStatus(200);

    // מושכים את הלקוח מהמסד כדי לבדוק באיזה שלב הוא
    let chat = await ChatState.findOne({ chatId });
    if (!chat) {
        chat = new ChatState({ chatId, state: 'IDLE' });
    }

    // שלב 1: זיהוי ההודעה הראשונית
    if (text === "שלום אשמח לצפות בסטטוס שלך" || text === "אשמח לצפות בסטטוס") {
        await sendWAMessage(chatId, "מה השם?");
        chat.state = 'WAITING_FOR_NAME';
        await chat.save();
        return res.sendStatus(200);
    }

    // שלב 2: קבלת השם ושמירה בגוגל
    if (chat.state === 'WAITING_FOR_NAME') {
        const clientName = text;
        const phoneNumber = "+" + chatId.replace('@c.us', ''); 

        try {
            await loadGoogleAuth();
            if (oauth2Client.credentials && oauth2Client.credentials.access_token) {
                const people = google.people({ version: 'v1', auth: oauth2Client });
                await people.people.createContact({
                    requestBody: {
                        names: [{ givenName: clientName }],
                        phoneNumbers: [{ value: phoneNumber }]
                    }
                });
                console.log(`✅ איש קשר נשמר בגוגל: ${clientName} (${phoneNumber})`);
            }
        } catch (err) {
            console.error('❌ שגיאה ביצירת איש קשר בגוגל:', err.message);
        }

        await sendWAMessage(chatId, "נשמרת");
        
        // מעדכנים סטטוס כדי שהבוט לא ישאל שוב
        chat.state = 'COMPLETED';
        await chat.save();
        return res.sendStatus(200);
    }

    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`🚀 WA Status Bot is running on port ${PORT}`));
