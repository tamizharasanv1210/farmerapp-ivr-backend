const express = require("express");
const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- Exotel SMS credentials (set these in Render Environment tab) ---
const EXOTEL_SID = process.env.EXOTEL_SID;
const EXOTEL_API_KEY = process.env.EXOTEL_API_KEY;
const EXOTEL_API_TOKEN = process.env.EXOTEL_API_TOKEN;
const EXOTEL_SENDER = process.env.EXOTEL_SENDER; // your ExoPhone / Sender ID
const EXOTEL_SUBDOMAIN = process.env.EXOTEL_SUBDOMAIN || "@api.exotel.com";

async function sendExotelSMS(toNumber, body) {
  if (!EXOTEL_SID || !EXOTEL_API_KEY || !EXOTEL_API_TOKEN) {
    console.log("Exotel SMS credentials not set, skipping SMS send");
    return;
  }
  const url = `https://${EXOTEL_API_KEY}:${EXOTEL_API_TOKEN}${EXOTEL_SUBDOMAIN}/v1/Accounts/${EXOTEL_SID}/Sms/send`;

  const params = new URLSearchParams();
  params.append("From", EXOTEL_SENDER);
  params.append("To", toNumber);
  params.append("Body", body);
  // NOTE: If your account requires DLT (mandatory for India), also add:
  // params.append("DltEntityId", "your_entity_id");
  // params.append("DltTemplateId", "your_template_id");

  try {
    const res = await fetch(url, { method: "POST", body: params });
    const text = await res.text();
    console.log("SMS send response:", res.status, text);
  } catch (err) {
    console.error("SMS send failed:", err);
  }
}

app.get("/", (req, res) => {
  res.send("FarmerApp IVR backend is running");
});

app.all("/handleIVR", async (req, res) => {
  try {
    let digits =
      req.query.digits || req.body.digits ||
      req.query.Digits || req.body.Digits;
    // Exotel sometimes sends this JSON-quoted (e.g. "1" instead of 1) — strip quotes
    if (typeof digits === "string") {
      digits = digits.replace(/^"+|"+$/g, "");
    }
    const callerNumber =
      req.query.From || req.body.From ||
      req.query.CallFrom || req.body.CallFrom || "unknown";

    console.log("Call from:", callerNumber, "Digits pressed:", digits);

    if (digits === "1") {
      // Generate next token number using a counter document (atomic transaction)
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

      // Send SMS confirmation with the token number
      await sendExotelSMS(
        callerNumber,
        `Your booking is confirmed. Your token number is ${tokenNumber}.`
      );

      res.status(200).send("OK");
    } else if (digits === "2") {
      const snapshot = await db
        .collection("bookings")
        .where("phone", "==", callerNumber)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const data = snapshot.docs[0].data();
        console.log("Status found:", data);
        await sendExotelSMS(
          callerNumber,
          `Your latest token number is ${data.token}, status: ${data.status}.`
        );
      } else {
        await sendExotelSMS(callerNumber, "No booking found for your number.");
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
