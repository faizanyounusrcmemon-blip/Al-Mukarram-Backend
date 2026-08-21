const express = require("express");
const router = express.Router();
const pool = require("../db");

/* ======================================================
   GET ALL BANK PROFILES (From public.banks Table)
====================================================== */
router.get("/profiles", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, bank_name, account_title, account_number FROM public.banks WHERE LOWER(status) = 'active' ORDER BY id ASC"
    );
    res.json({ success: true, profiles: result.rows });
  } catch (err) {
    console.error("Bank Profiles Fetch Error:", err);
    res.json({ success: false, error: err.message, profiles: [] });
  }
});

/* ======================================================
   GET BANK LEDGER (WITH ARCHIVE SNAPSHOT BASELINE)
====================================================== */
router.get("/", async (req, res) => {
  try {
    const { bank_profile_id } = req.query;

    if (!bank_profile_id) {
      return res.json({ success: true, rows: [] });
    }

    // 1. Fetch Latest Archive Snapshot Cutoff
    const snapshotRes = await pool.query(`
      SELECT id, date_to 
      FROM archive_snapshots 
      ORDER BY date_to DESC, id DESC 
      LIMIT 1
    `);

    let snapshotDateTo = "1970-01-01";
    let openingBankBaseline = 0;
    let hasSnapshot = false;

    if (snapshotRes.rows.length > 0) {
      const snapshotId = snapshotRes.rows[0].id;
      snapshotDateTo = new Date(snapshotRes.rows[0].date_to).toISOString().split("T")[0];
      hasSnapshot = true;

      // 2. Fetch specific Bank's snapshot balance from archive_balances
      const bankBalRes = await pool.query(`
        SELECT balance 
        FROM archive_balances 
        WHERE snapshot_id = $1 AND UPPER(balance_type) = 'BANK' AND code = $2
        LIMIT 1
      `, [snapshotId, String(bank_profile_id)]);

      if (bankBalRes.rows.length > 0) {
        openingBankBaseline = Number(bankBalRes.rows[0].balance || 0);
      }
    }

    let params = [snapshotDateTo, bank_profile_id];

    const sql = `
    WITH all_entries AS (
        /* CUSTOMER BANK PAYMENTS */
        SELECT
          cp.id,
          cp.payment_date::date AS txn_date,
          'Customer Payment - ' || COALESCE(
             (SELECT customer_name FROM (
                SELECT name AS customer_name FROM customers WHERE customer_code = cp.ref_no AND name IS NOT NULL AND name != ''
                UNION ALL SELECT name AS customer_name FROM archive_balances WHERE code = cp.ref_no AND name IS NOT NULL AND name != ''
                UNION ALL SELECT customer_name FROM bookings WHERE (customer_code = cp.ref_no OR ref_no = cp.ref_no) AND customer_name IS NOT NULL AND customer_name != ''
                UNION ALL SELECT customer_name FROM ticketing WHERE (customer_code = cp.ref_no OR ref_no = cp.ref_no) AND customer_name IS NOT NULL AND customer_name != ''
                UNION ALL SELECT customer_name FROM hotels WHERE (customer_code = cp.ref_no OR ref_no = cp.ref_no) AND customer_name IS NOT NULL AND customer_name != ''
                UNION ALL SELECT customer_name FROM visa WHERE (customer_code = cp.ref_no OR ref_no = cp.ref_no) AND customer_name IS NOT NULL AND customer_name != ''
                UNION ALL SELECT customer_name FROM card WHERE (customer_code = cp.ref_no OR ref_no = cp.ref_no) AND customer_name IS NOT NULL AND customer_name != ''
                UNION ALL SELECT customer_name FROM groups WHERE (customer_code = cp.ref_no OR ref_no = cp.ref_no) AND customer_name IS NOT NULL AND customer_name != ''
                UNION ALL SELECT customer_name FROM transport WHERE (customer_code = cp.ref_no OR ref_no = cp.ref_no) AND customer_name IS NOT NULL AND customer_name != ''
                UNION ALL SELECT customer_name FROM ziyarat WHERE (customer_code = cp.ref_no OR ref_no = cp.ref_no) AND customer_name IS NOT NULL AND customer_name != ''
              ) reg_cust LIMIT 1), 'Walk-in Customer'
          ) || ' (Ref: ' || cp.ref_no || ')' AS description,
          ROUND(cp.amount::numeric,0) AS credit,
          NULL::numeric AS debit,
          2 AS order_priority,
          'customer' AS source
        FROM customer_payments cp
        WHERE LOWER(COALESCE(cp.type,'')) != 'adjustment'
          AND LOWER(COALESCE(cp.type,'')) != 'opening_balance'
          AND LOWER(COALESCE(cp.payment_method,''))='bank'
          AND cp.payment_date::date > $1::date
          AND cp.bank_profile_id = $2

        UNION ALL

        /* SUPPLIER BANK PAYMENTS */
        SELECT
          sp.id,
          sp.payment_date::date AS txn_date,
          'Supplier Payment - ' || COALESCE(s.supplier_name,'') || ' (Ref: ' || sp.id || ')' AS description,
          NULL::numeric AS credit,
          ROUND(sp.amount::numeric,0) AS debit,
          2 AS order_priority,
          'supplier' AS source
        FROM supplier_payments sp
        LEFT JOIN suppliers s ON s.id = sp.supplier_id
        WHERE LOWER(COALESCE(sp.type,'')) != 'adjustment'
          AND LOWER(COALESCE(sp.type,'')) != 'opening_balance'
          AND LOWER(COALESCE(sp.payment_method,''))='bank'
          AND sp.payment_date::date > $1::date
          AND sp.bank_profile_id = $2

        UNION ALL

        /* EXPENSE BANK */
        SELECT
          e.id,
          e.expense_date::date AS txn_date,
          'Expense: ' || e.title AS description,
          NULL::numeric AS credit,
          ROUND(e.amount::numeric,0) AS debit,
          2 AS order_priority,
          'expense' AS source
        FROM expense_ledger e
        WHERE LOWER(COALESCE(e.payment_method,''))='bank'
          AND e.expense_date::date > $1::date
          AND e.bank_profile_id = $2

        UNION ALL

        /* MANUAL BANK */
        SELECT
          bt.id,
          bt.txn_date::date AS txn_date,
          bt.comment AS description,
          CASE WHEN bt.type='deposit' THEN ROUND(bt.amount::numeric,0) END AS credit,
          CASE WHEN bt.type='withdraw' THEN ROUND(bt.amount::numeric,0) END AS debit,
          2 AS order_priority,
          'manual' AS source
        FROM bank_transactions bt
        WHERE bt.txn_date::date > $1::date
          AND bt.bank_profile_id = $2
    )
    SELECT id, txn_date, description, credit, debit, source
    FROM all_entries
    ORDER BY txn_date ASC, id ASC;
    `;

    const result = await pool.query(sql, params);
    let formattedRows = [];
    let runningBalance = 0;

    // Inject Baseline if Snapshot exists
    if (hasSnapshot) {
      runningBalance = openingBankBaseline;
      formattedRows.push({
        id: "SNAPSHOT_OPENING",
        txn_date: snapshotDateTo,
        description: `🔑 Archived Bank Baseline Balance (${snapshotDateTo})`,
        credit: openingBankBaseline >= 0 ? openingBankBaseline : 0,
        debit: openingBankBaseline < 0 ? Math.abs(openingBankBaseline) : 0,
        source: "snapshot",
        balance: runningBalance
      });
    }

    result.rows.forEach((r) => {
      const credit = Number(r.credit || 0);
      const debit = Number(r.debit || 0);
      runningBalance += (credit - debit);

      formattedRows.push({
        ...r,
        credit,
        debit,
        balance: runningBalance,
      });
    });

    res.json({ success: true, rows: formattedRows });
  } catch (err) {
    console.error("Bank Ledger Error:", err);
    res.json({ success: false, error: err.message, rows: [] });
  }
});

/* ======================================================
   SAVE MANUAL BANK ENTRY (DEPOSIT / WITHDRAW)
====================================================== */
router.post("/transaction", async (req, res) => {
  try {
    const { txn_date, type, amount, comment, bank_profile_id } = req.body;

    if (!txn_date || !amount || !type || !bank_profile_id) {
      return res.json({ success: false, error: "Date, Amount, Type, & Bank Profile required" });
    }

    await pool.query(
      `INSERT INTO bank_transactions (txn_date, type, amount, comment, bank_profile_id) VALUES ($1, $2, $3, $4, $5)`,
      [txn_date, type, amount, comment || "", bank_profile_id]
    );

    res.json({ success: true, message: "Transaction saved successfully" });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* ======================================================
   DELETE MANUAL BANK ENTRY
====================================================== */
router.delete("/transaction/:id", async (req, res) => {
  try {
    const { password } = req.body;

    const passCheck = await pool.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1",
      ["delete_bank_transaction"]
    );

    if (passCheck.rows.length === 0 || password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Wrong Password" });
    }

    await pool.query("DELETE FROM bank_transactions WHERE id=$1", [req.params.id]);

    res.json({ success: true, message: "Transaction deleted" });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* ================= VERIFY PASSWORD ROUTE (STEP 1) ================= */
router.post("/verify-password", async (req, res) => {
  try {
    const { password } = req.body;

    const passCheck = await pool.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1",
      ["delete_bank_transaction"]
    );

    if (passCheck.rows.length === 0) {
      return res.json({
        success: false,
        error: "System authorization password not configured in database!",
      });
    }

    if (password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Incorrect Password!" });
    }

    res.json({ success: true, message: "Password verified successfully" });
  } catch (err) {
    console.error("Password verification error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ================= EDIT MANUAL BANK TRANSACTION (STEP 2) ================= */
router.put("/transaction/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { txn_date, type, amount, comment, bank_profile_id } = req.body;

    if (!txn_date || !type || !amount || !bank_profile_id) {
      return res.json({ success: false, error: "Missing required fields" });
    }

    await pool.query(
      `UPDATE bank_transactions SET txn_date=$1, type=$2, amount=$3, comment=$4, bank_profile_id=$5 WHERE id=$6`,
      [txn_date, type, amount, comment || "", bank_profile_id, id]
    );

    res.json({ success: true, message: "Transaction updated successfully" });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;