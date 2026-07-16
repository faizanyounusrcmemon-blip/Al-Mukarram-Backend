const express = require("express");
const router = express.Router();
const db = require("../db");

// ===================================
// AUTO REF GENERATOR
// ===================================
async function generateRef() {
  const q = await db.query("SELECT nextval('hotels_ref_seq') AS no");
  return "HOT-" + String(q.rows[0].no).padStart(5, "0");
}

// ===================================
// SAVE / UPDATE HOTEL
// ===================================
router.post("/save", async (req, res) => {
  try {
    const {
      ref_no,
      customer_code,        // ⚡ Naya customer_code accept kiya
      customer_name,
      agent_name,          
      booking_date,
      hotels,
      hotels_total,
      sar_rate,
      total_pkr,
    } = req.body;

    // =========================
    // EDIT MODE (UPDATE)
    // =========================
    if (ref_no) {
      await db.query(
        `
        UPDATE hotels SET
          customer_code=$2, -- ⚡ Database mapping added
          customer_name=$3,
          agent_name=$4,
          booking_date=$5,
          hotel_checkin=$6,
          hotel_checkout=$7,
          hotel_nights=$8,
          hotel_location=$9,
          hotel_name=$10,
          hotel_rooms=$11,
          hotel_type=$12,
          hotel_rate=$13,
          hotel_total=$14,
          hotels_total=$15,
          sar_rate=$16,
          total_pkr=$17
        WHERE ref_no=$1
        `,
        [
          ref_no,                                       // $1
          customer_code || null,                        // ⚡ $2
          customer_name,                                // $3
          agent_name,                                   // $4
          booking_date,                                 // $5
          JSON.stringify(hotels.map(h => h.checkIn)),   // $6
          JSON.stringify(hotels.map(h => h.checkOut)),  // $7
          JSON.stringify(hotels.map(h => h.nights)),    // $8
          JSON.stringify(hotels.map(h => h.location)),  // $9
          JSON.stringify(hotels.map(h => h.hotel)),     // $10
          JSON.stringify(hotels.map(h => h.rooms)),     // $11
          JSON.stringify(hotels.map(h => h.type)),      // $12
          JSON.stringify(hotels.map(h => h.rate)),      // $13
          JSON.stringify(hotels.map(h => h.total)),     // $14
          hotels_total,                                 // $15
          sar_rate,                                     // $16
          total_pkr,                                    // $17
        ]
      );

      return res.json({ success: true, ref_no });
    }

    // =========================
    // NEW MODE (INSERT)
    // =========================
    const newRef = await generateRef();

    await db.query(
      `
      INSERT INTO hotels
      (
        ref_no,
        customer_code,    -- ⚡ Column mapping
        customer_name,
        agent_name,
        booking_date,
        hotel_checkin,
        hotel_checkout,
        hotel_nights,
        hotel_location,
        hotel_name,
        hotel_rooms,
        hotel_type,
        hotel_rate,
        hotel_total,
        hotels_total,
        sar_rate,
        total_pkr
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      `,
      [
        newRef,                                     // $1
        customer_code || null,                      // ⚡ $2
        customer_name,                              // $3
        agent_name,                                 // $4
        booking_date,                               // $5
        JSON.stringify(hotels.map(h => h.checkIn)), // $6
        JSON.stringify(hotels.map(h => h.checkOut)),// $7
        JSON.stringify(hotels.map(h => h.nights)),  // $8
        JSON.stringify(hotels.map(h => h.location)),// $9
        JSON.stringify(hotels.map(h => h.hotel)),   // $10
        JSON.stringify(hotels.map(h => h.rooms)),   // $11
        JSON.stringify(hotels.map(h => h.type)),    // $12
        JSON.stringify(hotels.map(h => h.rate)),    // $13
        JSON.stringify(hotels.map(h => h.total)),   // $14
        hotels_total,                               // $15
        sar_rate,                                   // $16
        total_pkr,                                  // $17
      ]
    );

    res.json({ success: true, ref_no: newRef });

  } catch (err) {
    console.error("HOTEL SAVE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===================================
// GET HOTEL BY REF (EDIT + VOUCHER)
// ===================================
router.get("/get/:ref", async (req, res) => {
  const q = await db.query(
    "SELECT * FROM hotels WHERE ref_no=$1 AND is_deleted=false",
    [req.params.ref]
  );

  if (q.rows.length === 0) {
    return res.json({ success: false });
  }

  const r = q.rows[0];

  const hotels = r.hotel_name.map((_, i) => ({
    hotel: r.hotel_name[i],
    location: r.hotel_location[i],
    checkIn: r.hotel_checkin[i],
    checkOut: r.hotel_checkout[i],
    nights: r.hotel_nights[i],
    rooms: r.hotel_rooms[i],
    type: r.hotel_type[i],
    rate: r.hotel_rate[i],
    total: r.hotel_total[i],
  }));

  res.json({
    success: true,
    row: {
      ref_no: r.ref_no,
      customer_code: r.customer_code || "", // ⚡ Sent code in payload response
      customer_name: r.customer_name,
      agent_name: r.agent_name || "",   
      booking_date: r.booking_date,
      hotels,
      hotels_total: r.hotels_total,
      sar_rate: r.sar_rate,
      total_pkr: r.total_pkr,
    },
  });
});

// ===================================
// DELETE (SOFT) WITH PURCHASE/PAYMENT CHECK & SYSTEM PASSWORD LOOKUP
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
      UPDATE hotels
      SET is_deleted = true
      WHERE ref_no = $1
      RETURNING ref_no
      `,
      [ref_no]
    );

    if (!q.rows.length) {
      return res.json({ success: false, error: "Hotel not found" });
    }

    res.json({ success: true, message: "✅ Soft deleted successfully" });

  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

// DELETED VIEW
router.get("/get-deleted/:ref_no", async (req, res) => {
  try {
    const { ref_no } = req.params;

    const q = await db.query(
      `
      SELECT *
      FROM hotels
      WHERE ref_no=$1 AND is_deleted=true
      `,
      [ref_no]
    );

    if (!q.rows.length) {
      return res.json({ success: false, error: "Deleted hotel not found" });
    }

    const r = q.rows[0];

    // 🔥 ARRAY → OBJECT CONVERSION
    const hotels = (r.hotel_name || []).map((name, i) => ({
      hotel: name || "",
      location: r.hotel_location?.[i] || "",
      type: r.hotel_type?.[i] || "",
      rooms: r.hotel_rooms?.[i] || 0,
      nights: r.hotel_nights?.[i] || 0,
      rate: r.hotel_rate?.[i] || 0,
      total: r.hotel_total?.[i] || 0,
      checkIn: r.hotel_checkin?.[i] || "",
      checkOut: r.hotel_checkout?.[i] || "",
    }));

    // ✅ FINAL RESPONSE
    res.json({
      success: true,
      row: {
        ...r,
        hotels, // 🔥 IMPORTANT
      },
    });

  } catch (err) {
    console.error("GET DELETED HOTEL ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;

