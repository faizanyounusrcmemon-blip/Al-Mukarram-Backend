const express = require("express");
const router = express.Router();
const db = require("../db");

// ============================================
// AUTO REF NO GENERATOR
// ============================================
async function generateRefNo() {
  const q = await db.query("SELECT nextval('card_ref_seq') AS no");
  return "CARD-" + String(q.rows[0].no).padStart(5, "0");
}

// ============================================
// SAVE / UPDATE CARD
// ============================================
router.post("/save", async (req, res) => {
  try {
    const {
      ref_no,
      customer_code, // ⚡ React dropdown se empty ya code aayega
      customer_name,
      booking_date,
      rows,
      pkr_rate,
    } = req.body;

    // 🔹 CALCULATED FIELDS
    const totalPersons = (rows || []).reduce((s, r) => s + Number(r.persons || 0), 0);
    const totalSAR = (rows || []).reduce((s, r) => s + Number(r.total || 0), 0);
    const totalPKR = totalSAR * (Number(pkr_rate) || 0);

    let finalRef = ref_no;

    // ⚡ Logic: code available hai to registered, warna null (Walk-In)
    const finalCustomerCode = customer_code || null;
    const finalStatus = finalCustomerCode ? "CLEARED" : "PENDING";

    if (!finalRef) {
      // 🔹 NEW INSERT
      finalRef = await generateRefNo();

      await db.query(
        `INSERT INTO card
         (ref_no, customer_code, customer_name, booking_date, rows, persons, total_sar, pkr_rate, total_pkr, payment_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          finalRef,
          finalCustomerCode,
          customer_name,
          booking_date,
          JSON.stringify(rows || []),
          totalPersons,
          totalSAR,
          pkr_rate,
          totalPKR,
          finalStatus
        ]
      );
    } else {
      // 🔹 UPDATE EXISTING
      await db.query(
        `UPDATE card SET
           customer_code=$1,
           customer_name=$2,
           booking_date=$3,
           rows=$4,
           persons=$5,
           total_sar=$6,
           pkr_rate=$7,
           total_pkr=$8,
           payment_status=$9
         WHERE ref_no=$10`,
        [
          finalCustomerCode,
          customer_name,
          booking_date,
          JSON.stringify(rows || []),
          totalPersons,
          totalSAR,
          pkr_rate,
          totalPKR,
          finalStatus,
          finalRef,
        ]
      );
    }

    res.json({ success: true, ref_no: finalRef });
  } catch (err) {
    console.error("CARD SAVE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========================
// GET BY REF
// ========================
router.get("/get/:ref", async (req, res) => {
  try {
    const q = await db.query(
      "SELECT * FROM card WHERE ref_no=$1 AND is_deleted=false",
      [req.params.ref]
    );

    if (q.rows.length === 0)
      return res.json({ success: false });

    res.json({ success: true, row: q.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===================================
// SOFT DELETE
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
      return res.json({ success: false, message: "❌ Delete password config not found in DB!" });
    }

    const currentDeletePass = passCheck.rows[0].password_val;

    if (password !== currentDeletePass) {
      return res.json({ success: false, message: "❌ Incorrect Destruction Override Password!" });
    }

    const purchaseCheck = await db.query(
      `SELECT SUM(purchase_pkr) AS total FROM purchase_entries WHERE ref_no = $1 AND is_deleted = false`,
      [ref_no]
    );

    if (purchaseCheck.rows[0].total > 0) {
      return res.json({
        success: false,
        message: "❌ Cannot delete. Purchase entries exist for this ref."
      });
    }

    const paymentCheck = await db.query(
      `SELECT SUM(amount) AS total FROM customer_payments WHERE ref_no = $1 AND type = 'payment'`,
      [ref_no]
    );

    if (paymentCheck.rows[0].total > 0) {
      return res.json({
        success: false,
        message: "❌ Cannot delete. Payment has been received for this ref."
      });
    }

    const q = await db.query(
      `UPDATE card SET is_deleted = true WHERE ref_no = $1 RETURNING ref_no`,
      [ref_no]
    );

    if (!q.rows.length) {
      return res.json({ success: false, error: "Card not found" });
    }

    res.json({ success: true, message: "✅ Soft deleted successfully" });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;