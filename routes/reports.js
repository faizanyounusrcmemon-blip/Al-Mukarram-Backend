const express = require("express");
const router = express.Router();
const db = require("../db");

/* =====================================================
   🔹 COMMON CUSTOMER SOURCE (ALL MODULES)
===================================================== */
const CUSTOMER_SQL = `
  SELECT ref_no, customer_name FROM bookings
  UNION ALL
  SELECT ref_no, customer_name FROM hotels
  UNION ALL
  SELECT ref_no, customer_name FROM visa
  UNION ALL
  SELECT ref_no, customer_name FROM card
  UNION ALL
  SELECT ref_no, customer_name FROM groups
  UNION ALL
  SELECT ref_no, customer_name FROM ticketing
  UNION ALL
  SELECT ref_no, customer_name FROM transport
  UNION ALL
  SELECT ref_no, customer_name FROM ziyarat
`;


/* =====================================================
   ✅ SALE ADJUSTMENT REPORT (FINAL FIX)
===================================================== */
router.get("/sale-adjustments", async (req, res) => {
  try {
    const sql = `
      WITH sales AS (
        SELECT ref_no, total_pkr FROM bookings WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, total_pkr FROM hotels WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, total_pkr FROM visa WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, total_pkr FROM card WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, total_pkr FROM groups WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, total_pkr FROM ticketing WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, total_pkr FROM transport WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, total_pkr FROM ziyarat WHERE is_deleted=false
      ),
      sale_sum AS (
        SELECT ref_no, SUM(total_pkr) AS amount
        FROM sales
        GROUP BY ref_no
      )
      SELECT
        cp.id,
        cp.payment_date AS date,
        cp.ref_no,
        c.customer_name,
        cp.payment_method,
        COALESCE(ss.amount, 0)        AS amount,
        COALESCE(cp.amount, 0)        AS adjustment_amount,
        COALESCE(ss.amount, 0) - COALESCE(cp.amount, 0) AS net_amount
      FROM customer_payments cp

      LEFT JOIN sale_sum ss
        ON ss.ref_no = cp.ref_no

      LEFT JOIN (
        SELECT ref_no, customer_name FROM bookings
        UNION ALL
        SELECT ref_no, customer_name FROM hotels
        UNION ALL
        SELECT ref_no, customer_name FROM visa
        UNION ALL
        SELECT ref_no, customer_name FROM card
        UNION ALL
        SELECT ref_no, customer_name FROM groups
        UNION ALL
        SELECT ref_no, customer_name FROM ticketing
        UNION ALL
        SELECT ref_no, customer_name FROM transport
        UNION ALL
        SELECT ref_no, customer_name FROM ziyarat
      ) c ON c.ref_no = cp.ref_no

      WHERE cp.type = 'adjustment'
      ORDER BY cp.payment_date DESC, cp.id DESC
    `;

    const { rows } = await db.query(sql);
    res.json({ success: true, rows });

  } catch (err) {
    console.error("SALE ADJUSTMENT ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

/* =========================================
   SUPPLIER ADJUSTMENT (WITH DATE)
========================================= */
router.get("/supplier-adjustment-only", async (req, res) => {
  try {
    const { from, to } = req.query;

    let dateFilter = "";
    let params = [];

    if (from && to) {
      params.push(from);
      params.push(to);
      dateFilter = ` AND sp.payment_date BETWEEN $1 AND $2 `;
    }

    const q = await db.query(
      `
      SELECT
        s.id AS supplier_id,
        s.supplier_code,
        s.supplier_name,
        sp.payment_date,
        sp.amount AS adjustment_amount

      FROM suppliers s
      JOIN supplier_payments sp
        ON sp.supplier_id = s.id

      WHERE (
        LOWER(sp.payment_method) = 'adjustment'
        OR LOWER(sp.type) = 'adjustment'
      )
      ${dateFilter}

      ORDER BY sp.payment_date DESC
      `,
      params
    );

    res.json({
      success: true,
      rows: q.rows
    });

  } catch (err) {
    console.error("SUPPLIER ADJUSTMENT ERROR:", err);
    res.status(500).json({ success:false, error: err.message });
  }
});

/* =====================================================
   🔹 ALL REPORTS (UNCHANGED)
===================================================== */
router.get("/all", async (req, res) => {
  try {
    const q = await db.query(`
      SELECT 'Packages' AS type, id, ref_no, customer_name, booking_date, total_pkr
      FROM bookings WHERE is_deleted=false

      UNION ALL
      SELECT 'Ticketing', id, ref_no, customer_name, booking_date, total_pkr
      FROM ticketing WHERE is_deleted=false

      UNION ALL
      SELECT 'Hotels', id, ref_no, customer_name, booking_date, total_pkr
      FROM hotels WHERE is_deleted=false

      UNION ALL
      SELECT 'Visa', id, ref_no, customer_name, booking_date, total_pkr
      FROM visa WHERE is_deleted=false

      UNION ALL
      SELECT 'Card', id, ref_no, customer_name, booking_date, total_pkr
      FROM card WHERE is_deleted=false

      UNION ALL
      SELECT 'Groups', id, ref_no, customer_name, booking_date, total_pkr
      FROM groups WHERE is_deleted=false

      UNION ALL
      SELECT 'Transport', id, ref_no, customer_name, booking_date, total_pkr
      FROM transport WHERE is_deleted=false

      UNION ALL
      SELECT 'Ziyarat', id, ref_no, customer_name, booking_date, total_pkr
      FROM ziyarat WHERE is_deleted=false

      ORDER BY booking_date DESC
    `);

    res.json(q.rows);
  } catch (err) {
    console.error("REPORTS ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =====================================================
   🔹 SUPPLIER WISE PURCHASE REPORT
   - Fetch from purchase_entries
   - Supplier list from suppliers table
===================================================== */
router.get("/supplier-purchase", async (req, res) => {
  try {
    const query = `
      SELECT
        p.id,
        p.ref_no,
        p.item,

        /* SALE */
        p.sale_sar,
        p.sale_rate,
        p.sale_pkr,

        /* PURCHASE */
        p.purchase_sar,
        p.purchase_rate,
        p.purchase_pkr,

        /* PROFIT */
        (COALESCE(p.sale_pkr,0) - COALESCE(p.purchase_pkr,0)) AS profit,

        p.created_at AS booking_date,
        s.supplier_name
      FROM purchase_entries p
      LEFT JOIN suppliers s
        ON s.supplier_code = p.supplier_code
      WHERE p.is_deleted = false
        AND (p.purchase_sar > 0 OR p.purchase_rate > 0)  -- ✅ یہ شرط
      ORDER BY p.created_at DESC
    `;

    const { rows } = await db.query(query);

    const sup = await db.query(`
      SELECT supplier_name
      FROM suppliers
      WHERE is_deleted = false
      ORDER BY supplier_name
    `);

    res.json({
      success: true,
      rows,
      suppliers: ["ALL", ...sup.rows.map(s => s.supplier_name)]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});




/* =====================================================
   🔐 AUTHORITY CONTROL FOR ALLREPORTS TODAY (DATABASE PERSISTED)
===================================================== */

// Helper function to get days from DB (Aapki new authority_settings table ke mutabik)
async function getAccessDaysFromDB() {
  try {
    // 🔍 public.authority_settings table se 'allowed_access_days' ka record uthaya
    const res = await db.query(
      "SELECT value FROM public.authority_settings WHERE key = 'allowed_access_days'"
    );
    
    if (res.rows.length > 0 && res.rows[0].value !== null) {
      return parseInt(res.rows[0].value, 10) || 7;
    }
    return 7; // Database fallback agar setting row na mile
  } catch (err) {
    console.error("Error fetching access days from DB:", err);
    return 7; // Error code fallback
  }
}

/* =====================================================
   🔍 GET CURRENT AUTHORITY DAYS FOR BADGE DISPLAY
===================================================== */
router.get("/authority/get-days", async (req, res) => {
  try {
    const currentDays = await getAccessDaysFromDB();
    res.json({ success: true, days: currentDays });
  } catch (err) {
    console.error("GET AUTHORITY DAYS ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =====================================================
   ✅ UPDATE AUTHORITY DAYS (system_passwords se lookup)
===================================================== */
router.post("/authority/update-days", async (req, res) => {
  const { days, password } = req.body;
  
  if (!days || !password) {
    return res.status(400).json({ success: false, message: "Missing required attributes!" });
  }

  try {
    // 🔍 FIX: Seedha public.system_passwords table se 'authority_pass' ka password_val check karega
    const passCheck = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'authority_pass'"
    );
    
    if (passCheck.rows.length === 0) {
      return res.status(444).json({ success: false, message: "Authority password key setup not found in DB!" });
    }

    const currentAuthorityPass = passCheck.rows[0].password_val;

    // Frontend se aaye password ko DB wale password ('786f') se match karega
    if (password !== currentAuthorityPass) {
      return res.status(403).json({ success: false, message: "Invalid Authority Security Password! 😎" });
    }

    // Naye days ko public.authority_settings table mein save karega
    await db.query(
      `INSERT INTO public.authority_settings (key, value) 
       VALUES ('allowed_access_days', $1) 
       ON CONFLICT (key) 
       DO UPDATE SET value = $1`,
      [parseInt(days, 10)]
    );

    res.json({ success: true, message: "Authority timeline configuration updated successfully." });
  } catch (err) {
    console.error("UPDATE AUTHORITY DAYS ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =====================================================
   🔹 3. GET RESTRICTED DATA FOR EMPLOYEES
===================================================== */
router.get("/today-restricted", async (req, res) => {
  try {
    // New dynamic database values ke sath filtered rows uthayega
    const currentDays = await getAccessDaysFromDB(); 

    const sql = `
      SELECT 'Packages' AS type, id, ref_no, customer_name, booking_date, total_pkr, created_at
      FROM bookings WHERE is_deleted=false AND created_at >= NOW() - (INTERVAL '1 day' * $1)
      UNION ALL
      SELECT 'Ticketing', id, ref_no, customer_name, booking_date, total_pkr, created_at
      FROM ticketing WHERE is_deleted=false AND created_at >= NOW() - (INTERVAL '1 day' * $1)
      UNION ALL
      SELECT 'Hotels', id, ref_no, customer_name, booking_date, total_pkr, created_at
      FROM hotels WHERE is_deleted=false AND created_at >= NOW() - (INTERVAL '1 day' * $1)
      UNION ALL
      SELECT 'Visa', id, ref_no, customer_name, booking_date, total_pkr, created_at
      FROM visa WHERE is_deleted=false AND created_at >= NOW() - (INTERVAL '1 day' * $1)
      UNION ALL
      SELECT 'Card', id, ref_no, customer_name, booking_date, total_pkr, created_at
      FROM card WHERE is_deleted=false AND created_at >= NOW() - (INTERVAL '1 day' * $1)
      UNION ALL
      SELECT 'Groups', id, ref_no, customer_name, booking_date, total_pkr, created_at
      FROM groups WHERE is_deleted=false AND created_at >= NOW() - (INTERVAL '1 day' * $1)
      UNION ALL
      SELECT 'Transport', id, ref_no, customer_name, booking_date, total_pkr, created_at
      FROM transport WHERE is_deleted=false AND created_at >= NOW() - (INTERVAL '1 day' * $1)
      UNION ALL
      SELECT 'Ziyarat', id, ref_no, customer_name, booking_date, total_pkr, created_at
      FROM ziyarat WHERE is_deleted=false AND created_at >= NOW() - (INTERVAL '1 day' * $1)
      ORDER BY created_at DESC
    `;
    
    const q = await db.query(sql, [currentDays]);
    res.json(q.rows);
  } catch (err) {
    console.error("RESTRICTED REPORTS ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});




module.exports = router;