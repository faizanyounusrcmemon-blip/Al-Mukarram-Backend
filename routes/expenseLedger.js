const express = require("express");
const router = express.Router();
const db = require("../db");

/* ================= GET ALL EXPENSES ================= */
router.get("/", async (req, res) => {
  try {
    const r = await db.query(
      "SELECT * FROM expense_ledger ORDER BY expense_date DESC, id DESC"
    );
    res.json({ success: true, rows: r.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* ================= ADD EXPENSE ================= */
router.post("/add", async (req, res) => {
  try {
    const { expense_date, title, amount, payment_method, remarks } = req.body;

    if (!expense_date || !title || !amount || !payment_method)
      return res.json({ success: false, error: "Missing fields" });

    // ✅ ONLY save expense (NO bank transaction)
    await db.query(
      `
      INSERT INTO expense_ledger
      (expense_date, title, amount, payment_method, remarks)
      VALUES ($1,$2,$3,$4,$5)
      `,
      [expense_date, title, amount, payment_method, remarks || ""]
    );

    res.json({ success: true, message: "Expense added" });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* =========================================================
   DELETE EXPENSE (DYNAMIC DATABASE PASSWORD LOOKUP)
========================================================= */
router.delete("/delete/:id", async (req, res) => {
  try {
    const { password } = req.body;

    // 🔑 Key name ko 'delete_expense_record' kar diya gaya hai
    const passCheck = await db.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1", 
      ['delete_expense_record'] 
    );
    
    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "System password not configured in database!" });
    }

    const dbPassword = passCheck.rows[0].password_val;

    if (password !== dbPassword)
      return res.json({ success: false, error: "Wrong password" });

    await db.query(
      "DELETE FROM expense_ledger WHERE id=$1",
      [req.params.id]
    );

    res.json({ success: true, message: "Expense deleted" });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
