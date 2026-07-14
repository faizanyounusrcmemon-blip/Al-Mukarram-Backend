const express = require("express");
const router = express.Router();
const db = require("../db");

// ========================
// AUTO REF NO
// ========================
async function generateRefNo() {
  const q = await db.query("SELECT nextval('ticketing_ref_seq') AS no");
  return "TIC-" + String(q.rows[0].no).padStart(5, "0");
}

// ========================
// SAVE / UPDATE (WITH AIRLINE)
// ========================
router.post("/save", async (req, res) => {
  try {
    const {
      ref_no,
      customer_name,
      booking_date,
      flights,              // [{from,to,date,airline}]
      adultQty,
      adultRate,
      childQty,
      childRate,
      infantQty,
      infantRate,
      total_sar,
      pkr_rate,
      total_pkr,
    } = req.body;

    let finalRef = ref_no;

    // ========================
    // NEW ENTRY
    // ========================
    if (!finalRef) {
      finalRef = await generateRefNo();

      await db.query(
        `
        INSERT INTO ticketing
        (
          ref_no,
          customer_name,
          booking_date,

          flight_from,
          flight_to,
          flight_date,
          airline,

          adult_qty,
          adult_rate,
          child_qty,
          child_rate,
          infant_qty,
          infant_rate,

          total_sar,
          pkr_rate,
          total_pkr
        )
        VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        `,
        [
          finalRef,
          customer_name,
          booking_date,

          JSON.stringify(flights.map(f => f.from)),
          JSON.stringify(flights.map(f => f.to)),
          JSON.stringify(flights.map(f => f.date)),
          JSON.stringify(flights.map(f => f.airline || "")),

          adultQty,
          adultRate,
          childQty,
          childRate,
          infantQty,
          infantRate,

          total_sar,
          pkr_rate,
          total_pkr,
        ]
      );
    }

    // ========================
    // EDIT ENTRY
    // ========================
    else {
      await db.query(
        `
        UPDATE ticketing SET
          customer_name=$1,
          booking_date=$2,

          flight_from=$3,
          flight_to=$4,
          flight_date=$5,
          airline=$6,

          adult_qty=$7,
          adult_rate=$8,
          child_qty=$9,
          child_rate=$10,
          infant_qty=$11,
          infant_rate=$12,

          total_sar=$13,
          pkr_rate=$14,
          total_pkr=$15
        WHERE ref_no=$16
        `,
        [
          customer_name,
          booking_date,

          JSON.stringify(flights.map(f => f.from)),
          JSON.stringify(flights.map(f => f.to)),
          JSON.stringify(flights.map(f => f.date)),
          JSON.stringify(flights.map(f => f.airline || "")),

          adultQty,
          adultRate,
          childQty,
          childRate,
          infantQty,
          infantRate,

          total_sar,
          pkr_rate,
          total_pkr,
          finalRef,
        ]
      );
    }

    res.json({ success: true, ref_no: finalRef });

  } catch (err) {
    console.error("TICKETING SAVE ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

// ========================
// GET BY REF (EDIT / VIEW)
// ========================
router.get("/get/:ref", async (req, res) => {
  const q = await db.query(
    "SELECT * FROM ticketing WHERE ref_no=$1 AND is_deleted=false",
    [req.params.ref]
  );

  if (!q.rows.length)
    return res.json({ success: false });

  res.json({ success: true, row: q.rows[0] });
});

// ===================================
// SOFT DELETE WITH PURCHASE / PAYMENT CHECK & SYSTEM PASSWORD LOOKUP (TICKETING)
// ===================================
router.delete("/delete/:ref_no", async (req, res) => {
  try {
    const { ref_no } = req.params;
    // 🌟 Frontend se bheja gaya password req.body se nikala
    const { password } = req.body;

    if (!password) {
      return res.json({ success: false, message: "❌ Delete password is required!" });
    }

    // ===============================================
    // 🔍 LIVE PASSWORD LOOKUP FROM system_passwords TABLE
    // ===============================================
    const passCheck = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'delete_pass'"
    );
    
    if (passCheck.rows.length === 0) {
      return res.json({ success: false, message: "❌ Delete password configuration not found in database!" });
    }

    const currentDeletePass = passCheck.rows[0].password_val;

    // Validate if entered password matches the database value
    if (password !== currentDeletePass) {
      return res.json({ success: false, message: "❌ Incorrect Delete Password! Access Denied 😎" });
    }

    // ===============================
    // CHECK IF PURCHASE ENTRIES EXIST
    // ===============================
    const purchaseCheck = await db.query(
      `SELECT SUM(purchase_pkr) AS total
       FROM purchase_entries
       WHERE ref_no = $1 AND is_deleted = false`,
      [ref_no]
    );

    if (purchaseCheck.rows[0].total > 0) {
      return res.json({
        success: false,
        message: "❌ Cannot delete. Purchase entries exist for this ref. Delete purchases first."
      });
    }

    // ===============================
    // CHECK IF PAYMENT RECEIVED
    // ===============================
    const paymentCheck = await db.query(
      `SELECT SUM(amount) AS total
       FROM customer_payments
       WHERE ref_no = $1 AND type = 'payment'`,
      [ref_no]
    );

    if (paymentCheck.rows[0].total > 0) {
      return res.json({
        success: false,
        message: "❌ Cannot delete. Payment has been received for this ref. Adjust/delete payments first."
      });
    }

    // ===============================
    // SOFT DELETE
    // ===============================
    const q = await db.query(
      `
      UPDATE ticketing
      SET is_deleted = true
      WHERE ref_no = $1
      RETURNING ref_no
      `,
      [ref_no]
    );

    if (!q.rows.length) {
      return res.json({ success: false, error: "Ticketing not found" });
    }

    res.json({ success: true, message: "✅ Soft deleted successfully" });

  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

// DELETED VIEW
router.get("/get-deleted/:ref", async (req, res) => {
  try {
    const q = await db.query(
      "SELECT * FROM ticketing WHERE ref_no=$1 AND is_deleted=true",
      [req.params.ref]
    );

    if (!q.rows.length) return res.json({ success: false });

    res.json({ success: true, row: q.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


module.exports = router;


