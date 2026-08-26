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

app.get("/", (req, res) => {
  res.send("FarmerApp IVR backend is running");
});

app.all("/speak-token", async (req, res) => {
  try {
    const callerNumber =
      req.query.From || req.body.From ||
      req.query.CallFrom || req.body.CallFrom || "unknown";

    let textToSpeak = "Sorry, we could not find your booking. Please try again.";

    const snapshot = await db
      .collection("bookings")
      .where("phone", "==", callerNumber)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (!snapshot.empty) {
      const data = snapshot.docs[0].data();
      textToSpeak = `Your token number is ${data.token}. Thank you.`;
    }

    const ttsUrl = googleTTS.getAudioUrl(textToSpeak, {
      lang: "en",
      slow: false,
      host: "https://translate.google.com",
    });

    const audioRes = await fetch(ttsUrl);
    const arrayBuffer = await audioRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.set("Content-Type", "audio/mpeg");
    res.send(buffer);
  } catch (err) {
    console.error("Error in speak-token:", err);
    res.status(500).send("Error generating audio");
  }
});

app.all("/handleIVR", async (req, res) => {
  try {
    let digits =
      req.query.digits || req.body.digits ||
      req.query.Digits || req.body.Digits;
    if (typeof digits === "string") {
      digits = digits.replace(/^"+|"+$/g, "");
    }
    const callerNumber =
      req.query.From || req.body.From ||
      req.query.CallFrom || req.body.CallFrom || "unknown";

    console.log("Call from:", callerNumber, "Digits pressed:", digits);

    if (digits === "1") {
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
        token: tokenNumber,
        type: "new_booking",
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log("Booking created for", callerNumber, "Token:", tokenNumber);

      res.status(200).send("OK");
    } else if (digits === "2") {
      const snapshot = await db
        .collection("bookings")
        .where("phone", "==", callerNumber)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

      if (!snapshot.empty) {
        console.log("Status found:", snapshot.docs[0].data());
      }

      res.status(200).send("OK");
    } else {
      res.status(200).send("OK");
    }
  } catch (err) {
    console.error("Error in handleIVR:", err);
    res.status(500).send("Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
