const express = require("express");
const router = express.Router();
const db = require("../db");

// ⚡ SMART AUTO REF NO GENERATOR (Handles Deleted & Existing Gaps)
async function generateRef() {
  const q = await db.query(`
    SELECT MAX(CAST(SUBSTRING(ref_no FROM 'ZIY-([0-9]+)') AS INTEGER)) AS max_no 
    FROM ziyarat
  `);

  const lastNo = q.rows[0].max_no || 0;
  const nextNo = lastNo + 1;

  await db.query(`
    CREATE SEQUENCE IF NOT EXISTS ziyarat_ref_seq START WITH 1 INCREMENT BY 1;
    SELECT setval('ziyarat_ref_seq', $1, false);
  `, [nextNo]).catch(() => {});

  return "ZIY-" + String(nextNo).padStart(5, "0");
}



// ========================
// SAVE / UPDATE
// ========================
router.post("/save", async (req, res) => {
  try {
    const {
      ref_no,
      customer_code,
      customer_name,
      sub_customer_name,
      booking_date,
      rows,
      total_sar,
      pkr_rate,
      total_pkr,
    } = req.body;

    let finalRef = ref_no;

    if (!finalRef) {
      // ⚡ Primary Key Auto-Increment Sync Fix
      await db.query(`
        SELECT setval(
          COALESCE(pg_get_serial_sequence('ziyarat', 'id'), 'ziyarat_id_seq'), 
          COALESCE((SELECT MAX(id) FROM ziyarat), 0) + 1, 
          false
        );
      `).catch(() => {});

      // 🔹 NEW INSERT (Generates clean incremental ZIY-XXXXX Ref)
      finalRef = await generateRef();

      await db.query(
        `
        INSERT INTO ziyarat
        (ref_no, customer_code, customer_name, sub_customer_name, booking_date, rows, total_sar, pkr_rate, total_pkr)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          finalRef,
          customer_code || null,
          customer_name,
          sub_customer_name || null,
          booking_date,
          JSON.stringify(rows || []),
          total_sar,
          pkr_rate,
          total_pkr,
        ]
      );
    } else {
      // 🔹 UPDATE EXISTING RECORD
      await db.query(
        `
        UPDATE ziyarat SET
          customer_code=$1,
          customer_name=$2,
          sub_customer_name=$3,
          booking_date=$4,
          rows=$5,
          total_sar=$6,
          pkr_rate=$7,
          total_pkr=$8
        WHERE ref_no=$9
        `,
        [
          customer_code || null,
          customer_name,
          sub_customer_name || null,
          booking_date,
          JSON.stringify(rows || []),
          total_sar,
          pkr_rate,
          total_pkr,
          finalRef,
        ]
      );
    }

    res.json({ success: true, ref_no: finalRef });

  } catch (err) {
    console.error("ZIYARAT SAVE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});



// ========================
// GET BY REF
// ========================
router.get("/get/:ref", async (req, res) => {
  try {
    const q = await db.query(
      "SELECT * FROM ziyarat WHERE ref_no=$1 AND is_deleted=false",
      [req.params.ref]
    );

    if (!q.rows.length) return res.json({ success: false });

    res.json({ success: true, row: q.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===================================
// SOFT DELETE WITH PURCHASE / PAYMENT CHECK & SYSTEM PASSWORD LOOKUP (ZIYARAT)
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
      `UPDATE ziyarat
       SET is_deleted = true
       WHERE ref_no = $1
       RETURNING ref_no`,
      [ref_no]
    );

    if (!q.rows.length) {
      return res.json({ success: false, error: "Ziyarat not found" });
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
      "SELECT * FROM ziyarat WHERE ref_no=$1 AND is_deleted=true",
      [req.params.ref]
    );

    if (!q.rows.length) return res.json({ success: false });

    res.json({ success: true, row: q.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
