const express = require("express");
const router = express.Router();
const db = require("../db");

/* =====================================================
   HELPERS: CUSTOMER TOTAL SALES (DEBIT VALUES)
   Strictly using customer_code
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
   HELPERS: CUSTOMER TOTAL PAYMENTS (CREDIT VALUES ONLY)
   Excluding 'opening_balance' since it is treated as a Debit
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
   1. REGISTERED LEDGER DETAIL (LOOKUP BY STRICT CUSTOMER_CODE ONLY)
===================================================== */
router.get("/detail/:customer_code", async (req, res) => {
  try {
    const { customer_code } = req.params;
    const { startDate, endDate } = req.query;

    let customerName = "Registered Customer";

    // Dynamic customer name lookup
    const nameRes = await db.query(
      `
      SELECT customer_name FROM (
        SELECT customer_name FROM bookings WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
        UNION ALL
        SELECT customer_name FROM hotels WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
        UNION ALL
        SELECT customer_name FROM visa WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
        UNION ALL
        SELECT customer_name FROM card WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
        UNION ALL
        SELECT customer_name FROM groups WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
        UNION ALL
        SELECT customer_name FROM ticketing WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
        UNION ALL
        SELECT customer_name FROM transport WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
        UNION ALL
        SELECT customer_name FROM ziyarat WHERE customer_code=$1 AND is_deleted=false AND customer_name IS NOT NULL AND customer_name != ''
      ) x LIMIT 1
      `,
      [customer_code]
    );

    if (nameRes.rows.length > 0) {
      customerName = nameRes.rows[0].customer_name;
    }

    // Load Sales using customer_code
    const salesRes = await db.query(
      `
      SELECT ref_no, booking_date, total_pkr, 'Booking' AS src FROM bookings WHERE customer_code=$1 AND is_deleted=false
      UNION ALL
      SELECT ref_no, booking_date, total_pkr, 'Hotel' AS src FROM hotels WHERE customer_code=$1 AND is_deleted=false
      UNION ALL
      SELECT ref_no, booking_date, total_pkr, 'Visa' AS src FROM visa WHERE customer_code=$1 AND is_deleted=false
      UNION ALL
      SELECT ref_no, booking_date, total_pkr, 'Card' AS src FROM card WHERE customer_code=$1 AND is_deleted=false
      UNION ALL
      SELECT ref_no, booking_date, total_pkr, 'Group' AS src FROM groups WHERE customer_code=$1 AND is_deleted=false
      UNION ALL
      SELECT ref_no, booking_date, total_pkr, 'Ticketing' AS src FROM ticketing WHERE customer_code=$1 AND is_deleted=false
      UNION ALL
      SELECT ref_no, booking_date, total_pkr, 'Transport' AS src FROM transport WHERE customer_code=$1 AND is_deleted=false
      UNION ALL
      SELECT ref_no, booking_date, total_pkr, 'Ziyarat' AS src FROM ziyarat WHERE customer_code=$1 AND is_deleted=false
      `,
      [customer_code]
    );

    // Load Payments WITH Bank Join
    const paymentsRes = await db.query(
      `
      SELECT 
        cp.id, 
        cp.payment_date, 
        cp.amount, 
        cp.type, 
        cp.payment_method, 
        cp.bank_profile_id,
        b.bank_name
      FROM customer_payments cp
      LEFT JOIN public.banks b ON b.id = cp.bank_profile_id
      WHERE cp.ref_no = $1
      ORDER BY cp.payment_date, cp.id
      `,
      [customer_code]
    );

    let allEntries = [];

    // Map Sales (DEBIT) - Lene Hain
    salesRes.rows.forEach(s => {
      const amt = Math.round(Math.abs(parseFloat(s.total_pkr || 0)));
      allEntries.push({
        id: `SALE-${s.ref_no}`,
        date: s.booking_date,
        description: `Sale Invoice (${s.src}) - Ref: ${s.ref_no}`,
        debit: amt,  
        credit: 0,
        type: "sale"
      });
    });

    // Map Payments & Opening Balances
    paymentsRes.rows.forEach(p => {
      const amt = Math.round(Math.abs(parseFloat(p.amount || 0)));
      let methodDesc = p.payment_method || "";
      if (p.payment_method?.toLowerCase() === "bank" && p.bank_name) {
        methodDesc = `Bank: ${p.bank_name}`;
      }

      if (p.type === "opening_balance") {
        allEntries.push({
          id: p.id,
          date: p.payment_date,
          description: `🔑 Opening Balance (Debit Setup)`,
          debit: amt,  // Opening balance is Receivable (Debit)
          credit: 0,
          type: "opening_balance",
          bank_profile_id: p.bank_profile_id
        });
      } else {
        allEntries.push({
          id: p.id,
          date: p.payment_date,
          description: p.type === "adjustment" ? `Adjustment Receipt (${methodDesc})` : `Payment Received (${methodDesc})`,
          debit: 0,
          credit: amt, // Payments are Received (Credit)
          type: "payment",
          bank_profile_id: p.bank_profile_id
        });
      }
    });

    // Chronological Sorting Fix
    allEntries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let balance = 0;
    let filteredRows = [];

    allEntries.forEach(entry => {
      // Balance Formula: Current Balance + Debit - Credit
      balance = balance + Number(entry.debit) - Number(entry.credit);
      
      let matchDate = true;
      if (startDate && new Date(entry.date) < new Date(startDate)) matchDate = false;
      if (endDate && new Date(entry.date) > new Date(endDate)) matchDate = false;

      if (matchDate) {
        filteredRows.push({
          ...entry,
          balance: balance
        });
      }
    });

    res.json({
      success: true,
      customerName,
      rows: filteredRows,
      totalRemainingBalance: balance
    });

  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message });
  }
});

/* =====================================================
   2. GET ALL PENDING CUSTOMERS
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
      `
    );

    const validCustomerCodes = validCustomerCodesRes.rows.map(r => r.customer_code);

    if (validCustomerCodes.length === 0) {
      return res.json({ success: true, rows: [] });
    }

    const result = await db.query(
      `
      WITH all_debits AS (
        SELECT customer_code, total_pkr AS amount FROM bookings WHERE customer_code = ANY($1) AND is_deleted=false
        UNION ALL
        SELECT customer_code, total_pkr FROM hotels WHERE customer_code = ANY($1) AND is_deleted=false
        UNION ALL
        SELECT customer_code, total_pkr FROM visa WHERE customer_code = ANY($1) AND is_deleted=false
        UNION ALL
        SELECT customer_code, total_pkr FROM card WHERE customer_code = ANY($1) AND is_deleted=false
        UNION ALL
        SELECT customer_code, total_pkr FROM groups WHERE customer_code = ANY($1) AND is_deleted=false
        UNION ALL
        SELECT customer_code, total_pkr FROM ticketing WHERE customer_code = ANY($1) AND is_deleted=false
        UNION ALL
        SELECT customer_code, total_pkr FROM transport WHERE customer_code = ANY($1) AND is_deleted=false
        UNION ALL
        SELECT customer_code, total_pkr FROM ziyarat WHERE customer_code = ANY($1) AND is_deleted=false
        UNION ALL
        SELECT ref_no AS customer_code, amount FROM customer_payments WHERE ref_no = ANY($1) AND type='opening_balance'
      ),
      
      all_credits AS (
        SELECT ref_no AS customer_code, amount FROM customer_payments WHERE ref_no = ANY($1) AND type != 'opening_balance'
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
        ) n
      ),

      aggregated AS (
        SELECT 
          c.customer_code,
          COALESCE(d.total_debit, 0) AS total_sale,
          COALESCE(p.total_credit, 0) AS total_paid
        FROM (
          SELECT customer_code FROM all_debits
          UNION
          SELECT customer_code FROM all_credits
        ) c
        LEFT JOIN (SELECT customer_code, SUM(amount) AS total_debit FROM all_debits GROUP BY customer_code) d ON c.customer_code = d.customer_code
        LEFT JOIN (SELECT customer_code, SUM(amount) AS total_credit FROM all_credits GROUP BY customer_code) p ON c.customer_code = p.customer_code
      )

      SELECT 
        a.customer_code,
        COALESCE(n.customer_name, 'Registered Customer') AS customer_name,
        (a.total_sale - a.total_paid) AS remaining_balance,
        a.total_paid
      FROM aggregated a
      LEFT JOIN customer_names n ON a.customer_code = n.customer_code
      WHERE (a.total_sale - a.total_paid) != 0
      `,
      [validCustomerCodes]
    );

    let pending = result.rows.map(row => {
      const balance = Number(row.remaining_balance);
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
    });

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
  const client = await db.connect();
  try {
    const { customer_code, amount, payment_method, bank_profile_id, type, payment_date } = req.body;

    if (!customer_code) return res.json({ success: false, error: "Customer Code is required" });
    if (!amount || Number(amount) <= 0) return res.json({ success: false, error: "Amount must be greater than zero" });
    if (!payment_date) return res.json({ success: false, error: "Payment Date is required" });

    await client.query("BEGIN");
    
    await client.query(
      `
      INSERT INTO customer_payments (ref_no, amount, payment_method, bank_profile_id, type, payment_date)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        customer_code, 
        Math.abs(parseFloat(amount)), 
        payment_method || "Cash", 
        payment_method === "Bank" ? bank_profile_id : null,
        type || "payment", 
        payment_date
      ]
    );
    await client.query("COMMIT");

    res.json({ success: true, message: "Transaction saved successfully!" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.json({ success: false, error: err.message });
  } finally {
    client.release();
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
   5. EDIT PAYMENT / ENTRY (LOOKUP BY ID WITH PASSWORD)
===================================================== */
router.put("/edit/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { password, amount, payment_date, payment_method, bank_profile_id, type } = req.body;

    if (!id || isNaN(id)) {
      return res.json({ success: false, error: "Invalid transaction ID" });
    }

    if (!amount || Number(amount) <= 0) {
      return res.json({ success: false, error: "Amount must be greater than zero" });
    }

    const passCheck = await db.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1",
      ["delete_registered_payment"]
    );

    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "Delete/Edit Password is not configured in DB." });
    }

    if (password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Invalid Authorization Password!" });
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
        Math.abs(parseFloat(amount)), 
        payment_date, 
        payment_method || "Bank", 
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
