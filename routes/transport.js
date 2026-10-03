const express = require("express");
const router = express.Router();
const db = require("../db");

// ⚡ SMART AUTO REF NO GENERATOR (Handles Deleted & Existing Gaps)
async function generateRef() {
  // Database me se (Active + Deleted) sab se bada numeric Ref No dhoondo
  const q = await db.query(`
    SELECT MAX(CAST(SUBSTRING(ref_no FROM 'TRN-([0-9]+)') AS INTEGER)) AS max_no 
    FROM transport
  `);

  const lastNo = q.rows[0].max_no || 0;
  const nextNo = lastNo + 1;

  // Sync sequence to avoid gaps if sequence is used elsewhere
  await db.query(`
    CREATE SEQUENCE IF NOT EXISTS transport_ref_seq START WITH 1 INCREMENT BY 1;
    SELECT setval('transport_ref_seq', $1, false);
  `, [nextNo]).catch(() => {});

  return "TRN-" + String(nextNo).padStart(5, "0");
}

// ============================================
// SAVE / UPDATE TRANSPORT
// ============================================
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

    const finalSAR = total_sar !== undefined ? total_sar : (rows || []).reduce((s, r) => s + Number(r.total || 0), 0);
    const finalPKR = total_pkr !== undefined ? total_pkr : finalSAR * (Number(pkr_rate) || 0);

    let finalRef = ref_no;

    // 🔹 CASE 1: Agar NEW Record hai (ref_no is null/empty)
    if (!finalRef) {
      finalRef = await generateRef();

      await db.query(
        `INSERT INTO transport
         (ref_no, customer_code, customer_name, sub_customer_name, booking_date, rows, total_sar, pkr_rate, total_pkr)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          finalRef,
          customer_code || null,
          customer_name,
          sub_customer_name || null,
          booking_date,
          JSON.stringify(rows || []),
          finalSAR,
          pkr_rate,
          finalPKR,
        ]
      );
    } else {
      // 🔹 CASE 2: Agar UPDATE karna hai, toh pehle check karo Ref Exist & Not Deleted!
      const checkRef = await db.query("SELECT is_deleted FROM transport WHERE ref_no=$1", [finalRef]);

      if (checkRef.rows.length === 0) {
        return res.status(400).json({ success: false, error: `❌ Ref No ${finalRef} does not exist.` });
      }

      if (checkRef.rows[0].is_deleted) {
        return res.status(400).json({ success: false, error: `❌ Cannot update ${finalRef}. It is deleted!` });
      }

      await db.query(
        `UPDATE transport SET
           customer_code=$1,
           customer_name=$2,
           sub_customer_name=$3,
           booking_date=$4,
           rows=$5,
           total_sar=$6,
           pkr_rate=$7,
           total_pkr=$8
         WHERE ref_no=$9 AND is_deleted=false`,
        [
          customer_code || null,
          customer_name,
          sub_customer_name || null,
          booking_date,
          JSON.stringify(rows || []),
          finalSAR,
          pkr_rate,
          finalPKR,
          finalRef,
        ]
      );
    }

    res.json({ success: true, ref_no: finalRef });

  } catch (err) {
    console.error("TRANSPORT SAVE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========================
// GET BY REF
// ========================
router.get("/get/:ref", async (req, res) => {
  try {
    const q = await db.query(
      "SELECT * FROM transport WHERE ref_no=$1 AND is_deleted=false",
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
      `UPDATE transport
       SET is_deleted = true
       WHERE ref_no = $1
       RETURNING ref_no`,
      [ref_no]
    );

    if (!q.rows.length) {
      return res.json({ success: false, error: "Transport not found" });
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
      "SELECT * FROM transport WHERE ref_no=$1 AND is_deleted=true",
      [req.params.ref]
    );

    if (!q.rows.length) return res.json({ success: false });

    res.json({ success: true, row: q.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
