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

app.get("/", (req, res) => {
  res.send("FarmerApp IVR backend is running");
});

app.all("/handleIVR", async (req, res) => {
  try {
    const digits =
      req.query.digits || req.body.digits ||
      req.query.Digits || req.body.Digits;
    const callerNumber =
      req.query.From || req.body.From ||
      req.query.CallFrom || req.body.CallFrom || "unknown";

    console.log("Call from:", callerNumber, "Digits pressed:", digits);

    if (digits === "1") {
      await db.collection("bookings").add({
        phone: callerNumber,
        type: "new_booking",
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log("Booking created for", callerNumber);
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
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Error in handleIVR:", err);
    res.status(500).send("Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
