const express = require("express");
const router = express.Router();
const db = require("../db");

// AUTO REF
async function generateRef() {
  const q = await db.query("SELECT nextval('transport_ref_seq') AS no");
  return "TRN-" + String(q.rows[0].no).padStart(5, "0");
}

// ========================
// SAVE / UPDATE
// ========================
router.post("/save", async (req, res) => {
  try {
    const {
      ref_no,
      customer_name,
      booking_date,
      rows,
      total_sar,
      pkr_rate,
      total_pkr,
    } = req.body;

    let finalRef = ref_no;

    if (!finalRef) {
      finalRef = await generateRef();

      await db.query(
        `
        INSERT INTO transport
        (ref_no, customer_name, booking_date, rows, total_sar, pkr_rate, total_pkr)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        `,
        [
          finalRef,
          customer_name,
          booking_date,
          JSON.stringify(rows || []),
          total_sar,
          pkr_rate,
          total_pkr,
        ]
      );
    } else {
      await db.query(
        `
        UPDATE transport SET
          customer_name=$1,
          booking_date=$2,
          rows=$3,
          total_sar=$4,
          pkr_rate=$5,
          total_pkr=$6
        WHERE ref_no=$7
        `,
        [
          customer_name,
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
    console.error("TRANSPORT SAVE ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

// ========================
// GET BY REF
// ========================
router.get("/get/:ref", async (req, res) => {
  const q = await db.query(
    "SELECT * FROM transport WHERE ref_no=$1 AND is_deleted=false",
    [req.params.ref]
  );

  if (q.rows.length === 0)
    return res.json({ success: false });

  res.json({ success: true, row: q.rows[0] });
});

// ===================================
// SOFT DELETE WITH PURCHASE / PAYMENT CHECK & SYSTEM PASSWORD LOOKUP (TRANSPORT)
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

// DELETED VIEW
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


