const express = require("express");
const router = express.Router();
const db = require("../db");

/* =====================================================
   HELPERS: CUSTOMER TOTAL SALES & PAYMENTS (USING ref_no FOR CUSTOMER CODE)
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
  return Number(sale.rows[0]?.total_sale || 0);
}

/* =====================================================
   HELPERS: CUSTOMER TOTAL SALES & PAYMENTS (INCLUDING ADJUSTMENTS)
===================================================== */
async function getRegCustomerPayments(customer_code) {
  const paid = await db.query(
    `
    SELECT COALESCE(SUM(amount), 0) AS paid
    FROM customer_payments
    WHERE ref_no=$1
    -- Yahan se humne check hata diya hai taake 'payment' aur 'adjustment' dono count hon
    `,
    [customer_code]
  );
  return Number(paid.rows[0]?.paid || 0);
}

/* =====================================================
   1. REGISTERED LEDGER DETAIL (LOOKUP BY ref_no)
===================================================== */
router.get("/detail/:customer_code", async (req, res) => {
  try {
    const { customer_code } = req.params;
    const { startDate, endDate } = req.query;

    let balance = 0;
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

    // Load Sales
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

    // Load Payments (Filtering with ref_no instead of customer_code)
    const paymentsRes = await db.query(
      `
      SELECT id, payment_date, amount, type, payment_method 
      FROM customer_payments 
      WHERE ref_no=$1
      `,
      [customer_code]
    );

    let allEntries = [];

    // Map Sales
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

    // Map Payments
    paymentsRes.rows.forEach(p => {
      const amt = Math.round(Number(p.amount || 0));
      allEntries.push({
        id: p.id,
        date: p.payment_date,
        description: p.type === "adjustment" ? "Adjustment Receipt" : `Payment Received (${p.payment_method || ""})`,
        debit: amt,
        credit: 0,
        type: "payment"
      });
    });

    allEntries.sort((a, b) => new Date(a.date) - new Date(b.date));

    let filteredRows = [];
    allEntries.forEach(entry => {
      balance = balance + entry.credit - entry.debit;
      
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
    const activeCusts = await db.query(
      `
      SELECT DISTINCT customer_code, customer_name
      FROM (
        SELECT customer_code, customer_name FROM bookings WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
        UNION ALL
        SELECT customer_code, customer_name FROM hotels WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
        UNION ALL
        SELECT customer_code, customer_name FROM visa WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
        UNION ALL
        SELECT customer_code, customer_name FROM card WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
        UNION ALL
        SELECT customer_code, customer_name FROM groups WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
        UNION ALL
        SELECT customer_code, customer_name FROM ticketing WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
        UNION ALL
        SELECT customer_code, customer_name FROM transport WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
        UNION ALL
        SELECT customer_code, customer_name FROM ziyarat WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      ) x
      `
    );

    let pending = [];
    for (let row of activeCusts.rows) {
      const totalSale = await getRegCustomerSale(row.customer_code);
      const totalPaid = await getRegCustomerPayments(row.customer_code);

      if (totalSale > totalPaid) {
        pending.push({
          customer_code: row.customer_code,
          customer_name: row.customer_name || "Registered Customer",
          remaining_balance: totalSale - totalPaid,
          payment_status: totalPaid === 0 ? "PENDING" : "PARTIAL"
        });
      }
    }

    res.json({ success: true, rows: pending });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* =====================================================
   3. SAVE REGISTERED CUSTOMER PAYMENT (SAVING CUSTOMER_CODE IN ref_no)
===================================================== */
router.post("/payment", async (req, res) => {
  const client = await db.connect();
  try {
    const { customer_code, amount, payment_method, type, payment_date } = req.body;

    if (!customer_code) return res.json({ success: false, error: "Customer Code is required" });
    if (!amount || Number(amount) <= 0) return res.json({ success: false, error: "Amount must be greater than zero" });
    if (!payment_date) return res.json({ success: false, error: "Payment Date is required" });

    await client.query("BEGIN");
    
    // Yahan hum ref_no ke andar customer_code ko pass kar rahe hain! No new columns!
    await client.query(
      `
      INSERT INTO customer_payments (ref_no, amount, payment_method, type, payment_date)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [customer_code, amount, payment_method, type, payment_date]
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
    res.json({ success: true, message: "Payment entry deleted successfully" });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;