const express = require("express");
const router = express.Router();
const db = require("../db");

/* =====================================================
   HELPERS: CUSTOMER TOTAL SALES & OPENING BALANCE (CREDIT)
   Accounting Logic: Sale / Opening Balance -> Credit (+)
===================================================== */
async function getRegCustomerSale(customer_code) {
  const sale = await db.query(
    `
    SELECT COALESCE(SUM(amount), 0) AS total_sale
    FROM (
      SELECT total_pkr AS amount FROM bookings WHERE customer_code=$1 AND is_deleted=false
      UNION ALL
      SELECT total_pkr FROM hotels WHERE customer_code=$1 AND is_deleted=false
      UNION ALL
      SELECT total_pkr FROM visa WHERE customer_code=$1 AND is_deleted=false
      UNION ALL
      SELECT total_pkr FROM card WHERE customer_code=$1 AND is_deleted=false
      UNION ALL
      SELECT total_pkr FROM groups WHERE customer_code=$1 AND is_deleted=false
      UNION ALL
      SELECT total_pkr FROM ticketing WHERE customer_code=$1 AND is_deleted=false
      UNION ALL
      SELECT total_pkr FROM transport WHERE customer_code=$1 AND is_deleted=false
      UNION ALL
      SELECT total_pkr FROM ziyarat WHERE customer_code=$1 AND is_deleted=false
    ) x
    `,
    [customer_code]
  );

  const openingBal = await db.query(
    `
    SELECT COALESCE(SUM(amount), 0) AS op_bal 
    FROM customer_payments 
    WHERE ref_no=$1 AND type='opening_balance'
    `,
    [customer_code]
  );

  return Number(sale.rows[0]?.total_sale || 0) + Number(openingBal.rows[0]?.op_bal || 0);
}

/* =====================================================
   HELPERS: CUSTOMER TOTAL PAYMENTS (DEBIT)
   Accounting Logic: Customer Payment -> Debit (-)
===================================================== */
async function getRegCustomerPayments(customer_code) {
  const paid = await db.query(
    `
    SELECT COALESCE(SUM(amount), 0) AS paid
    FROM customer_payments
    WHERE ref_no=$1 AND type != 'opening_balance'
    `,
    [customer_code]
  );
  return Number(paid.rows[0]?.paid || 0);
}

/* =====================================================
   1. REGISTERED LEDGER DETAIL (WITH SNAPSHOT BASELINE)
===================================================== */
router.get("/detail/:customer_code", async (req, res) => {
  try {
    const { customer_code } = req.params;
    const { startDate, endDate } = req.query;

    let customerName = "Registered Customer";

    // 1. Fetch Snapshot Cutoff & Baseline Balance for this Customer
    const snapshotRes = await db.query(`
      SELECT id, date_to 
      FROM archive_snapshots 
      ORDER BY date_to DESC, id DESC 
      LIMIT 1
    `);

    let snapshotDateTo = "1970-01-01";
    let customerBaseline = 0;
    let hasSnapshot = false;

    if (snapshotRes.rows.length > 0) {
      const snapshotId = snapshotRes.rows[0].id;
      snapshotDateTo = new Date(snapshotRes.rows[0].date_to).toISOString().split("T")[0];
      hasSnapshot = true;

      const custBalRes = await db.query(`
        SELECT balance 
        FROM archive_balances 
        WHERE snapshot_id = $1 AND UPPER(balance_type) = 'CUSTOMER' AND code = $2
        LIMIT 1
      `, [snapshotId, customer_code]);

      if (custBalRes.rows.length > 0) {
        customerBaseline = Number(custBalRes.rows[0].balance || 0);
      }
    }

    // Dynamic customer name lookup
    const nameRes = await db.query(
      `
      SELECT customer_name FROM (
        SELECT customer_name FROM bookings WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
        UNION ALL SELECT customer_name FROM hotels WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
        UNION ALL SELECT customer_name FROM visa WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
        UNION ALL SELECT customer_name FROM card WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
        UNION ALL SELECT customer_name FROM groups WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
        UNION ALL SELECT customer_name FROM ticketing WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
        UNION ALL SELECT customer_name FROM transport WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
        UNION ALL SELECT customer_name FROM ziyarat WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
      ) x LIMIT 1
      `,
      [customer_code]
    );

    if (nameRes.rows.length > 0) {
      customerName = nameRes.rows[0].customer_name;
    }

    // Load Live Sales after snapshot
    const salesRes = await db.query(
      `
      SELECT ref_no, booking_date, total_pkr, 'Booking' AS src FROM bookings WHERE customer_code=$1 AND is_deleted=false AND booking_date::date > $2::date
      UNION ALL SELECT ref_no, booking_date, total_pkr, 'Hotel' AS src FROM hotels WHERE customer_code=$1 AND is_deleted=false AND booking_date::date > $2::date
      UNION ALL SELECT ref_no, booking_date, total_pkr, 'Visa' AS src FROM visa WHERE customer_code=$1 AND is_deleted=false AND booking_date::date > $2::date
      UNION ALL SELECT ref_no, booking_date, total_pkr, 'Card' AS src FROM card WHERE customer_code=$1 AND is_deleted=false AND booking_date::date > $2::date
      UNION ALL SELECT ref_no, booking_date, total_pkr, 'Group' AS src FROM groups WHERE customer_code=$1 AND is_deleted=false AND booking_date::date > $2::date
      UNION ALL SELECT ref_no, booking_date, total_pkr, 'Ticketing' AS src FROM ticketing WHERE customer_code=$1 AND is_deleted=false AND booking_date::date > $2::date
      UNION ALL SELECT ref_no, booking_date, total_pkr, 'Transport' AS src FROM transport WHERE customer_code=$1 AND is_deleted=false AND booking_date::date > $2::date
      UNION ALL SELECT ref_no, booking_date, total_pkr, 'Ziyarat' AS src FROM ziyarat WHERE customer_code=$1 AND is_deleted=false AND booking_date::date > $2::date
      `,
      [customer_code, snapshotDateTo]
    );


// Load Live Payments after snapshot
    const paymentsRes = await db.query(
      `
      SELECT cp.id, cp.payment_date, cp.amount, cp.type, cp.payment_method, cp.bank_profile_id, b.bank_name
      FROM customer_payments cp
      LEFT JOIN public.banks b ON b.id = cp.bank_profile_id
      WHERE cp.ref_no = $1 AND cp.payment_date::date > $2::date
      ORDER BY cp.payment_date, cp.id
      `,
      [customer_code, snapshotDateTo]
    );

    let allEntries = [];

    // Sales -> Credit (+)
    salesRes.rows.forEach(s => {
      allEntries.push({
        id: `SALE-${s.ref_no}`,
        date: s.booking_date,
        description: `Sale Invoice (${s.src}) - Ref: ${s.ref_no}`,
        debit: 0,
        credit: Math.round(Number(s.total_pkr || 0)),
        type: "sale"
      });
    });

    // Payments -> Debit (-)
    paymentsRes.rows.forEach(p => {
      const amt = Math.round(Number(p.amount || 0));
      let methodDesc = p.payment_method || "";
      if (p.payment_method?.toLowerCase() === "bank" && p.bank_name) {
        methodDesc = `Bank: ${p.bank_name}`;
      }

      if (p.type === "opening_balance") {
        allEntries.push({
          id: p.id,
          date: p.payment_date,
          description: `🔑 Opening Balance`,
          debit: 0,
          credit: amt,
          type: "opening_balance",
          payment_method: p.payment_method || "-",
          bank_name: p.bank_name || null
        });
      } else {
        allEntries.push({
          id: p.id,
          date: p.payment_date,
          description: p.type === "adjustment" ? `Adjustment (${methodDesc})` : `Payment Received (${methodDesc})`,
          debit: amt,
          credit: 0,
          type: "payment",
          payment_method: p.payment_method || "-",
          bank_name: p.bank_name || null
        });
      }
    });

// 1. Same-day sequence priority (Oldest calculation order)
    const getTypePriority = (type) => {
      if (type === "snapshot" || type === "opening_balance") return 0;
      if (type === "sale") return 1;
      return 2;
    };

    // 2. Step 1: CHRONOLOGICAL SORT (Purani tareekh pehle taake running balance sahi calculate ho)
    allEntries.sort((a, b) => {
      const dateA = new Date(a.date).getTime();
      const dateB = new Date(b.date).getTime();
      
      if (dateA !== dateB) return dateA - dateB;
      
      const prioA = getTypePriority(a.type);
      const prioB = getTypePriority(b.type);
      if (prioA !== prioB) return prioA - prioB;
      
      return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    });

    let runningBalance = hasSnapshot ? customerBaseline : 0;
    let computedList = [];

    if (hasSnapshot) {
      computedList.push({
        id: "SNAPSHOT_OPENING",
        date: snapshotDateTo,
        description: `Opening Snapshot Balance (${snapshotDateTo})`,
        debit: customerBaseline < 0 ? Math.abs(customerBaseline) : 0,
        credit: customerBaseline >= 0 ? customerBaseline : 0,
        type: "snapshot",
        balance: runningBalance
      });
    }

    // Step 2: Calculate Exact Running Balance
    allEntries.forEach((entry) => {
      runningBalance = runningBalance + entry.credit - entry.debit;

      let matchDate = true;
      if (startDate && new Date(entry.date) < new Date(startDate)) matchDate = false;
      if (endDate && new Date(entry.date) > new Date(endDate)) matchDate = false;

      if (matchDate) {
        computedList.push({
          ...entry,
          balance: runningBalance
        });
      }
    });

    // Step 3: DISPLAY SORT (NEWEST FIRST AT TOP + SAME DAY REVERSE)
    computedList.sort((a, b) => {
      const dateA = new Date(a.date).getTime();
      const dateB = new Date(b.date).getTime();
      
      // Target 1: Nayi Date Sab Se Upar
      if (dateA !== dateB) return dateB - dateA; 
      
      // Snapshot hamesha sab se niche rahe Same-Day me
      if (a.type === "snapshot") return 1;
      if (b.type === "snapshot") return -1;

      // Target 2: Same-day me LATEST Entry Sab Se Upar (Payment/Sale Priority Reversed)
      const prioA = getTypePriority(a.type);
      const prioB = getTypePriority(b.type);
      if (prioA !== prioB) return prioB - prioA;

      return String(b.id).localeCompare(String(a.id), undefined, { numeric: true });
    });

    res.json({
      success: true,
      customerName,
      rows: computedList,
      totalRemainingBalance: runningBalance
    });
     
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message });
  }
});

/* =====================================================
   2. GET ALL PENDING CUSTOMERS (WITH SNAPSHOT BASELINE)
===================================================== */
router.get("/pending/list", async (req, res) => {
  try {
    const validCustomerCodesRes = await db.query(
      `
      SELECT DISTINCT customer_code FROM bookings WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION
      SELECT customer_code FROM hotels WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION
      SELECT customer_code FROM visa WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION
      SELECT customer_code FROM card WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION
      SELECT customer_code FROM groups WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION
      SELECT customer_code FROM ticketing WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION
      SELECT customer_code FROM transport WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION
      SELECT customer_code FROM ziyarat WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION
      SELECT ref_no AS customer_code FROM customer_payments WHERE ref_no IS NOT NULL AND ref_no != ''
      `
    );

    const validCustomerCodes = validCustomerCodesRes.rows.map(r => r.customer_code);

    if (validCustomerCodes.length === 0) {
      return res.json({ success: true, rows: [] });
    }

    // 1. Fetch Latest Archive Snapshot Info
    const snapshotRes = await db.query(`
      SELECT id, date_to 
      FROM archive_snapshots 
      ORDER BY date_to DESC, id DESC 
      LIMIT 1
    `);

    let snapshotId = null;
    let snapshotDateTo = "1970-01-01";

    if (snapshotRes.rows.length > 0) {
      snapshotId = snapshotRes.rows[0].id;
      snapshotDateTo = new Date(snapshotRes.rows[0].date_to).toISOString().split("T")[0];
    }

    // 2. Query Credits, Debits (after snapshot) and Archived Balances
    const result = await db.query(
      `
      WITH snapshot_balances AS (
        SELECT code AS customer_code, balance AS snapshot_bal
        FROM archive_balances
        WHERE snapshot_id = $2 AND UPPER(balance_type) = 'CUSTOMER' AND code = ANY($1)
      ),

      all_credits AS (
        SELECT customer_code, total_pkr AS amount FROM bookings WHERE customer_code = ANY($1) AND is_deleted=false AND booking_date::date > $3::date
        UNION ALL
        SELECT customer_code, total_pkr FROM hotels WHERE customer_code = ANY($1) AND is_deleted=false AND booking_date::date > $3::date
        UNION ALL
        SELECT customer_code, total_pkr FROM visa WHERE customer_code = ANY($1) AND is_deleted=false AND booking_date::date > $3::date
        UNION ALL
        SELECT customer_code, total_pkr FROM card WHERE customer_code = ANY($1) AND is_deleted=false AND booking_date::date > $3::date
        UNION ALL
        SELECT customer_code, total_pkr FROM groups WHERE customer_code = ANY($1) AND is_deleted=false AND booking_date::date > $3::date
        UNION ALL
        SELECT customer_code, total_pkr FROM ticketing WHERE customer_code = ANY($1) AND is_deleted=false AND booking_date::date > $3::date
        UNION ALL
        SELECT customer_code, total_pkr FROM transport WHERE customer_code = ANY($1) AND is_deleted=false AND booking_date::date > $3::date
        UNION ALL
        SELECT customer_code, total_pkr FROM ziyarat WHERE customer_code = ANY($1) AND is_deleted=false AND booking_date::date > $3::date
        UNION ALL
        SELECT ref_no AS customer_code, amount FROM customer_payments WHERE ref_no = ANY($1) AND type='opening_balance' AND payment_date::date > $3::date
      ),
      
      all_debits AS (
        SELECT ref_no AS customer_code, amount FROM customer_payments WHERE ref_no = ANY($1) AND type != 'opening_balance' AND payment_date::date > $3::date
      ),

      customer_names AS (
        SELECT DISTINCT ON (customer_code) customer_code, customer_name
        FROM (
          SELECT customer_code, customer_name FROM bookings WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
          UNION ALL
          SELECT customer_code, customer_name FROM hotels WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
          UNION ALL
          SELECT customer_code, customer_name FROM visa WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
          UNION ALL
          SELECT customer_code, customer_name FROM card WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
          UNION ALL
          SELECT customer_code, customer_name FROM groups WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
          UNION ALL
          SELECT customer_code, customer_name FROM ticketing WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
          UNION ALL
          SELECT customer_code, customer_name FROM transport WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
          UNION ALL
          SELECT customer_code, customer_name FROM ziyarat WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
          UNION ALL
          SELECT customer_code, name AS customer_name FROM customers WHERE customer_code = ANY($1) AND name IS NOT NULL AND name != ''
        ) n
      ),

      aggregated AS (
        SELECT 
          c.customer_code,
          COALESCE(sb.snapshot_bal, 0) AS snapshot_bal,
          COALESCE(cr.total_credit, 0) AS total_sale,
          COALESCE(db.total_debit, 0) AS total_paid
        FROM (
          SELECT unnest($1::text[]) AS customer_code
        ) c
        LEFT JOIN snapshot_balances sb ON c.customer_code = sb.customer_code
        LEFT JOIN (SELECT customer_code, SUM(amount) AS total_credit FROM all_credits GROUP BY customer_code) cr ON c.customer_code = cr.customer_code
        LEFT JOIN (SELECT customer_code, SUM(amount) AS total_debit FROM all_debits GROUP BY customer_code) db ON c.customer_code = db.customer_code
      )

      SELECT 
        a.customer_code,
        COALESCE(n.customer_name, 'Registered Customer') AS customer_name,
        (a.snapshot_bal + a.total_sale - a.total_paid) AS remaining_balance,
        a.total_paid
      FROM aggregated a
      LEFT JOIN customer_names n ON a.customer_code = n.customer_code
      /* FIX 1: PostgreSQL level par double precision / floating point zero issue handle kiya gaya */
      WHERE ROUND((a.snapshot_bal + a.total_sale - a.total_paid)::numeric, 2) != 0
      `,
      [validCustomerCodes, snapshotId, snapshotDateTo]
    );

    let pending = result.rows
      .map(row => {
        const balance = Math.round(Number(row.remaining_balance));
        const totalPaid = Number(row.total_paid);
        let status = "PARTIAL";

        if (balance > 0) {
          status = totalPaid === 0 ? "PENDING" : "PARTIAL";
        } else if (balance < 0) {
          status = "EXTRA PAID";
        }

        return {
          customer_code: row.customer_code,
          customer_name: row.customer_name,
          remaining_balance: balance,
          payment_status: status
        };
      })
      /* FIX 2: Double security ke liye JS level par bhi 0 balance walay filter kar diye */
      .filter(item => item.remaining_balance !== 0);

    res.json({ success: true, rows: pending });
  } catch (err) {
    console.error("Error in pending list:", err);
    res.json({ success: false, error: err.message });
  }
});



/* =====================================================
   3. SAVE REGISTERED CUSTOMER PAYMENT / OPENING BALANCE
===================================================== */
router.post("/payment", async (req, res) => {
  try {
    const { customer_code, amount, payment_method, bank_profile_id, type, payment_date } = req.body;

    if (!customer_code) return res.json({ success: false, error: "Customer Code is required" });
    if (!amount || Number(amount) <= 0) return res.json({ success: false, error: "Amount must be greater than zero" });
    if (!payment_date) return res.json({ success: false, error: "Payment Date is required" });

    await db.query(
      `
      INSERT INTO customer_payments (ref_no, amount, payment_method, bank_profile_id, type, payment_date)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        customer_code, 
        amount, 
        payment_method || "Cash", 
        payment_method === "Bank" ? bank_profile_id : null,
        type || "payment", 
        payment_date
      ]
    );

    res.json({ success: true, message: "Transaction saved successfully!" });
  } catch (err) {
    console.error("Payment Save Error:", err);
    res.json({ success: false, error: err.message });
  }
});

/* =====================================================
   4. DELETE PAYMENT (LOOKUP BY ID)
===================================================== */
router.post("/delete/:id", async (req, res) => {
  try {
    const { password } = req.body;

    const passCheck = await db.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1",
      ["delete_registered_payment"]
    );

    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "Delete Password is not configured in DB." });
    }

    if (password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Invalid Authorization Password!" });
    }

    await db.query("DELETE FROM customer_payments WHERE id = $1", [req.params.id]);
    res.json({ success: true, message: "Entry deleted successfully" });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* =====================================================
   VERIFY PASSWORD ROUTE (STEP 1)
===================================================== */
router.post("/verify-password", async (req, res) => {
  try {
    const { password } = req.body;

    const passCheck = await db.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1",
      ["delete_registered_payment"]
    );

    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "Password is not configured in DB." });
    }

    if (password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Invalid Authorization Password!" });
    }

    res.json({ success: true, message: "Password verified successfully!" });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* =====================================================
   5. EDIT PAYMENT / ENTRY (STEP 2 SUBMIT)
===================================================== */
router.put("/edit/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, payment_date, payment_method, bank_profile_id, type } = req.body;

    if (!id || isNaN(id)) {
      return res.json({ success: false, error: "Invalid transaction ID" });
    }

    if (!amount || Number(amount) <= 0) {
      return res.json({ success: false, error: "Amount must be greater than zero" });
    }

    const check = await db.query("SELECT id FROM customer_payments WHERE id = $1", [id]);
    if (check.rows.length === 0) {
      return res.json({ success: false, error: "Payment entry not found!" });
    }

    await db.query(
      `
      UPDATE customer_payments
      SET amount = $1, payment_date = $2, payment_method = $3, bank_profile_id = $4, type = $5
      WHERE id = $6
      `,
      [
        amount, 
        payment_date, 
        payment_method || "Cash", 
        payment_method === "Bank" ? bank_profile_id : null,
        type || "payment", 
        id
      ]
    );

    res.json({ success: true, message: "Entry updated successfully" });
  } catch (err) {
    console.error("Edit error:", err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
