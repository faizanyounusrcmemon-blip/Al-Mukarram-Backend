const express = require("express");
const router = express.Router();
const db = require("../db");

/* ================= GET ALL EXPENSES WITH BANK DETAILS ================= */
router.get("/", async (req, res) => {
  try {
    const r = await db.query(
      `
      SELECT 
        e.*,
        b.bank_name
      FROM expense_ledger e
      LEFT JOIN public.banks b ON b.id = e.bank_profile_id
      ORDER BY e.expense_date DESC, e.id DESC
      `
    );
    res.json({ success: true, rows: r.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* ================= ADD EXPENSE ================= */
router.post("/add", async (req, res) => {
  try {
    const { expense_date, title, amount, payment_method, bank_profile_id, remarks } = req.body;

    if (!expense_date || !title || !amount || !payment_method) {
      return res.json({ success: false, error: "Missing required fields" });
    }

    await db.query(
      `
      INSERT INTO expense_ledger
      (expense_date, title, amount, payment_method, bank_profile_id, remarks)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        expense_date,
        title,
        amount,
        payment_method,
        payment_method === "Bank" ? bank_profile_id : null,
        remarks || ""
      ]
    );

    res.json({ success: true, message: "Expense added" });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* ================= UPDATE EXPENSE (WITH PASSWORD CHECK) ================= */
router.put("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { expense_date, title, amount, payment_method, bank_profile_id, remarks, password } = req.body;

    if (!expense_date || !title || !amount || !payment_method) {
      return res.json({ success: false, error: "Missing required fields" });
    }

    // Password Verification (Using the same key 'delete_expense_record')
    const passCheck = await db.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1", 
      ['delete_expense_record'] 
    );
    
    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "System password not configured in database!" });
    }

    const dbPassword = passCheck.rows[0].password_val;

    if (password !== dbPassword) {
      return res.json({ success: false, error: "Wrong password" });
    }

    await db.query(
      `
      UPDATE expense_ledger
      SET expense_date = $1,
          title = $2,
          amount = $3,
          payment_method = $4,
          bank_profile_id = $5,
          remarks = $6
      WHERE id = $7
      `,
      [
        expense_date,
        title,
        amount,
        payment_method,
        payment_method === "Bank" ? bank_profile_id : null,
        remarks || "",
        id
      ]
    );

    res.json({ success: true, message: "Expense updated successfully" });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* ================= DELETE EXPENSE ================= */
router.delete("/delete/:id", async (req, res) => {
  try {
    const { password } = req.body;

    const passCheck = await db.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1", 
      ['delete_expense_record'] 
    );
    
    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "System password not configured in database!" });
    }

    const dbPassword = passCheck.rows[0].password_val;

    if (password !== dbPassword) {
      return res.json({ success: false, error: "Wrong password" });
    }

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