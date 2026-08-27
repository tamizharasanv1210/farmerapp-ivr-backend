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

const STATE_ABBR = { "Tamil Nadu": "TN" };

// Turn "09:00-17:00" + slotsPerHour=4 into ["09:00 - 09:15", "09:15 - 09:30", ...]
function generateAllSlots(operatingHours, slotsPerHour) {
  const [start, end] = operatingHours.split("-").map((s) => s.trim());
  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);
  const intervalMin = 60 / slotsPerHour;
  const fmt = (totalMin) => {
    const h = Math.floor(totalMin / 60).toString().padStart(2, "0");
    const m = (totalMin % 60).toString().padStart(2, "0");
    return `${h}:${m}`;
  };
  const slots = [];
  let cur = startH * 60 + startM;
  const endTotal = endH * 60 + endM;
  while (cur + intervalMin <= endTotal) {
    slots.push(`${fmt(cur)} - ${fmt(cur + intervalMin)}`);
    cur += intervalMin;
  }
  return slots;
}

// Bucket a "HH:MM - HH:MM" slot into morning/afternoon/evening for a simple 3-option DTMF menu
function bucketOf(slotStr) {
  const hour = parseInt(slotStr.split(":")[0], 10);
  if (hour < 12) return "Morning";
  if (hour < 15) return "Afternoon";
  return "Evening";
}

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
  try {
    const taUrl = googleTTS.getAudioUrl("தமிழுக்கு ஒன்று அழுத்தவும்.", {
      lang: "ta",
      slow: false,
      host: "https://translate.google.com",
    });
    const enUrl = googleTTS.getAudioUrl("For English, press two.", {
      lang: "en",
      slow: false,
      host: "https://translate.google.com",
    });
    const [taRes, enRes] = await Promise.all([fetch(taUrl), fetch(enUrl)]);
    const taBuf = Buffer.from(await taRes.arrayBuffer());
    const enBuf = Buffer.from(await enRes.arrayBuffer());
    const combined = Buffer.concat([taBuf, enBuf]);
    res.set("Content-Type", "audio/mpeg");
    res.send(combined);
  } catch (err) {
    console.error("Error in /prompt/language:", err);
    await speakText(res, TEXTS.ta.language, "ta"); // fallback
  }
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
  const slots = session.availableSlotObjs || [];
  const prompt = slots.map((s) => `${s.id}: ${s.bucket}`).join(", ");
  await speakText(res, prompt || TEXTS[session.lang].noSlots, session.lang);
});

app.all("/prompt/confirm", async (req, res) => {
  const { callSid, callerNumber } = readParams(req);
  const { session } = await getSession(callSid, callerNumber);
  const text = session.tokenNumber
    ? `${TEXTS[session.lang].bookedPrefix} ${session.tokenNumber}`
    : TEXTS[session.lang].invalid;
  await speakText(res, text, session.lang);
});

// -----------------------------------------------------------------
// TEXT prompt routes — for Gather's "URL that returns plain text"
// option (Exotel reads it with its own TTS, so language is dynamic)
// -----------------------------------------------------------------
app.all("/prompt-text/role", async (req, res) => {
  const { callSid, callerNumber } = readParams(req);
  const { session } = await getSession(callSid, callerNumber);
  res.type("text/plain").send(TEXTS[session.lang || "ta"].role);
});

app.all("/prompt-text/crop", async (req, res) => {
  const { callSid, callerNumber } = readParams(req);
  const { session } = await getSession(callSid, callerNumber);
  const crops = session.cropOptions || [];
  const prompt = crops.map((c, i) => `${i + 1}: ${c}`).join(", ");
  res.type("text/plain").send(prompt || TEXTS[session.lang || "ta"].invalid);
});

app.all("/prompt-text/date", async (req, res) => {
  const { callSid, callerNumber } = readParams(req);
  const { session } = await getSession(callSid, callerNumber);
  res.type("text/plain").send(TEXTS[session.lang || "ta"].date);
});

app.all("/prompt-text/slot", async (req, res) => {
  const { callSid, callerNumber } = readParams(req);
  const { session } = await getSession(callSid, callerNumber);
  const slots = session.availableSlotObjs || [];
  const prompt = slots.map((s) => `${s.id}: ${s.bucket}`).join(", ");
  res.type("text/plain").send(prompt || TEXTS[session.lang || "ta"].noSlots);
});

app.all("/prompt-text/confirm", async (req, res) => {
  const { callSid, callerNumber } = readParams(req);
  const { session } = await getSession(callSid, callerNumber);
  const text = session.tokenNumber
    ? `${TEXTS[session.lang || "ta"].bookedPrefix} ${session.tokenNumber}`
    : TEXTS[session.lang || "ta"].invalid;
  res.type("text/plain").send(text);
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

  // Normalize: strip leading 0 / +91, keep last 10 digits
  const normalizedPhone = callerNumber.replace(/\D/g, "").slice(-10);

  const farmerSnap = await db
    .collection("farmers")
    .where("phone", "==", normalizedPhone)
    .limit(1)
    .get();

  if (farmerSnap.empty) {
    await ref.set({ step: "notRegistered", role }, { merge: true });
    return res.status(200).json({ status: "failure" }); // route Studio to a "not registered" Hangup path
  }
  const farmerDoc = farmerSnap.docs[0];
  const farmerData = farmerDoc.data();

  // Find the procurement centre for this farmer's district (case-insensitive,
  // since farmers.district can be stored differently-cased than centres.district)
  const allCentresSnap = await db.collection("centres").get();
  const centreDoc = allCentresSnap.docs.find(
    (d) => (d.data().district || "").toLowerCase() === (farmerData.district || "").toLowerCase()
  );

  if (!centreDoc) {
    await ref.set({ step: "notRegistered", role }, { merge: true });
    return res.status(200).json({ status: "failure" });
  }
  const centreData = centreDoc.data();

  await ref.set(
    {
      step: "crop",
      role,
      state: farmerData.state,
      district: farmerData.district,
      farmerId: farmerDoc.id,
      farmerName: farmerData.name,
      farmerPhone: farmerData.phone,
      centreId: centreDoc.id,
      centreName: centreData.centreName,
      cropOptions: centreData.cropsAccepted || [],
      counters: centreData.counters || [],
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

  const counter = (session.counters || []).find((c) => c.crop === crop);
  if (!counter) return res.status(200).json({ status: "failure" });

  await ref.set(
    {
      step: "date",
      crop,
      counterId: counter.counterId,
      operatingHours: counter.operatingHours,
      slotsPerHour: counter.slotsPerHour,
    },
    { merge: true }
  );
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

  const allSlots = generateAllSlots(session.operatingHours, session.slotsPerHour);

  const bookedSnap = await db
    .collection("bookings")
    .where("centreId", "==", session.centreId)
    .where("counterId", "==", session.counterId)
    .where("date", "==", date)
    .get();
  const bookedTimes = new Set(bookedSnap.docs.map((d) => d.data().timeSlot));

  // Pick the first free slot in each of the 3 buckets (Morning/Afternoon/Evening)
  const byBucket = {};
  for (const slot of allSlots) {
    if (bookedTimes.has(slot)) continue;
    const b = bucketOf(slot);
    if (!byBucket[b]) byBucket[b] = slot;
  }

  const bucketOrder = ["Morning", "Afternoon", "Evening"];
  const availableSlotObjs = bucketOrder
    .filter((b) => byBucket[b])
    .map((b, i) => ({ id: i + 1, bucket: b, time: byBucket[b] }));

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
  const chosen = (session.availableSlotObjs || []).find((s) => s.id === slotId);
  if (!chosen) return res.status(200).json({ status: "failure" });

  // Build a token like "TN-PAD-004"
  const stateAbbr = STATE_ABBR[session.state] || "XX";
  const cropAbbr = session.crop.slice(0, 3).toUpperCase();
  const seqRef = db.collection("meta").doc(`tokenSeq_${stateAbbr}_${cropAbbr}`);
  const seqNum = await db.runTransaction(async (t) => {
    const doc = await t.get(seqRef);
    const current = doc.exists ? doc.data().value : 0;
    const next = current + 1;
    t.set(seqRef, { value: next });
    return next;
  });
  const tokenNumber = `${stateAbbr}-${cropAbbr}-${String(seqNum).padStart(3, "0")}`;

  const bookingId = `bkg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await db
    .collection("bookings")
    .doc(bookingId)
    .set({
      id: bookingId,
      centreId: session.centreId,
      centreName: session.centreName,
      counterId: session.counterId,
      crop: session.crop,
      date: session.date,
      farmerId: session.farmerId,
      farmerName: session.farmerName,
      farmerPhone: session.farmerPhone,
      status: "booked",
      timeSlot: chosen.time,
      tokenNumber,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

  await ref.set({ step: "confirm", tokenNumber }, { merge: true });

  const smsText = TEXTS[session.lang].smsBody(session.crop, session.date, chosen.time, tokenNumber);
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
