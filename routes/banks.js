const express = require("express");
const router = express.Router();
const pool = require("../db");

/* ======================================================
   GET ALL BANKS
====================================================== */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM banks ORDER BY id ASC"
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
      `INSERT INTO banks (bank_name, account_title, account_number, status) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
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
   EDIT BANK PROFILE (PASSWORD AUTHORIZATION)
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

    // 🔑 Password check from system_passwords table
    const passCheck = await pool.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1",
      ["manage_bank_profile"]
    );

    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "System password 'manage_bank_profile' not configured!" });
    }

    if (password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Wrong Authorization Password!" });
    }

    // Update Record
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
   DELETE BANK PROFILE (ONLY IF BALANCE IS 0)
====================================================== */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.json({ success: false, error: "Authorization password required" });
    }

    // 1. Password check from system_passwords table
    const passCheck = await pool.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1",
      ["manage_bank_profile"]
    );

    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "System password 'manage_bank_profile' not configured!" });
    }

    if (password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Wrong Authorization Password!" });
    }

    // 2. Fetch Latest Archive Snapshot Info
    const snapshotRes = await pool.query(`
      SELECT id, date_to FROM archive_snapshots ORDER BY date_to DESC, id DESC LIMIT 1
    `);

    let snapshotDateTo = "1970-01-01";
    let snapshotBal = 0;

    if (snapshotRes.rows.length > 0) {
      const snapshotId = snapshotRes.rows[0].id;
      snapshotDateTo = new Date(snapshotRes.rows[0].date_to).toISOString().split("T")[0];

      // Fetch specific Bank's snapshot baseline
      const bankBalRes = await pool.query(`
        SELECT balance FROM archive_balances 
        WHERE snapshot_id = $1 AND UPPER(balance_type) = 'BANK' AND code = $2
        LIMIT 1
      `, [snapshotId, String(id)]);

      if (bankBalRes.rows.length > 0) {
        snapshotBal = Number(bankBalRes.rows[0].balance || 0);
      }
    }

    // 3. Calculate Total Credits and Debits for this Bank
    const txnsRes = await pool.query(`
      SELECT 
        COALESCE(SUM(credit), 0) AS total_credit,
        COALESCE(SUM(debit), 0) AS total_debit
      FROM (
        /* Customer Payments (Credit) */
        SELECT ROUND(amount::numeric, 0) AS credit, 0 AS debit
        FROM customer_payments
        WHERE LOWER(COALESCE(type, '')) NOT IN ('adjustment', 'opening_balance')
          AND LOWER(COALESCE(payment_method, '')) = 'bank'
          AND payment_date::date > $1::date
          AND bank_profile_id = $2

        UNION ALL

        /* Supplier Payments (Debit) */
        SELECT 0 AS credit, ROUND(amount::numeric, 0) AS debit
        FROM supplier_payments
        WHERE LOWER(COALESCE(type, '')) NOT IN ('adjustment', 'opening_balance')
          AND LOWER(COALESCE(payment_method, '')) = 'bank'
          AND payment_date::date > $1::date
          AND bank_profile_id = $2

        UNION ALL

        /* Expenses (Debit) */
        SELECT 0 AS credit, ROUND(amount::numeric, 0) AS debit
        FROM expense_ledger
        WHERE LOWER(COALESCE(payment_method, '')) = 'bank'
          AND expense_date::date > $1::date
          AND bank_profile_id = $2

        UNION ALL

        /* Manual Transactions */
        SELECT 
          CASE WHEN type = 'deposit' THEN ROUND(amount::numeric, 0) ELSE 0 END AS credit,
          CASE WHEN type = 'withdraw' THEN ROUND(amount::numeric, 0) ELSE 0 END AS debit
        FROM bank_transactions
        WHERE txn_date::date > $1::date
          AND bank_profile_id = $2
      ) bank_txns
    `, [snapshotDateTo, id]);

    const totalCredit = Number(txnsRes.rows[0].total_credit || 0);
    const totalDebit = Number(txnsRes.rows[0].total_debit || 0);

    // Current Running Balance
    const currentBalance = snapshotBal + totalCredit - totalDebit;

    // 4. Strict Balance Check (Must be 0)
    if (Math.abs(currentBalance) > 0.01) {
      if (currentBalance > 0) {
        return res.json({
          success: false,
          error: `Bank profile cannot be deleted! Account has a positive remaining balance: PKR ${currentBalance.toLocaleString("en-US")}`
        });
      } else {
        return res.json({
          success: false,
          error: `Bank profile cannot be deleted! Account is overdrawn / negative balance: PKR ${Math.abs(currentBalance).toLocaleString("en-US")}`
        });
      }
    }

    // 5. Delete Bank Profile (Only if balance is 0)
    await pool.query("DELETE FROM banks WHERE id = $1", [id]);

    res.json({ success: true, message: "Bank profile deleted successfully" });
  } catch (err) {
    console.error("DELETE BANK ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;