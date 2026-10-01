const express = require("express");
const router = express.Router();
const pool = require("../db");

/* ======================================================
   GET ALL BANKS (Excluding Soft Deleted)
====================================================== */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM banks WHERE COALESCE(is_deleted, false) = false ORDER BY id ASC"
    );
    res.json({ success: true, rows: result.rows });
  } catch (err) {
    console.error("GET BANKS ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

/* ======================================================
   ADD NEW BANK
====================================================== */
router.post("/", async (req, res) => {
  try {
    const { bank_name, account_title, account_number, status } = req.body;

    if (!bank_name || !account_title || !account_number) {
      return res.json({ success: false, error: "Missing required fields" });
    }

    const result = await pool.query(
      `INSERT INTO banks (bank_name, account_title, account_number, status, is_deleted) 
       VALUES ($1, $2, $3, $4, false) RETURNING *`,
      [bank_name.trim(), account_title.trim(), account_number.trim(), status || "Active"]
    );

    res.json({
      success: true,
      message: "Bank profile created successfully",
      bank: result.rows[0],
    });
  } catch (err) {
    console.error("ADD BANK ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

/* ======================================================
   VERIFY PASSWORD FOR BANK EDIT
====================================================== */
router.post("/verify-password", async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.json({ success: false, error: "Password required" });
    }

    const passCheck = await pool.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1",
      ["manage_bank_profile"]
    );

    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "System password not configured" });
    }

    if (password === passCheck.rows[0].password_val) {
      return res.json({ success: true });
    } else {
      return res.json({ success: false, error: "Wrong Password" });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* ======================================================
   EDIT BANK PROFILE
====================================================== */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { bank_name, account_title, account_number, status, password } = req.body;

    if (!bank_name || !account_title || !account_number) {
      return res.json({ success: false, error: "Missing required fields" });
    }

    if (!password) {
      return res.json({ success: false, error: "Authorization password required" });
    }

    const passCheck = await pool.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1",
      ["manage_bank_profile"]
    );

    if (passCheck.rows.length === 0 || password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Wrong Authorization Password!" });
    }

    await pool.query(
      `UPDATE banks 
       SET bank_name = $1, account_title = $2, account_number = $3, status = $4 
       WHERE id = $5`,
      [bank_name.trim(), account_title.trim(), account_number.trim(), status || "Active", id]
    );

    res.json({ success: true, message: "Bank profile updated successfully" });
  } catch (err) {
    console.error("EDIT BANK ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

/* ======================================================
   SOFT DELETE BANK PROFILE (SET is_deleted = true)
====================================================== */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.json({ success: false, error: "Authorization password required" });
    }

    // 1. Password Verification
    const passCheck = await pool.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1",
      ["manage_bank_profile"]
    );

    if (passCheck.rows.length === 0 || password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Wrong Authorization Password!" });
    }

    // 2. Snapshot & Ledger Balance Checks
    const snapshotRes = await pool.query(`
      SELECT id, date_to FROM archive_snapshots ORDER BY date_to DESC, id DESC LIMIT 1
    `);

    let snapshotDateTo = "1970-01-01";
    let snapshotBal = 0;

    if (snapshotRes.rows.length > 0) {
      const snapshotId = snapshotRes.rows[0].id;
      snapshotDateTo = new Date(snapshotRes.rows[0].date_to).toISOString().split("T")[0];

      const bankBalRes = await pool.query(`
        SELECT balance FROM archive_balances 
        WHERE snapshot_id = $1 AND UPPER(balance_type) = 'BANK' AND code = $2
        LIMIT 1
      `, [snapshotId, String(id)]);

      if (bankBalRes.rows.length > 0) {
        snapshotBal = Number(bankBalRes.rows[0].balance || 0);
      }
    }

    const txnsRes = await pool.query(`
      SELECT 
        COALESCE(SUM(credit), 0) AS total_credit,
        COALESCE(SUM(debit), 0) AS total_debit
      FROM (
        SELECT ROUND(amount::numeric, 0) AS credit, 0 AS debit
        FROM customer_payments
        WHERE LOWER(COALESCE(type, '')) NOT IN ('adjustment', 'opening_balance')
          AND LOWER(COALESCE(payment_method, '')) = 'bank'
          AND payment_date::date > $1::date AND bank_profile_id = $2
        UNION ALL
        SELECT 0 AS credit, ROUND(amount::numeric, 0) AS debit
        FROM supplier_payments
        WHERE LOWER(COALESCE(type, '')) NOT IN ('adjustment', 'opening_balance')
          AND LOWER(COALESCE(payment_method, '')) = 'bank'
          AND payment_date::date > $1::date AND bank_profile_id = $2
        UNION ALL
        SELECT 0 AS credit, ROUND(amount::numeric, 0) AS debit
        FROM expense_ledger
        WHERE LOWER(COALESCE(payment_method, '')) = 'bank'
          AND expense_date::date > $1::date AND bank_profile_id = $2
        UNION ALL
        SELECT 
          CASE WHEN type = 'deposit' THEN ROUND(amount::numeric, 0) ELSE 0 END AS credit,
          CASE WHEN type = 'withdraw' THEN ROUND(amount::numeric, 0) ELSE 0 END AS debit
        FROM bank_transactions
        WHERE txn_date::date > $1::date AND bank_profile_id = $2
      ) bank_txns
    `, [snapshotDateTo, id]);

    const currentBalance = snapshotBal + Number(txnsRes.rows[0].total_credit || 0) - Number(txnsRes.rows[0].total_debit || 0);

    if (Math.abs(currentBalance) > 0.01) {
      return res.json({
        success: false,
        error: `Bank profile cannot be deleted! Remaining balance: PKR ${currentBalance.toLocaleString("en-US")}`
      });
    }

    // 3. Mark is_deleted = true (Soft Delete)
    await pool.query("UPDATE banks SET is_deleted = true WHERE id = $1", [id]);

    res.json({ success: true, message: "Bank profile soft-deleted successfully" });
  } catch (err) {
    console.error("DELETE BANK ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;