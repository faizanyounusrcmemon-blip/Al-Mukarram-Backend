const express = require("express");
const router = express.Router();
const db = require("../db");

// ⚡ SMART AUTO REF NO GENERATOR (Handles Deleted & Existing Gaps for Card)
async function generateRefNo() {
  // Database me se (Active + Deleted) sab se bada numeric Ref No dhoondo
  const q = await db.query(`
    SELECT MAX(CAST(SUBSTRING(ref_no FROM 'CARD-([0-9]+)') AS INTEGER)) AS max_no 
    FROM card
  `);

  const lastNo = q.rows[0].max_no || 0;
  const nextNo = lastNo + 1;

  // Sync sequence to avoid gaps if sequence is used elsewhere
  await db.query(`
    CREATE SEQUENCE IF NOT EXISTS card_ref_seq START WITH 1 INCREMENT BY 1;
    SELECT setval('card_ref_seq', $1, false);
  `, [nextNo]).catch(() => {});

  return "CARD-" + String(nextNo).padStart(5, "0");
}

// ============================================
// SAVE / UPDATE CARD (UPDATED WITH SUB_CUSTOMER_NAME)
// ============================================
router.post("/save", async (req, res) => {
  try {
    const {
      ref_no,
      customer_code,
      customer_name,
      sub_customer_name, // ⚡ ADDED SUB_CUSTOMER_NAME
      booking_date,
      rows,
      pkr_rate,
    } = req.body;

    // CALCULATED FIELDS
    const totalPersons = (rows || []).reduce((s, r) => s + Number(r.persons || 0), 0);
    const totalSAR = (rows || []).reduce((s, r) => s + Number(r.total || 0), 0);
    const totalPKR = totalSAR * (Number(pkr_rate) || 0);

    let finalRef = ref_no;

    const finalCustomerCode = customer_code || null;
    const finalStatus = finalCustomerCode ? "CLEARED" : "PENDING";

    if (!finalRef) {
      // Auto-fix primary key sequence before inserting new record
      await db.query(`
        SELECT setval(
          COALESCE(pg_get_serial_sequence('card', 'id'), 'card_id_seq'), 
          COALESCE((SELECT MAX(id) FROM card), 0) + 1, 
          false
        );
      `).catch(() => {});

      // NEW INSERT WITH SUB CUSTOMER NAME
      finalRef = await generateRefNo();

      await db.query(
        `INSERT INTO card
         (ref_no, customer_code, customer_name, sub_customer_name, booking_date, rows, persons, total_sar, pkr_rate, total_pkr, payment_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          finalRef,
          finalCustomerCode,
          customer_name,
          sub_customer_name || null,
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
      // UPDATE EXISTING WITH SUB CUSTOMER NAME
      await db.query(
        `UPDATE card SET
           customer_code=$1,
           customer_name=$2,
           sub_customer_name=$3,
           booking_date=$4,
           rows=$5,
           persons=$6,
           total_sar=$7,
           pkr_rate=$8,
           total_pkr=$9,
           payment_status=$10
         WHERE ref_no=$11`,
        [
          finalCustomerCode,
          customer_name,
          sub_customer_name || null,
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
      return res.json({ success: false, message: "❌ Incorrect Delete Password! Access Denied 😎" });
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

// ========================
// DELETED VIEW
// ========================
router.get("/get-deleted/:ref", async (req, res) => {
  try {
    const q = await db.query(
      "SELECT * FROM card WHERE ref_no=$1 AND is_deleted=true",
      [req.params.ref]
    );

    if (!q.rows.length) return res.json({ success: false });

    res.json({ success: true, row: q.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
