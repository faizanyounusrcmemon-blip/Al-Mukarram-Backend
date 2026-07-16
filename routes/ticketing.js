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
// SAVE / UPDATE (WITH CUSTOMER_CODE)
// ========================
router.post("/save", async (req, res) => {
  try {
    const {
      ref_no,
      customer_code,        // ⚡ Naya customer_code accept kiya
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
          customer_code,    -- ⚡ Added column
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
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        `,
        [
          finalRef,
          customer_code || null, // ⚡ Nullable for manual/walk-in users
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
          customer_code=$1, -- ⚡ Added field update
          customer_name=$2,
          booking_date=$3,

          flight_from=$4,
          flight_to=$5,
          flight_date=$6,
          airline=$7,

          adult_qty=$8,
          adult_rate=$9,
          child_qty=$10,
          child_rate=$11,
          infant_qty=$12,
          infant_rate=$13,

          total_sar=$14,
          pkr_rate=$15,
          total_pkr=$16
        WHERE ref_no=$17
        `,
        [
          customer_code || null,
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
// SOFT DELETE WITH PURCHASE / PAYMENT CHECK & SYSTEM PASSWORD LOOKUP
// ===================================
router.delete("/delete/:ref_no", async (req, res) => {
  try {
    const { ref_no } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.json({ success: false, message: "❌ Delete password is required!" });
    }

    const passCheck = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'delete_pass'"
    );
    
    if (passCheck.rows.length === 0) {
      return res.json({ success: false, message: "❌ Delete password configuration not found in database!" });
    }

    const currentDeletePass = passCheck.rows[0].password_val;

    if (password !== currentDeletePass) {
      return res.json({ success: false, message: "❌ Incorrect Delete Password! Access Denied 😎" });
    }

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