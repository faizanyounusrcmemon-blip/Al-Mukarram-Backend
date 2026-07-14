const express = require("express");
const cors = require("cors");
require("dotenv").config();
require("../db"); // ✅ ROOT db.js (Vercel FIX)

const app = express();

// ==========================
// ✅ CORS FIX FOR VERCEL CREDENTIALS
// ==========================
const allowedOrigins = [
  "https://al-mukarram-software.vercel.app",
  "http://localhost:5173", // Local testing ke liye (Vite default)
  "http://localhost:3000"  // Local testing ke liye (CRA default)
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps, postman, curl)
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error("Blocked by CORS policy - Makki Madni Security"));
      }
    },
    credentials: true, // ✅ Dynamic origins ke sath ye allow karega cookes/credentials headers
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"]
  })
);

app.use(express.json());

// ==========================
// FAVICON FIX
// ==========================
app.get("/favicon.ico", (req, res) => res.status(204).end());
app.get("/favicon.png", (req, res) => res.status(204).end());

// ==========================
// ROOT
// ==========================
app.get("/", (req, res) => {
  res.json({ ok: true, message: "AL MUKARRAM Backend Live" });
});

// ==========================
// ✅ PING
// ==========================
app.get("/ping", (req, res) => {
  res.json({
    success: true,
    message: "Server alive",
    time: new Date()
  });
});

// ==========================
// ARCHIVE
// ==========================
app.use("/archive", require("../routes/archive"));
app.use("/api/archive", require("../routes/archive"));

app.use("/system-settings", require("../routes/passwordRoutes"));
app.use("/api/system-settings", require("../routes/passwordRoutes"));

// ==========================
// SALES
// ==========================
app.use("/bookings", require("../routes/bookings"));
app.use("/api/bookings", require("../routes/bookings"));

app.use("/hotels", require("../routes/hotels"));
app.use("/api/hotels", require("../routes/hotels"));

app.use("/ticketing", require("../routes/ticketing"));
app.use("/api/ticketing", require("../routes/ticketing"));

app.use("/visa", require("../routes/visa"));
app.use("/api/visa", require("../routes/visa"));

app.use("/card", require("../routes/card"));
app.use("/api/card", require("../routes/card"));

app.use("/groups", require("../routes/groups"));
app.use("/api/groups", require("../routes/groups"));

app.use("/transport", require("../routes/transport"));
app.use("/api/transport", require("../routes/transport"));

app.use("/ziyarat", require("../routes/ziyarat"));
app.use("/api/ziyarat", require("../routes/ziyarat"));

app.use("/reports", require("../routes/reports"));
app.use("/api/reports", require("../routes/reports"));

app.use("/deleted", require("../routes/deleted"));
app.use("/api/deleted", require("../routes/deleted"));

// ==========================
// LEDGERS
// ==========================
app.use("/customer-ledger", require("../routes/customerLedger"));
app.use("/api/customer-ledger", require("../routes/customerLedger"));

app.use("/purchase-ledger", require("../routes/purchaseLedger"));
app.use("/api/purchase-ledger", require("../routes/purchaseLedger"));

app.use("/bank-ledger", require("../routes/bankLedger"));
app.use("/api/bank-ledger", require("../routes/bankLedger"));

app.use("/cash-ledger", require("../routes/cashLedger"));
app.use("/api/cash-ledger", require("../routes/cashLedger"));

app.use("/ledger-delete", require("../routes/ledgerDelete"));
app.use("/api/ledger-delete", require("../routes/ledgerDelete"));

app.use("/balance-sheet", require("../routes/balanceSheet"));
app.use("/api/balance-sheet", require("../routes/balanceSheet"));

app.use("/profit-report", require("../routes/profitReport"));
app.use("/api/profit-report", require("../routes/profitReport"));

app.use("/expense-ledger", require("../routes/expenseLedger"));
app.use("/api/expense-ledger", require("../routes/expenseLedger"));

app.use("/supplier-ledger", require("../routes/supplierLedger"));
app.use("/api/supplier-ledger", require("../routes/supplierLedger"));

app.use("/monthly-profit-report", require("../routes/monthlyProfitReport"));
app.use("/api/monthly-profit-report", require("../routes/monthlyProfitReport"));

// ==========================
// PURCHASE
// ==========================
app.use("/purchase", require("../routes/purchase"));
app.use("/api/purchase", require("../routes/purchase"));

// ==========================
// SUPPLIER
// ==========================
app.use("/supplier", require("../routes/supplier"));
app.use("/api/supplier", require("../routes/supplier"));

// ==========================
// AUTH
// ==========================
app.use("/auth", require("../routes/auth"));
app.use("/api/auth", require("../routes/auth"));

app.use("/users", require("../routes/users"));
app.use("/api/users", require("../routes/users"));

// ==========================
// BACKUP
// ==========================
app.use("/backup", require("../routes/backup"));
app.use("/api/backup", require("../routes/backup"));

// ==========================
// SYSTEM
// ==========================
app.use("/system", require("../routes/system"));
app.use("/api/system", require("../routes/system"));

module.exports = app;
