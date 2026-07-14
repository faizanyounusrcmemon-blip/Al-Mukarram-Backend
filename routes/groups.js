const express = require("express");
const router = express.Router();
const db = require("../db");

// ============================================
// AUTO REF NO GENERATOR
// ============================================
async function generateRefNo() {
  const q = await db.query("SELECT nextval('groups_ref_seq') AS no");
  return "GRP-" + String(q.rows[0].no).padStart(5, "0");
}

// ============================================
// SAVE / UPDATE GROUPS (UPDATED WITH DATES)
// ============================================
router.post("/save", async (req, res) => {
  try {
    const {
      ref_no,
      customer_name,
      booking_date,
      start_date,    // 🔹 Added
      end_date,      // 🔹 Added
      duration,      // 🔹 Added
      rows,
      pkr_rate,
    } = req.body;

    // 🔹 CALCULATED FIELDS
    const totalPersons = (rows || []).reduce((s, r) => s + Number(r.persons || 0), 0);
    const totalSAR = (rows || []).reduce((s, r) => s + Number(r.total || 0), 0);
    const totalPKR = totalSAR * (Number(pkr_rate) || 0);

    let finalRef = ref_no;

    if (!finalRef) {
      // 🔹 NEW INSERT WITH DATES
      finalRef = await generateRefNo();

      await db.query(
        `INSERT INTO groups
         (ref_no, customer_name, booking_date, start_date, end_date, duration, rows, persons, total_sar, pkr_rate, total_pkr)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          finalRef,
          customer_name,
          booking_date,
          start_date,  // $4
          end_date,    // $5
          duration,    // $6
          JSON.stringify(rows || []),
          totalPersons,
          totalSAR,
          pkr_rate,
          totalPKR,
        ]
      );
    } else {
      // 🔹 UPDATE EXISTING WITH DATES
      await db.query(
        `UPDATE groups SET
           customer_name=$1,
           booking_date=$2,
           start_date=$3,
           end_date=$4,
           duration=$5,
           rows=$6,
           persons=$7,
           total_sar=$8,
           pkr_rate=$9,
           total_pkr=$10
         WHERE ref_no=$11`,
        [
          customer_name,
          booking_date,
          start_date,
          end_date,
          duration,
          JSON.stringify(rows || []),
          totalPersons,
          totalSAR,
          pkr_rate,
          totalPKR,
          finalRef,
        ]
      );
    }

    res.json({ success: true, ref_no: finalRef });
  } catch (err) {
    console.error("GROUPS SAVE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========================
// GET BY REF
// ========================
router.get("/get/:ref", async (req, res) => {
  const q = await db.query(
    "SELECT * FROM groups WHERE ref_no=$1 AND is_deleted=false",
    [req.params.ref]
  );

  if (q.rows.length === 0)
    return res.json({ success: false });

  res.json({ success: true, row: q.rows[0] });
});

// ===================================
// SOFT DELETE WITH PURCHASE / PAYMENT CHECK & PASSWORD LOOKUP
// ===================================
router.delete("/delete/:ref_no", async (req, res) => {
  try {
    const { ref_no } = req.params;
    // 1. Frontend se password receive karna (req.body se)
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
      return res.json({ success: false, message: "❌ Delete password config not found in DB!" });
    }

    const currentDeletePass = passCheck.rows[0].password_val;

    // Validate if password matches
    if (password !== currentDeletePass) {
      return res.json({ success: false, message: "❌ Incorrect Destruction Override Password!" });
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
      `UPDATE groups
       SET is_deleted = true
       WHERE ref_no = $1
       RETURNING ref_no`,
      [ref_no]
    );

    if (!q.rows.length) {
      return res.json({ success: false, error: "Groups not found" });
    }

    res.json({ success: true, message: "✅ Soft deleted successfully" });

  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});


module.exports = router;
