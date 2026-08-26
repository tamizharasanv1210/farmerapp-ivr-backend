const express = require("express");
const admin = require("firebase-admin");
const googleTTS = require("google-tts-api");

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const EXOTEL_SID = process.env.EXOTEL_SID;
const EXOTEL_API_KEY = process.env.EXOTEL_API_KEY;
const EXOTEL_API_TOKEN = process.env.EXOTEL_API_TOKEN;
const EXOTEL_SENDER = process.env.EXOTEL_SENDER;
const EXOTEL_SUBDOMAIN = process.env.EXOTEL_SUBDOMAIN || "@api.exotel.com";

async function sendExotelSMS(toNumber, body) {
  if (!EXOTEL_SID || !EXOTEL_API_KEY || !EXOTEL_API_TOKEN) {
    console.log("Exotel SMS credentials not set, skipping SMS send");
    return;
  }
  const url = `https://${EXOTEL_SUBDOMAIN.replace(/^@/, "")}/v1/Accounts/${EXOTEL_SID}/Sms/send`;
  const authHeader =
    "Basic " + Buffer.from(`${EXOTEL_API_KEY}:${EXOTEL_API_TOKEN}`).toString("base64");
  const params = new URLSearchParams();
  params.append("From", EXOTEL_SENDER);
  params.append("To", toNumber);
  params.append("Body", body);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    const text = await res.text();
    console.log("SMS send response:", res.status, text);
  } catch (err) {
    console.error("SMS send failed:", err);
  }
}

// -----------------------------------------------------------------
// Helper: read digits/From/CallSid the same way regardless of GET/POST
// -----------------------------------------------------------------
function readParams(req) {
  let digits = req.query.digits || req.body.digits || req.query.Digits || req.body.Digits;
  if (typeof digits === "string") digits = digits.replace(/^"+|"+$/g, "");
  const callSid = req.query.CallSid || req.body.CallSid;
  const callerNumber =
    req.query.From || req.body.From || req.query.CallFrom || req.body.CallFrom || "unknown";
  return { digits, callSid, callerNumber };
}

// -----------------------------------------------------------------
// TEXTS + static data — same idea as before, extend languages/crops here
// -----------------------------------------------------------------
const TEXTS = {
  ta: {
    language: "தமிழுக்கு 1 அழுத்தவும், ஆங்கிலத்திற்கு 2 அழுத்தவும்.",
    role: "நீங்கள் விவசாயி என்றால் 1 அழுத்தவும், அதிகாரி என்றால் 2 அழுத்தவும்.",
    notRegistered: "நீங்கள் இன்னும் பதிவு செய்யவில்லை. அருகிலுள்ள நெட் சென்டரில் பதிவு செய்யவும்.",
    date: "நாளைக்கு 1, நாளை மறுநாளுக்கு 2 அழுத்தவும்.",
    noSlots: "இந்த தேதிக்கு இடங்கள் இல்லை. மீண்டும் அழைக்கவும்.",
    invalid: "தவறான உள்ளீடு. மீண்டும் முயற்சிக்கவும்.",
    bookedPrefix: "உங்கள் டோக்கன் எண்",
    smsBody: (crop, date, slot, token) =>
      `உங்கள் டோக்கன் எண் ${token}. பயிர்: ${crop}, தேதி: ${date}, நேரம்: ${slot}.`,
  },
  en: {
    language: "Press 1 for Tamil, Press 2 for English.",
    role: "Press 1 if you are a farmer, Press 2 if you are a procurement officer.",
    notRegistered: "You are not registered yet. Please register at your nearest net center.",
    date: "Press 1 for tomorrow, Press 2 for day after tomorrow.",
    noSlots: "No slots available for this date. Please call again.",
    invalid: "Invalid input. Please try again.",
    bookedPrefix: "Your token number is",
    smsBody: (crop, date, slot, token) =>
      `Your token number is ${token}. Crop: ${crop}, Date: ${date}, Slot: ${slot}.`,
  },
};

const CROPS_BY_STATE = {
  "Tamil Nadu": ["Paddy", "Sugarcane", "Groundnut", "Cotton"],
};

const SLOTS = [
  { id: 1, label: "Morning (8AM-11AM)" },
  { id: 2, label: "Afternoon (11AM-2PM)" },
  { id: 3, label: "Evening (2PM-5PM)" },
];

// -----------------------------------------------------------------
// Audio helper — same pattern as your working /speak-token
// -----------------------------------------------------------------
async function speakText(res, text, lang = "en") {
  const ttsUrl = googleTTS.getAudioUrl(text, {
    lang: lang === "ta" ? "ta" : "en",
    slow: false,
    host: "https://translate.google.com",
  });
  const audioRes = await fetch(ttsUrl);
  const buffer = Buffer.from(await audioRes.arrayBuffer());
  res.set("Content-Type", "audio/mpeg");
  res.send(buffer);
}

async function getSession(callSid, callerNumber) {
  const ref = db.collection("callSessions").doc(callSid);
  const snap = await ref.get();
  const session = snap.exists ? snap.data() : { step: "language", lang: "ta", callerNumber };
  return { ref, session };
}

// -----------------------------------------------------------------
// PROMPT routes — point each Menu/Greeting applet's "URL" field here
// e.g. https://yourapp.onrender.com/prompt/language
// -----------------------------------------------------------------
app.all("/prompt/language", async (req, res) => {
  await speakText(res, TEXTS.ta.language, "ta"); // ask in Tamil first, caller picks
});

app.all("/prompt/role", async (req, res) => {
  const { callSid, callerNumber } = readParams(req);
  const { session } = await getSession(callSid, callerNumber);
  await speakText(res, TEXTS[session.lang].role, session.lang);
});

app.all("/prompt/crop", async (req, res) => {
  const { callSid, callerNumber } = readParams(req);
  const { session } = await getSession(callSid, callerNumber);
  const crops = session.cropOptions || [];
  const prompt = crops.map((c, i) => `${i + 1}: ${c}`).join(", ");
  await speakText(res, prompt || TEXTS[session.lang].invalid, session.lang);
});

app.all("/prompt/date", async (req, res) => {
  const { callSid, callerNumber } = readParams(req);
  const { session } = await getSession(callSid, callerNumber);
  await speakText(res, TEXTS[session.lang].date, session.lang);
});

app.all("/prompt/slot", async (req, res) => {
  const { callSid, callerNumber } = readParams(req);
  const { session } = await getSession(callSid, callerNumber);
  const slots = (session.availableSlotObjs || []);
  const prompt = slots.map((s) => `${s.id}: ${s.label}`).join(", ");
  await speakText(res, prompt || TEXTS[session.lang].noSlots, session.lang);
});

app.all("/prompt/confirm", async (req, res) => {
  const { callSid, callerNumber } = readParams(req);
  const { session } = await getSession(callSid, callerNumber);
  const text = session.token
    ? `${TEXTS[session.lang].bookedPrefix} ${session.token}`
    : TEXTS[session.lang].invalid;
  await speakText(res, text, session.lang);
});

// -----------------------------------------------------------------
// SAVE routes — point each Passthru applet's URL here, one per step
// e.g. https://yourapp.onrender.com/save/language
// -----------------------------------------------------------------
app.all("/save/language", async (req, res) => {
  const { digits, callSid, callerNumber } = readParams(req);
  const { ref } = await getSession(callSid, callerNumber);
  const lang = digits === "2" ? "en" : "ta";
  await ref.set({ step: "role", lang, callerNumber }, { merge: true });
  res.status(200).json({ status: "success" });
});

app.all("/save/role", async (req, res) => {
  const { digits, callSid, callerNumber } = readParams(req);
  const { ref, session } = await getSession(callSid, callerNumber);
  const role = digits === "1" ? "farmer" : "officer";

  const farmerDoc = await db.collection("farmers").doc(callerNumber).get();
  if (!farmerDoc.exists) {
    await ref.set({ step: "notRegistered", role }, { merge: true });
    return res.status(200).json({ status: "failure" }); // route Studio to a "not registered" Hangup path
  }
  const farmerData = farmerDoc.data();
  const crops = CROPS_BY_STATE[farmerData.state] || [];

  await ref.set(
    {
      step: "crop",
      role,
      state: farmerData.state,
      district: farmerData.district,
      cropOptions: crops,
    },
    { merge: true }
  );
  res.status(200).json({ status: "success" });
});

app.all("/save/crop", async (req, res) => {
  const { digits, callSid, callerNumber } = readParams(req);
  const { ref, session } = await getSession(callSid, callerNumber);
  const idx = parseInt(digits, 10) - 1;
  const crop = (session.cropOptions || [])[idx];
  if (!crop) return res.status(200).json({ status: "failure" });
  await ref.set({ step: "date", crop }, { merge: true });
  res.status(200).json({ status: "success" });
});

app.all("/save/date", async (req, res) => {
  const { digits, callSid, callerNumber } = readParams(req);
  const { ref, session } = await getSession(callSid, callerNumber);
  if (digits !== "1" && digits !== "2") return res.status(200).json({ status: "failure" });

  const daysAhead = digits === "1" ? 1 : 2;
  const dateObj = new Date();
  dateObj.setDate(dateObj.getDate() + daysAhead);
  const date = dateObj.toISOString().split("T")[0];

  const availableSlotObjs = [];
  for (const slot of SLOTS) {
    const snap = await db
      .collection("bookings")
      .where("district", "==", session.district)
      .where("date", "==", date)
      .where("slotId", "==", slot.id)
      .get();
    if (snap.size < 15) availableSlotObjs.push(slot);
  }

  if (availableSlotObjs.length === 0) {
    await ref.set({ step: "noSlots", date }, { merge: true });
    return res.status(200).json({ status: "failure" });
  }

  await ref.set({ step: "slot", date, availableSlotObjs }, { merge: true });
  res.status(200).json({ status: "success" });
});

app.all("/save/slot", async (req, res) => {
  const { digits, callSid, callerNumber } = readParams(req);
  const { ref, session } = await getSession(callSid, callerNumber);
  const slotId = parseInt(digits, 10);
  const slot = (session.availableSlotObjs || []).find((s) => s.id === slotId);
  if (!slot) return res.status(200).json({ status: "failure" });

  const counterRef = db.collection("meta").doc("tokenCounter");
  const tokenNumber = await db.runTransaction(async (t) => {
    const doc = await t.get(counterRef);
    const current = doc.exists ? doc.data().value : 0;
    const next = current + 1;
    t.set(counterRef, { value: next });
    return next;
  });

  await db.collection("bookings").add({
    phone: callerNumber,
    state: session.state,
    district: session.district,
    crop: session.crop,
    date: session.date,
    slotId: slot.id,
    slotLabel: slot.label,
    token: tokenNumber,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await ref.set({ step: "confirm", token: tokenNumber }, { merge: true });

  const smsText = TEXTS[session.lang].smsBody(session.crop, session.date, slot.label, tokenNumber);
  await sendExotelSMS(callerNumber, smsText);

  res.status(200).json({ status: "success" });
});

// -----------------------------------------------------------------
// Keep your existing routes as-is (status check by digit "2" style
// flows, health check, etc.)
// -----------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("FarmerApp IVR backend is running");
});

app.all("/speak-token", async (req, res) => {
  try {
    const { callerNumber } = readParams(req);
    const snapshot = await db
      .collection("bookings")
      .where("phone", "==", callerNumber)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    let textToSpeak = "Sorry, we could not find your booking. Please try again.";
    if (!snapshot.empty) {
      textToSpeak = `Your token number is ${snapshot.docs[0].data().token}. Thank you.`;
    }
    await speakText(res, textToSpeak, "en");
  } catch (err) {
    console.error("Error in speak-token:", err);
    res.status(500).send("Error generating audio");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
