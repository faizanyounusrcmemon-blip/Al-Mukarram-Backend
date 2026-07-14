const express = require("express");
const router = express.Router();
const pool = require("../db");

/* ======================================================
   GET CASH LEDGER
   PERFECT SNAPSHOT INTEGRATION & TIMEZONE FIX
====================================================== */
router.get("/", async (req, res) => {
  try {
    // 1. Sab se pehle latest snapshot ki details nikalte hain
    const snapshotRes = await pool.query(`
      SELECT date_to, opening_cash 
      FROM archive_snapshots 
      WHERE opening_cash IS NOT NULL 
      ORDER BY date_to DESC, id DESC 
      LIMIT 1
    `);

    let snapshotDateTo = '1970-01-01'; 
    let hasSnapshot = false;

    if (snapshotRes.rows.length > 0) {
      const rawDate = snapshotRes.rows[0].date_to;
      // Convert to proper YYYY-MM-DD format without timezone interference
      snapshotDateTo = new Date(rawDate).toLocaleDateString('en-CA'); // Outputs 'YYYY-MM-DD'
      hasSnapshot = true;
    }

    const sql = `
    WITH opening AS (
        SELECT
          0 AS id,
          $1::date AS txn_date,
          'Opening Cash Balance' AS description,

          CASE 
            WHEN opening_cash > 0
            THEN ROUND(opening_cash::numeric,0)
          END AS credit,

          CASE
            WHEN opening_cash < 0
            THEN ROUND(ABS(opening_cash)::numeric,0)
          END AS debit,

          -- Opening ko sabsay oopar rakhnay ke liye order logic
          0 AS order_priority,
          'opening' AS source
        FROM archive_snapshots
        WHERE opening_cash IS NOT NULL
        ORDER BY date_to DESC, id DESC
        LIMIT 1
    ),

    all_entries AS (

        /* ================= OPENING ================= */
        SELECT id, txn_date, description, credit, debit, order_priority, source FROM opening

        UNION ALL

        /* ================= CUSTOMER CASH (OPTIMIZED JOIN) ================= */
        SELECT
          cp.id,
          cp.payment_date::date AS txn_date,
          'Customer Payment - ' || COALESCE(
             (SELECT customer_name FROM bookings WHERE ref_no = cp.ref_no AND booking_date::date > $1::date
              UNION ALL
              SELECT customer_name FROM hotels WHERE ref_no = cp.ref_no AND booking_date::date > $1::date
              UNION ALL
              SELECT customer_name FROM visa WHERE ref_no = cp.ref_no AND booking_date::date > $1::date
              UNION ALL
              SELECT customer_name FROM card WHERE ref_no = cp.ref_no AND booking_date::date > $1::date
              UNION ALL
              SELECT customer_name FROM groups WHERE ref_no = cp.ref_no AND booking_date::date > $1::date
              UNION ALL
              SELECT customer_name FROM ticketing WHERE ref_no = cp.ref_no AND booking_date::date > $1::date
              UNION ALL
              SELECT customer_name FROM transport WHERE ref_no = cp.ref_no AND booking_date::date > $1::date
              UNION ALL
              SELECT customer_name FROM ziyarat WHERE ref_no = cp.ref_no AND booking_date::date > $1::date
              LIMIT 1
             ), 'Walk-in Customer'
          ) || ' (Ref: ' || cp.ref_no || ')' AS description,
          ROUND(cp.amount::numeric,0) AS credit,
          NULL::numeric AS debit,
          1 AS order_priority,
          'customer' AS source
        FROM customer_payments cp
        WHERE LOWER(COALESCE(cp.type,'')) != 'adjustment'
          AND LOWER(COALESCE(cp.payment_method,''))='cash'
          AND cp.is_deleted = false
          AND cp.payment_date::date > $1::date -- Strict filter for date only

        UNION ALL

        /* ================= SUPPLIER CASH ================= */
        SELECT
          sp.id,
          sp.payment_date::date AS txn_date,
          'Supplier Payment - ' || COALESCE(s.supplier_name,'') || ' (Ref: ' || sp.id || ')' AS description,
          NULL::numeric AS credit,
          ROUND(sp.amount::numeric,0) AS debit,
          1 AS order_priority,
          'supplier' AS source
        FROM supplier_payments sp
        LEFT JOIN suppliers s ON s.id = sp.supplier_id
        WHERE LOWER(COALESCE(sp.type,'')) != 'adjustment'
          AND LOWER(COALESCE(sp.payment_method,''))='cash'
          AND sp.payment_date::date > $1::date

        UNION ALL

        /* ================= EXPENSE CASH ================= */
        SELECT
          e.id,
          e.expense_date::date AS txn_date,
          'Expense: ' || e.title AS description,
          NULL::numeric AS credit,
          ROUND(e.amount::numeric,0) AS debit,
          1 AS order_priority,
          'expense' AS source
        FROM expense_ledger e
        WHERE LOWER(COALESCE(e.payment_method,''))='cash'
          AND e.expense_date::date > $1::date

        UNION ALL

        /* ================= MANUAL CASH ================= */
        SELECT
          bt.id,
          bt.txn_date::date AS txn_date,
          bt.comment AS description,
          CASE WHEN bt.type='deposit' THEN ROUND(bt.amount::numeric,0) END AS credit,
          CASE WHEN bt.type='withdraw' THEN ROUND(bt.amount::numeric,0) END AS debit,
          1 AS order_priority,
          'manual' AS source
        FROM cash_transactions bt
        WHERE bt.txn_date::date > $1::date 
    )

    SELECT
      id,
      txn_date,
      description,
      credit,
      debit,
      source,
      ROUND(
        SUM(COALESCE(credit,0) - COALESCE(debit,0)) OVER(ORDER BY txn_date ASC, order_priority ASC, id ASC)
      ,0) AS balance
    FROM all_entries
    ORDER BY txn_date ASC, order_priority ASC, id ASC;
    `;

    const result = await pool.query(sql, [snapshotDateTo]);

    let rows = result.rows;
    if (!hasSnapshot) {
      rows = rows.filter(r => r.source !== 'opening');
    }

    const formattedRows = rows.map(r => ({
      ...r,
      credit: Number(r.credit || 0),
      debit: Number(r.debit || 0),
      balance: Number(r.balance || 0)
    }));

    res.json({
      success: true,
      rows: formattedRows
    });

  } catch (err) {
    console.error("CASH LEDGER ERROR:", err);
    res.json({
      success: false,
      error: err.message
    });
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

    // 🔑 Database se dynamic look up (Bina kisi hardcoded fallback ke)
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

module.exports = router;
