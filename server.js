require("dotenv").config();
const express = require("express");
const path = require("path");
const admsRoutes = require("./src/routes/adms");
const apiRoutes = require("./src/routes/api");

const app = express();

// JSON body parsing for our own API routes (the ADMS routes parse their own
// text/plain bodies separately, since the device doesn't send JSON).
app.use("/api", express.json());

// The F09 talks to these — no auth, since the device protocol doesn't support it.
// Lock this down at the network level instead (see README: firewall to device IP only).
app.use(admsRoutes);

// Your own app / n8n talks to these — protected by X-API-Key header.
app.use("/api", apiRoutes);

// Rate-management UI. The page itself holds no data — it asks the operator for
// the API key and calls the same /api routes the key already protects, so
// serving the HTML unauthenticated exposes nothing.
app.get("/admin", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html"))
);

app.get("/", (req, res) => res.send("Restaurant attendance backend is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  // The device sends wall-clock local time with no timezone. Punch times and
  // the day boundaries in calc.js are both interpreted in the server's local
  // zone, so the two must agree with the device's clock or shifts will land on
  // the wrong date. A fresh VPS defaults to UTC — set TZ=Asia/Kolkata.
  console.log(
    `Server timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone} ` +
      `(must match the F09's clock — set TZ=Asia/Kolkata if this says UTC)`
  );
});
