require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8000;
// שים לב: הוצאנו מפה את המשתנים של גרין API, כי עכשיו הכל דינמי לכל לקוח!
const { MONGODB_URI, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
const GREEN_API_HOST = 'https://api.green-api.com';

// --- חיבור למסד הנתונים ---
mongoose.connect(MONGODB_URI || 'mongodb://localhost:27017/multi_tenant_bot')
    .then(() => console.log('✅ מסד נתונים מרכזי מחובר'))
    .catch(err => console.log('❌ שגיאת חיבור למסד נתונים:', err));

// סכמה ללקוחות שלך - שומרת את החשבון הספציפי של כל לקוח!
const ClientAuthSchema = new mongoose.Schema({
    instanceId: String,
    apiToken: String,
    googleTokens: Object
});
const ClientAuth = mongoose.model('ClientAuth', ClientAuthSchema);

// סכמה למצב שיחות מול משתמשים בוואטסאפ
const ChatStateSchema = new mongoose.Schema({
    instanceId: String, // חשוב! מפריד בין לקוחות שונים
    chatId: String,
    state: { type: String, default: 'IDLE' }
});
const ChatState = mongoose.model('ChatState', ChatStateSchema);

// --- פונקציה לשליחת וואטסאפ ללקוח הספציפי ---
async function sendWAMessage(instanceId, apiToken, chatId, message) {
    const url = `${GREEN_API_HOST}/waInstance${instanceId}/sendMessage/${apiToken}`;
    await axios.post(url, { chatId, message }).catch(e => console.log("❌ שגיאת וואטסאפ:", e.message));
}

// ==========================================
// 1. הנגשה: הלינק החכם שאתה נותן ללקוחות שלך
// ==========================================
app.get('/auth/google', (req, res) => {
    const { instance, token } = req.query;
    if (!instance || !token) {
        return res.send("<h2 style='color:red;text-align:center'>שגיאה: חסרים נתוני Green API בקישור (instance / token)</h2>");
    }

    const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
    
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline', 
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/contacts'],
        // הטריק: אנחנו מעבירים לגוגל את נתוני הלקוח, כדי שיחזיר לנו אותם בסיום האישור!
        state: `${instance}___${token}` 
    });
    res.redirect(url);
});

// החזרה מגוגל ושמירה של הלקוח הספציפי במסד הנתונים
app.get('/auth/google/callback', async (req, res) => {
    try {
        const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
        const { tokens } = await oauth2Client.getToken(req.query.code);
        
        // מחלצים את הנתונים של הלקוח הספציפי
        const [instanceId, apiToken] = req.query.state.split('___');

        // שומרים או מעדכנים את הלקוח במסד הנתונים המרכזי
        await ClientAuth.findOneAndUpdate(
            { instanceId: instanceId }, 
            { apiToken: apiToken, googleTokens: tokens }, 
            { upsert: true, new: true }
        );

        res.send(`<h1 style="color: green; text-align: center; margin-top: 50px;">✅ סנכרון בוצע בהצלחה! הבוט מחובר לחשבון הגוגל שלך.</h1>`);
    } catch (error) {
        console.error(error);
        res.status(500).send('❌ שגיאה באימות מול גוגל');
    }
});

// ==========================================
// 2. הבוט המרכזי (רץ עבור כל הלקוחות ביחד!)
// ==========================================
app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.typeWebhook !== 'incomingMessageReceived') return res.sendStatus(200);

    // מאיזה לקוח שלנו הגיעה ההודעה?
    const currentInstanceId = body.idInstance; 
    const chatId = body.senderData?.chatId;
    let text = (body.messageData?.textMessageData?.textMessage || body.messageData?.extendedTextMessageData?.text || "").trim();
    
    if (!currentInstanceId || !chatId || !text) return res.sendStatus(200);

    // שולפים את נתוני הגוגל של הלקוח *הספציפי* הזה ממסד הנתונים
    const clientData = await ClientAuth.findOne({ instanceId: currentInstanceId });
    if (!clientData || !clientData.googleTokens) {
        console.log(`⚠️ הודעה התקבלה עבור לקוח ${currentInstanceId} אבל הוא עדיין לא מחובר לגוגל.`);
        return res.sendStatus(200);
    }

    // שולפים את מצב השיחה (מול הלקוח הספציפי)
    let chat = await ChatState.findOne({ instanceId: currentInstanceId, chatId: chatId });
    if (!chat) chat = new ChatState({ instanceId: currentInstanceId, chatId: chatId, state: 'IDLE' });

    // --- הזרימה ---

    // שלב 1: זיהוי ההודעה
    if (text === "שלום אשמח לצפות בסטטוס שלך" || text === "אשמח לצפות בסטטוס") {
        await sendWAMessage(currentInstanceId, clientData.apiToken, chatId, "מה השם?");
        chat.state = 'WAITING_FOR_NAME';
        await chat.save();
        return res.sendStatus(200);
    }

    // שלב 2: קבלת השם ושמירה בגוגל של הלקוח!
    if (chat.state === 'WAITING_FOR_NAME') {
        const contactName = text;
        const phoneNumber = "+" + chatId.replace('@c.us', ''); 

        try {
            const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
            // מגדירים את הגישה הספציפית של הלקוח הזה
            oauth2Client.setCredentials(clientData.googleTokens);

            const people = google.people({ version: 'v1', auth: oauth2Client });
            await people.people.createContact({
                requestBody: {
                    names: [{ givenName: contactName }],
                    phoneNumbers: [{ value: phoneNumber }]
                }
            });
            console.log(`👤 איש קשר נשמר בהצלחה בגוגל של לקוח: ${currentInstanceId}`);
        } catch (err) {
            console.error('❌ שגיאה ביצירת איש קשר:', err.message);
        }

        await sendWAMessage(currentInstanceId, clientData.apiToken, chatId, "נשמרת");
        
        chat.state = 'COMPLETED';
        await chat.save();
        return res.sendStatus(200);
    }

    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`🚀 TPG Multi-Tenant Bot running on port ${PORT}`));
