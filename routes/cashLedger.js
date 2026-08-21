const express = require("express");
const router = express.Router();
const pool = require("../db");

/* ======================================================
   GET CASH LEDGER (WITH ARCHIVE SNAPSHOT BASELINE)
====================================================== */
router.get("/", async (req, res) => {
  try {
    // 1. Fetch Latest Archive Snapshot Baseline
    const snapshotRes = await pool.query(`
      SELECT date_to, COALESCE(opening_cash, 0) AS opening_cash 
      FROM archive_snapshots 
      WHERE opening_cash IS NOT NULL 
      ORDER BY date_to DESC, id DESC 
      LIMIT 1
    `);

    let snapshotDateTo = "1970-01-01";
    let openingCashBaseline = 0;
    let hasSnapshot = false;

    if (snapshotRes.rows.length > 0) {
      const rawDate = snapshotRes.rows[0].date_to;
      snapshotDateTo = new Date(rawDate).toISOString().split("T")[0];
      openingCashBaseline = Number(snapshotRes.rows[0].opening_cash || 0);
      hasSnapshot = true;
    }

    // 2. Query Live Transactions strictly created AFTER snapshot cutoff date
    const sql = `
    WITH all_entries AS (
        /* CUSTOMER CASH */
        SELECT
          cp.id,
          cp.payment_date::date AS txn_date,
          'Customer Payment - ' || COALESCE(
             (SELECT customer_name FROM (
                SELECT name AS customer_name FROM customers WHERE customer_code = cp.ref_no AND name IS NOT NULL AND name != ''
                UNION ALL SELECT name AS customer_name FROM archive_balances WHERE code = cp.ref_no AND name IS NOT NULL AND name != ''
                UNION ALL SELECT customer_name FROM bookings WHERE (customer_code = cp.ref_no OR ref_no = cp.ref_no) AND customer_name IS NOT NULL AND customer_name != ''
                UNION ALL SELECT customer_name FROM hotels WHERE (customer_code = cp.ref_no OR ref_no = cp.ref_no) AND customer_name IS NOT NULL AND customer_name != ''
                UNION ALL SELECT customer_name FROM visa WHERE (customer_code = cp.ref_no OR ref_no = cp.ref_no) AND customer_name IS NOT NULL AND customer_name != ''
                UNION ALL SELECT customer_name FROM card WHERE (customer_code = cp.ref_no OR ref_no = cp.ref_no) AND customer_name IS NOT NULL AND customer_name != ''
                UNION ALL SELECT customer_name FROM groups WHERE (customer_code = cp.ref_no OR ref_no = cp.ref_no) AND customer_name IS NOT NULL AND customer_name != ''
                UNION ALL SELECT customer_name FROM ticketing WHERE (customer_code = cp.ref_no OR ref_no = cp.ref_no) AND customer_name IS NOT NULL AND customer_name != ''
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
          AND LOWER(COALESCE(cp.payment_method,''))='cash'
          AND cp.is_deleted = false
          AND cp.payment_date::date > $1::date

        UNION ALL

        /* SUPPLIER CASH */
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
          AND LOWER(COALESCE(sp.payment_method,''))='cash'
          AND sp.payment_date::date > $1::date

        UNION ALL

        /* EXPENSE CASH */
        SELECT
          e.id,
          e.expense_date::date AS txn_date,
          'Expense: ' || e.title AS description,
          NULL::numeric AS credit,
          ROUND(e.amount::numeric,0) AS debit,
          2 AS order_priority,
          'expense' AS source
        FROM expense_ledger e
        WHERE LOWER(COALESCE(e.payment_method,''))='cash'
          AND e.expense_date::date > $1::date

        UNION ALL

        /* MANUAL CASH */
        SELECT
          bt.id,
          bt.txn_date::date AS txn_date,
          bt.comment AS description,
          CASE WHEN bt.type='deposit' THEN ROUND(bt.amount::numeric,0) END AS credit,
          CASE WHEN bt.type='withdraw' THEN ROUND(bt.amount::numeric,0) END AS debit,
          2 AS order_priority,
          'manual' AS source
        FROM cash_transactions bt
        WHERE bt.txn_date::date > $1::date 
    )
    SELECT id, txn_date, description, credit, debit, source, order_priority
    FROM all_entries
    ORDER BY txn_date ASC, order_priority ASC, id ASC;
    `;

    const result = await pool.query(sql, [snapshotDateTo]);
    let formattedRows = [];
    let runningBalance = 0;

    // 3. Inject Baseline Opening Cash Row if Snapshot Exists
    if (hasSnapshot) {
      runningBalance = openingCashBaseline;
      formattedRows.push({
        id: "SNAPSHOT_OPENING",
        txn_date: snapshotDateTo,
        description: `🔑 Archived Snapshot Cash Baseline (${snapshotDateTo})`,
        credit: openingCashBaseline >= 0 ? openingCashBaseline : 0,
        debit: openingCashBaseline < 0 ? Math.abs(openingCashBaseline) : 0,
        source: "snapshot",
        balance: runningBalance
      });
    }

    // 4. Calculate Running Balance over live records
    result.rows.forEach(r => {
      const credit = Number(r.credit || 0);
      const debit = Number(r.debit || 0);
      runningBalance += (credit - debit);

      formattedRows.push({
        ...r,
        credit,
        debit,
        balance: runningBalance
      });
    });

    res.json({
      success: true,
      rows: formattedRows
    });

  } catch (err) {
    console.error("CASH LEDGER ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});


/* ======================================================
   SAVE MANUAL CASH ENTRY
====================================================== */
router.post("/transaction", async (req, res) => {
  try {
    const { txn_date, type, amount, comment } = req.body;

    if (!txn_date || !amount || !type) {
      return res.json({
        success: false,
        error: "Missing fields"
      });
    }

    await pool.query(
      `INSERT INTO cash_transactions (txn_date, type, amount, comment) VALUES ($1,$2,$3,$4)`,
      [txn_date, type, amount, comment || ""]
    );

    res.json({
      success: true,
      message: "Transaction saved"
    });
  } catch (err) {
    res.json({
      success: false,
      error: err.message
    });
  }
});

/* ======================================================
   DELETE MANUAL CASH ENTRY (DYNAMIC DATABASE CHECK)
====================================================== */
router.delete("/transaction/:id", async (req, res) => {
  try {
    const { password } = req.body;

    const passCheck = await pool.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1", 
      ['delete_cash_transaction']
    );
    
    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "System password not configured in database!" });
    }

    const dbPassword = passCheck.rows[0].password_val;

    if (password !== dbPassword) {
      return res.json({
        success: false,
        error: "Wrong password"
      });
    }

    await pool.query(
      `DELETE FROM cash_transactions WHERE id=$1`,
      [req.params.id]
    );

    res.json({
      success: true,
      message: "Transaction deleted"
    });
  } catch (err) {
    res.json({
      success: false,
      error: err.message
    });
  }
});

/* ================= VERIFY PASSWORD ROUTE (STEP 1) ================= */
router.post("/verify-password", async (req, res) => {
  try {
    const { password } = req.body;

    const passCheck = await pool.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1",
      ["delete_cash_transaction"]
    );

    if (passCheck.rows.length === 0) {
      return res.json({
        success: false,
        error: "System password not configured in database!",
      });
    }

    const dbPassword = passCheck.rows[0].password_val;

    if (password !== dbPassword) {
      return res.json({
        success: false,
        error: "Incorrect Password!",
      });
    }

    res.json({
      success: true,
      message: "Password verified",
    });
  } catch (err) {
    console.error("CASH LEDGER VERIFY PASSWORD ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ================= EDIT MANUAL CASH TRANSACTION (STEP 2 SUBMIT) ================= */
router.put("/transaction/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { txn_date, type, amount, comment } = req.body;

    if (!id || isNaN(id)) {
      return res.json({ success: false, error: "Invalid transaction ID" });
    }

    if (!txn_date || !amount || !type) {
      return res.json({ success: false, error: "Missing required fields" });
    }

    if (Number(amount) <= 0) {
      return res.json({ success: false, error: "Amount must be greater than zero" });
    }

    await pool.query(
      `
      UPDATE cash_transactions
      SET txn_date = $1, type = $2, amount = $3, comment = $4
      WHERE id = $5
      `,
      [txn_date, type, amount, comment || "", id]
    );

    res.json({
      success: true,
      message: "Transaction updated successfully",
    });
  } catch (err) {
    console.error("CASH LEDGER EDIT ERROR:", err);
    res.json({
      success: false,
      error: err.message,
    });
  }
});

module.exports = router;