const express = require("express");
const router = express.Router();
const db = require("../db");

// ============================================
// AUTO REF NO GENERATOR
// ============================================
async function generateRefNo() {
  const q = await db.query("SELECT nextval('booking_ref_seq') AS no");
  const no = q.rows[0].no;
  return "PKG-" + String(no).padStart(5, "0");
}

// ============================================
// SAVE BOOKING (NEW + EDIT)
// ============================================
router.post("/save", async (req, res) => {
  try {
    const d = req.body;

    // ===============================
    // EDIT MODE (UPDATE)
// ===============================
    if (d.ref_no) {
      await db.query(
        `
        UPDATE bookings SET
          customer_name=$2,
          contact_no=$3,
          booking_date=$4,

          adult_count=$5,
          adult_rate=$6,
          child_count=$7,
          child_rate=$8,
          infant_count=$9,
          infant_rate=$10,
          flight_total=$11,

          flights=$12::jsonb,
          hotels=$13::jsonb,
          hotels_total=$14,

          visa=$15::jsonb,

          transport=$16::jsonb,
          transport_total=$17,

          ziyarat=$18::jsonb,
          ziyarat_total=$19,

          flight_sar_total=$20,
          hotel_sar_total=$21,
          visa_sar_total=$22,
          transport_sar_total=$23,
          ziyarat_sar_total=$24,

          flight_sar_rate=$25,
          hotel_sar_rate=$26,
          visa_sar_rate=$27,
          transport_sar_rate=$28,
          ziyarat_sar_rate=$29,

          flight_pkr_total=$30,
          hotel_pkr_total=$31,
          visa_pkr_total=$32,
          transport_pkr_total=$33,
          ziyarat_pkr_total=$34,

          net_pkr_total=$35,
          total_sar=$36,
          total_pkr=$37,
          per_person_qty=$38,
          per_person_final=$39,
          adult_per_person=$40,
          child_per_person=$41,
          infant_per_person=$42

        WHERE ref_no=$1
        `,
        [
          d.ref_no,
          d.customer_name,
          d.contact_no,
          d.booking_date,

          d.adult_count,
          d.adult_rate,
          d.child_count,
          d.child_rate,
          d.infant_count,
          d.infant_rate,
          d.flight_total,

          JSON.stringify(d.flights || []),
          JSON.stringify(d.hotels || []),
          d.hotels_total,

          JSON.stringify(d.visa || []),

          JSON.stringify(d.transport || []),
          d.transport_total,

          JSON.stringify(d.ziyarat || []),
          d.ziyarat_total,

          d.flight_sar_total,
          d.hotel_sar_total,
          d.visa_sar_total,
          d.transport_sar_total,
          d.ziyarat_sar_total,

          d.flight_sar_rate,
          d.hotel_sar_rate,
          d.visa_sar_rate,
          d.transport_sar_rate,
          d.ziyarat_sar_rate,

          d.flight_pkr_total,
          d.hotel_pkr_total,
          d.visa_pkr_total,
          d.transport_pkr_total,
          d.ziyarat_pkr_total,

          d.net_pkr_total,
          d.total_sar,
          d.total_pkr,
          d.per_person_qty,
          d.per_person_final,
          d.adult_per_person,
          d.child_per_person,
          d.infant_per_person
        ]
      );

      return res.json({ success: true, ref_no: d.ref_no });
    }

    // ===============================
    // NEW MODE (INSERT)
// ===============================
    const ref_no = await generateRefNo();

    await db.query(
      `
      INSERT INTO bookings (
        ref_no, customer_name, contact_no, booking_date,

        adult_count, adult_rate, child_count, child_rate,
        infant_count, infant_rate, flight_total,

        flights, hotels, hotels_total,

        visa,

        transport, transport_total,

        ziyarat, ziyarat_total,

        flight_sar_total, hotel_sar_total, visa_sar_total,
        transport_sar_total, ziyarat_sar_total,

        flight_sar_rate, hotel_sar_rate, visa_sar_rate,
        transport_sar_rate, ziyarat_sar_rate,

        flight_pkr_total, hotel_pkr_total, visa_pkr_total,
        transport_pkr_total, ziyarat_pkr_total,

        net_pkr_total, total_sar, total_pkr,
        per_person_qty, per_person_final, adult_per_person, child_per_person, infant_per_person
      )
      VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,$8,
        $9,$10,$11,
        $12::jsonb,$13::jsonb,$14,
        $15::jsonb,
        $16::jsonb,$17,
        $18::jsonb,$19,
        $20,$21,$22,$23,$24,
        $25,$26,$27,$28,$29,
        $30,$31,$32,$33,$34,
        $35,$36,$37,
        $38,$39,$40,$41,$42
      )
      `,
      [
        ref_no,
        d.customer_name,
        d.contact_no,
        d.booking_date,

        d.adult_count,
        d.adult_rate,
        d.child_count,
        d.child_rate,
        d.infant_count,
        d.infant_rate,
        d.flight_total,

        JSON.stringify(d.flights || []),
        JSON.stringify(d.hotels || []),
        d.hotels_total,

        JSON.stringify(d.visa || []),

        JSON.stringify(d.transport || []),
        d.transport_total,

        JSON.stringify(d.ziyarat || []),
        d.ziyarat_total,

        d.flight_sar_total,
        d.hotel_sar_total,
        d.visa_sar_total,
        d.transport_sar_total,
        d.ziyarat_sar_total,

        d.flight_sar_rate,
        d.hotel_sar_rate,
        d.visa_sar_rate,
        d.transport_sar_rate,
        d.ziyarat_sar_rate,

        d.flight_pkr_total,
        d.hotel_pkr_total,
        d.visa_pkr_total,
        d.transport_pkr_total,
        d.ziyarat_pkr_total,

        d.net_pkr_total,
        d.total_sar,
        d.total_pkr,
        d.per_person_qty,
        d.per_person_final,
        d.adult_per_person,
        d.child_per_person,
        d.infant_per_person
      ]
    );

    res.json({ success: true, ref_no });

  } catch (err) {
    console.error("SAVE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// GET ALL BOOKINGS
// ============================================
router.get("/list", async (req, res) => {
  const q = await db.query(
    "SELECT * FROM bookings WHERE is_deleted = false ORDER BY id DESC"
  );
  res.json(q.rows);
});

// ============================================
// GET BOOKING BY REF (EDIT)
// ============================================
router.get("/get/:ref", async (req, res) => {
  try {
    const q = await db.query(
      "SELECT * FROM bookings WHERE ref_no=$1 AND is_deleted=false",
      [req.params.ref]
    );

    if (!q.rows.length) return res.json({ success: false });

    res.json({ success: true, row: q.rows[0] });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ============================================
// HOTEL VOUCHER
// ============================================
router.get("/voucher/:ref", async (req, res) => {
  const q = await db.query(
    "SELECT ref_no, customer_name, booking_date, hotels FROM bookings WHERE ref_no=$1",
    [req.params.ref]
  );

  if (!q.rows.length) return res.json({ success: false });

  res.json({ success: true, ...q.rows[0] });
});

// ============================================
// SOFT DELETE WITH PURCHASE / PAYMENT CHECK & SYSTEM PASSWORD LOOKUP (BOOKINGS)
// ============================================
router.delete("/delete/:ref", async (req, res) => {
  try {
    const { ref } = req.params;
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
      [ref]
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
      [ref]
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
      `UPDATE bookings
       SET is_deleted = true
       WHERE ref_no = $1
       RETURNING ref_no`,
      [ref]
    );

    if (!q.rows.length) {
      return res.json({ success: false, error: "Booking not found" });
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
      "SELECT * FROM bookings WHERE ref_no=$1 AND is_deleted=true",
      [req.params.ref]
    );

    if (!q.rows.length) return res.json({ success: false });

    res.json({ success: true, row: q.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


module.exports = router;
