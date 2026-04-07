require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8000;
const { MONGODB_URI, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
const GREEN_API_HOST = 'https://api.green-api.com';

// --- חיבור למסד הנתונים ---
mongoose.connect(MONGODB_URI || 'mongodb://localhost:27017/multi_tenant_bot')
    .then(() => console.log('✅ מסד נתונים מרכזי מחובר (Multi-Tenant)'))
    .catch(err => console.log('❌ שגיאת חיבור למסד נתונים:', err));

// סכמות
const ClientAuthSchema = new mongoose.Schema({
    instanceId: String,
    apiToken: String,
    googleTokens: Object
});
const ClientAuth = mongoose.model('ClientAuth', ClientAuthSchema);

const ChatStateSchema = new mongoose.Schema({
    instanceId: String,
    chatId: String,
    state: { type: String, default: 'IDLE' }
});
const ChatState = mongoose.model('ChatState', ChatStateSchema);

// --- פונקציה לשליחת וואטסאפ עם לוגים מפורטים ---
async function sendWAMessage(instanceId, apiToken, chatId, message) {
    const url = `${GREEN_API_HOST}/waInstance${instanceId}/sendMessage/${apiToken}`;
    console.log(`🚀 [שליחה] מנסה לשלוח הודעה ל-${chatId} (Instance: ${instanceId})`);

    try {
        const response = await axios.post(url, { chatId, message });
        console.log(`✅ [שליחה] הודעה נשלחה בהצלחה! מזהה: ${response.data.idMessage}`);
    } catch (e) {
        console.log(`❌ [שליחה] שגיאת וואטסאפ ב-Instance ${instanceId}:`);
        if (e.response) {
            console.log(`סטטוס: ${e.response.status} | נתונים:`, JSON.stringify(e.response.data));
        } else {
            console.log(e.message);
        }
    }
}

// ==========================================
// 1. הנגשה ואימות גוגל (לוגים לתהליך ההתחברות)
// ==========================================
app.get('/auth/google', (req, res) => {
    const { instance, token } = req.query;
    console.log(`🔗 [Auth] לקוח התחיל תהליך אימות עבור Instance: ${instance}`);

    if (!instance || !token) {
        return res.send("<h2 style='color:red;text-align:center'>שגיאה: חסרים נתוני Green API</h2>");
    }

    const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline', 
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/contacts'],
        state: `${instance}___${token}` 
    });
    res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
    try {
        const [instanceId, apiToken] = req.query.state.split('___');
        console.log(`📥 [Auth Callback] התקבל קוד אישור עבור Instance: ${instanceId}`);

        const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
        const { tokens } = await oauth2Client.getToken(req.query.code);
        
        await ClientAuth.findOneAndUpdate(
            { instanceId: instanceId }, 
            { apiToken: apiToken, googleTokens: tokens }, 
            { upsert: true, new: true }
        );

        console.log(`✅ [Auth Success] הטוקנים של גוגל נשמרו עבור Instance: ${instanceId}`);
        res.send(`<h1 style="color: green; text-align: center; margin-top: 50px;">✅ סנכרון בוצע בהצלחה!</h1>`);
    } catch (error) {
        console.error('❌ [Auth Error] שגיאה ב-Callback:', error.message);
        res.status(500).send('❌ שגיאה באימות מול גוגל');
    }
});

// ==========================================
// 2. הבוט המרכזי (Webhook)
// ==========================================
app.post('/webhook', async (req, res) => {
    const body = req.body;

    // לוג כניסה ראשוני
    console.log(`--- 📥 [Webhook] אירוע חדש: ${body.typeWebhook} ---`);

    if (body.typeWebhook !== 'incomingMessageReceived') {
        return res.sendStatus(200);
    }

    const currentInstanceId = body.instanceData?.idInstance || body.idInstance; // תלוי בגרסת ה-API
    const chatId = body.senderData?.chatId;
    let text = (body.messageData?.textMessageData?.textMessage || body.messageData?.extendedTextMessageData?.text || "").trim();
    
    console.log(`📩 [הודעה] מ-${chatId} ב-Instance ${currentInstanceId}: "${text}"`);

    if (!currentInstanceId || !chatId || !text) {
        console.log("⚠️ חסרים נתונים בבקשה, מתעלם.");
        return res.sendStatus(200);
    }

    try {
        // 1. שליפת נתוני הלקוח
        const clientData = await ClientAuth.findOne({ instanceId: String(currentInstanceId) });
        if (!clientData || !clientData.googleTokens) {
            console.log(`⚠️ [Missing Data] Instance ${currentInstanceId} לא מחובר לגוגל.`);
            return res.sendStatus(200);
        }

        // 2. שליפת/יצירת מצב שיחה
        let chat = await ChatState.findOne({ instanceId: String(currentInstanceId), chatId: chatId });
        if (!chat) {
            chat = new ChatState({ instanceId: String(currentInstanceId), chatId: chatId, state: 'IDLE' });
        }
        console.log(`👤 [State] מצב שיחה נוכחי: ${chat.state}`);

        // 3. זרימת הבוט
        if (text === "שלום אשמח לצפות בסטטוס שלך" || text === "אשמח לצפות בסטטוס") {
            console.log("🤖 [Flow] מפעיל זרימת 'בקשת סטטוס'");
            await sendWAMessage(currentInstanceId, clientData.apiToken, chatId, "בשמחה! איך קוראים לך? (כדי שאוכל לשמור אותך ולתת לך גישה)");
            chat.state = 'WAITING_FOR_NAME';
        } 
        else if (chat.state === 'WAITING_FOR_NAME') {
            const contactName = text;
            const phoneNumber = "+" + chatId.replace('@c.us', ''); 
            console.log(`📝 [Google] מנסה לשמור איש קשר: ${contactName} (${phoneNumber}) לחשבון של ${currentInstanceId}`);

            try {
                const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
                oauth2Client.setCredentials(clientData.googleTokens);

                const people = google.people({ version: 'v1', auth: oauth2Client });
                await people.people.createContact({
                    requestBody: {
                        names: [{ givenName: contactName }],
                        phoneNumbers: [{ value: phoneNumber }]
                    }
                });
                console.log(`✅ [Google Success] איש קשר נשמר בגוגל.`);
                await sendWAMessage(currentInstanceId, clientData.apiToken, chatId, `נעים מאוד ${contactName}! שמרתי אותך אצלי. עכשיו תוכל לצפות בסטטוסים שלי ✨`);
                chat.state = 'COMPLETED';
            } catch (err) {
                console.error('❌ [Google Error] שגיאה ביצירת איש קשר:', err.message);
                await sendWAMessage(currentInstanceId, clientData.apiToken, chatId, "משהו השתבש בשמירת איש הקשר, אבל אל דאגה - נציג יבדוק את זה בקרוב.");
                chat.state = 'IDLE'; // מחזירים למצב התחלה בגלל שגיאה
            }
        }

        await chat.save();
        console.log(`✅ [Done] טיפול בהודעה הסתיים. סטטוס חדש: ${chat.state}`);
        res.sendStatus(200);

    } catch (error) {
        console.error('❌ [Critical Error] שגיאה ב-Webhook:', error.message);
        res.sendStatus(500);
    }
});

app.listen(PORT, () => console.log(`🚀 TPG Status Bot running on port ${PORT}`));
