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
   ✅ SALE ADJUSTMENT REPORT (DYNAMIC REG & WALK-IN FIX)
===================================================== */
router.get("/sale-adjustments", async (req, res) => {
  try {
    const sql = `
      WITH sales AS (
        SELECT ref_no, customer_code, total_pkr FROM bookings WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, customer_code, total_pkr FROM hotels WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, customer_code, total_pkr FROM visa WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, customer_code, total_pkr FROM card WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, customer_code, total_pkr FROM groups WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, customer_code, total_pkr FROM ticketing WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, customer_code, total_pkr FROM transport WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, customer_code, total_pkr FROM ziyarat WHERE is_deleted=false
      ),
      
      -- Walk-in customers ki sale lookup by ref_no
      sale_sum_walkin AS (
        SELECT ref_no, SUM(total_pkr) AS amount
        FROM sales
        GROUP BY ref_no
      ),

      -- Registered customers ki sale lookup by customer_code
      sale_sum_registered AS (
        SELECT customer_code, SUM(total_pkr) AS amount
        FROM sales
        WHERE customer_code IS NOT NULL AND customer_code != ''
        GROUP BY customer_code
      )

      SELECT
        cp.id,
        cp.payment_date AS date,
        cp.ref_no,
        cp.payment_method,
        
        -- DYNAMIC NAME LOOKUP
        COALESCE(
          CASE 
            WHEN cp.ref_no LIKE 'CUST-%' THEN
              (SELECT customer_name FROM (
                 SELECT customer_name FROM bookings WHERE customer_code = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
                 UNION ALL
                 SELECT customer_name FROM hotels WHERE customer_code = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
                 UNION ALL
                 SELECT customer_name FROM visa WHERE customer_code = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
                 UNION ALL
                 SELECT customer_name FROM card WHERE customer_code = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
                 UNION ALL
                 SELECT customer_name FROM groups WHERE customer_code = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
                 UNION ALL
                 SELECT customer_name FROM ticketing WHERE customer_code = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
                 UNION ALL
                 SELECT customer_name FROM transport WHERE customer_code = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
                 UNION ALL
                 SELECT customer_name FROM ziyarat WHERE customer_code = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
               ) reg_cust LIMIT 1)
            ELSE
              (SELECT customer_name FROM (
                 SELECT customer_name FROM bookings WHERE ref_no = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
                 UNION ALL
                 SELECT customer_name FROM hotels WHERE ref_no = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
                 UNION ALL
                 SELECT customer_name FROM visa WHERE ref_no = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
                 UNION ALL
                 SELECT customer_name FROM card WHERE ref_no = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
                 UNION ALL
                 SELECT customer_name FROM groups WHERE ref_no = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
                 UNION ALL
                 SELECT customer_name FROM ticketing WHERE ref_no = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
                 UNION ALL
                 SELECT customer_name FROM transport WHERE ref_no = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
                 UNION ALL
                 SELECT customer_name FROM ziyarat WHERE ref_no = cp.ref_no AND customer_name IS NOT NULL AND customer_name != ''
               ) walkin_cust LIMIT 1)
          END, 'Unknown Customer'
        ) AS customer_name,

        -- DYNAMIC TOTAL SALE AMOUNT LOOKUP
        ROUND(COALESCE(
          CASE 
            WHEN cp.ref_no LIKE 'CUST-%' THEN ss_reg.amount
            ELSE ss_walk.amount
          END, 0)::numeric, 0) AS amount,

        ROUND(COALESCE(cp.amount, 0)::numeric, 0) AS adjustment_amount,

        ROUND((COALESCE(
          CASE 
            WHEN cp.ref_no LIKE 'CUST-%' THEN ss_reg.amount
            ELSE ss_walk.amount
          END, 0) - COALESCE(cp.amount, 0))::numeric, 0) AS net_amount

      FROM customer_payments cp

      -- Left join with Walk-in Sales
      LEFT JOIN sale_sum_walkin ss_walk
        ON ss_walk.ref_no = cp.ref_no

      -- Left join with Registered Sales
      LEFT JOIN sale_sum_registered ss_reg
        ON ss_reg.customer_code = cp.ref_no

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
   🔹 ALL REPORTS (WITH REGISTERED / WALK-IN IDENTIFIER)
===================================================== */
router.get("/all", async (req, res) => {
  try {
    const q = await db.query(`
      SELECT 
        'Packages' AS type, id, ref_no, customer_name, sub_customer_name, customer_code, booking_date, total_pkr,
        CASE 
          WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered'
          ELSE 'Walk-in'
        END AS customer_type
      FROM bookings WHERE is_deleted=false

      UNION ALL
      SELECT 
        'Ticketing', id, ref_no, customer_name, sub_customer_name, customer_code, booking_date, total_pkr,
        CASE 
          WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered'
          ELSE 'Walk-in'
        END AS customer_type
      FROM ticketing WHERE is_deleted=false

      UNION ALL
      SELECT 
        'Hotels', id, ref_no, customer_name, sub_customer_name, customer_code, booking_date, total_pkr,
        CASE 
          WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered'
          ELSE 'Walk-in'
        END AS customer_type
      FROM hotels WHERE is_deleted=false

      UNION ALL
      SELECT 
        'Visa', id, ref_no, customer_name, sub_customer_name, customer_code, booking_date, total_pkr,
        CASE 
          WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered'
          ELSE 'Walk-in'
        END AS customer_type
      FROM visa WHERE is_deleted=false

      UNION ALL
      SELECT 
        'Card', id, ref_no, customer_name, sub_customer_name, customer_code, booking_date, total_pkr,
        CASE 
          WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered'
          ELSE 'Walk-in'
        END AS customer_type
      FROM card WHERE is_deleted=false

      UNION ALL
      SELECT 
        'Groups', id, ref_no, customer_name, sub_customer_name, customer_code, booking_date, total_pkr,
        CASE 
          WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered'
          ELSE 'Walk-in'
        END AS customer_type
      FROM groups WHERE is_deleted=false

      UNION ALL
      SELECT 
        'Transport', id, ref_no, customer_name, sub_customer_name, customer_code, booking_date, total_pkr,
        CASE 
          WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered'
          ELSE 'Walk-in'
        END AS customer_type
      FROM transport WHERE is_deleted=false

      UNION ALL
      SELECT 
        'Ziyarat', id, ref_no, customer_name, sub_customer_name, customer_code, booking_date, total_pkr,
        CASE 
          WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered'
          ELSE 'Walk-in'
        END AS customer_type
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


/* =====================================================
    🔹 CUSTOMER SALE DETAIL REPORT (DIRECT FROM SALES TABLES)
    - Fetches registered active customers from customers table
===================================================== */
router.get("/customer-sale", async (req, res) => {
  try {
    const rows = [];

    // 1. Registered Active Customers List (Code + Name)
    const custRes = await db.query(
      `SELECT customer_code AS code, name FROM customers WHERE is_deleted = false ORDER BY name ASC`
    );
    const customerList = custRes.rows; // [{ code: 'CUST-001', name: 'MARFANI TRAVELS' }, ...]

    // 2. BOOKINGS (PACKAGES)
    const pkgRes = await db.query(
      `SELECT * FROM bookings WHERE is_deleted = false ORDER BY booking_date DESC`
    );
    pkgRes.rows.forEach((s) => {
      let airline = "", from = "", to = "";
      if (Array.isArray(s.flights) && s.flights.length > 0) {
        const f = s.flights[0];
        airline = f.airline || f.airline_name || "";
        from = f.from || f.flight_from || "";
        to = f.to || f.flight_to || "";
      }
      const routeText = from && to ? `${from} → ${to}` : "";
      const extraInfo = [airline, routeText].filter(Boolean).join(" | ");

      const cCode = s.customer_code || "WALKIN";

      // Tickets
      if (s.adult_count > 0) {
        const sar = s.adult_count * s.adult_rate;
        const rate = Number(s.flight_sar_rate) || 0;
        rows.push({
          booking_date: s.booking_date,
          customer_code: cCode,
          customer_name: s.customer_name || "Walk-in Customer",
          ref_no: s.ref_no,
          item: `Ticket – Adult (${s.adult_count} Person${s.adult_count > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: sar * rate,
        });
      }
      if (s.child_count > 0) {
        const sar = s.child_count * s.child_rate;
        const rate = Number(s.flight_sar_rate) || 0;
        rows.push({
          booking_date: s.booking_date,
          customer_code: cCode,
          customer_name: s.customer_name || "Walk-in Customer",
          ref_no: s.ref_no,
          item: `Ticket – Child (${s.child_count} Person${s.child_count > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: sar * rate,
        });
      }
      if (s.infant_count > 0) {
        const sar = s.infant_count * s.infant_rate;
        const rate = Number(s.flight_sar_rate) || 0;
        rows.push({
          booking_date: s.booking_date,
          customer_code: cCode,
          customer_name: s.customer_name || "Walk-in Customer",
          ref_no: s.ref_no,
          item: `Ticket – Infant (${s.infant_count} Person${s.infant_count > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: sar * rate,
        });
      }

      // Hotels
      if (Array.isArray(s.hotels)) {
        s.hotels.forEach((h, i) => {
          const rooms = Number(h.rooms) || 0;
          const nights = Number(h.nights) || 0;
          const type = h.type ? h.type.toUpperCase() : "";
          const sar = Number(h.total) || 0;
          const rate = Number(s.hotel_sar_rate) || 0;
          rows.push({
            booking_date: s.booking_date,
            customer_code: cCode,
            customer_name: s.customer_name || "Walk-in Customer",
            ref_no: s.ref_no,
            item: `Hotel ${i + 1} - ${h.hotel || ""} (${type}${type ? ", " : ""}${rooms} Room${rooms > 1 ? "s" : ""}, ${nights} Night${nights > 1 ? "s" : ""})`,
            sale_sar: sar,
            sale_rate: rate,
            sale_pkr: sar * rate,
          });
        });
      }

      // Visa
      if (Array.isArray(s.visa)) {
        s.visa.forEach((v, i) => {
          const persons = Number(v.persons || 0);
          const rateVal = Number(v.rate || 0);
          const sar = Number(v.total ?? (persons * rateVal));
          const rate = Number(s.visa_sar_rate) || 0;
          rows.push({
            booking_date: s.booking_date,
            customer_code: cCode,
            customer_name: s.customer_name || "Walk-in Customer",
            ref_no: s.ref_no,
            item: v.type ? `Visa ${i + 1} - ${v.type} (${persons} Person${persons > 1 ? "s" : ""})` : `Visa ${i + 1} (${persons} Person${persons > 1 ? "s" : ""})`,
            sale_sar: sar,
            sale_rate: rate,
            sale_pkr: sar * rate,
          });
        });
      }

      // Transport (With Date & Detail)
      if (Array.isArray(s.transport)) {
        s.transport.forEach((t, i) => {
          const base = `Transport ${i + 1}`;
          const label = t.text || t.route || t.description || "";

          // DD/MMM/YYYY Date Formatting
          let formattedDate = "";
          if (t.date) {
            const d = new Date(t.date);
            if (!isNaN(d.getTime())) {
              const day = String(d.getDate()).padStart(2, "0");
              const mon = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
              const year = d.getFullYear();
              formattedDate = ` (${day}/${mon}/${year})`;
            }
          }

          const sar = Number(t.amount) || 0;
          const rate = Number(s.transport_sar_rate) || 0;

          rows.push({
            booking_date: s.booking_date,
            customer_code: cCode,
            customer_name: s.customer_name || "Walk-in Customer",
            ref_no: s.ref_no,
            item: label ? `${base}${formattedDate} - ${label}` : `${base}${formattedDate}`,
            sale_sar: sar,
            sale_rate: rate,
            sale_pkr: sar * rate,
          });
        });
      }

      // Ziyarat (With Label Detail)
      if (Array.isArray(s.ziyarat)) {
        s.ziyarat.forEach((t, i) => {
          const base = `Ziyarat ${i + 1}`;
          const label = t.text || t.route || t.description || "";
          const sar = Number(t.amount) || 0;
          const rate = Number(s.ziyarat_sar_rate) || 0;

          rows.push({
            booking_date: s.booking_date,
            customer_code: cCode,
            customer_name: s.customer_name || "Walk-in Customer",
            ref_no: s.ref_no,
            item: label ? `${base} - ${label}` : base,
            sale_sar: sar,
            sale_rate: rate,
            sale_pkr: sar * rate,
          });
        });
      }

      // ========= AGENT COMMISSION =========
      if (s.show_agent_comm) {
        if (Array.isArray(s.agent_comm) && s.agent_comm.length > 0) {
          s.agent_comm.forEach((ac, i) => {
            const persons = Number(ac.persons || ac.qty || 1);
            const ratePkr = Number(ac.rate || ac.rate_pkr || 0);
            const totalPkr = Number(ac.total || ac.amount || (persons * ratePkr) || 0);

            const agentName = ac.agent_name || ac.name || ac.title || ac.type || "";
            const personText = ` (${persons} Person${persons > 1 ? "s" : ""})`;

            rows.push({
              booking_date: s.booking_date,
              customer_code: cCode,
              customer_name: s.customer_name || "Walk-in Customer",
              ref_no: s.ref_no,
              item: agentName 
                ? `Agent Commission ${i + 1} - ${agentName}${personText}` 
                : `Agent Commission ${i + 1}${personText}`,
              sale_sar: totalPkr,
              sale_rate: 1,
              sale_pkr: totalPkr,
            });
          });
        } else if (Number(s.agent_comm_total) > 0) {
          const totalPkr = Number(s.agent_comm_total);
          rows.push({
            booking_date: s.booking_date,
            customer_code: cCode,
            customer_name: s.customer_name || "Walk-in Customer",
            ref_no: s.ref_no,
            item: `Agent Commission`,
            sale_sar: totalPkr,
            sale_rate: 1,
            sale_pkr: totalPkr,
          });
        }
      }
    });

    // 3. HOTELS ONLY (HOT-)
    const hotRes = await db.query(
      `SELECT * FROM hotels WHERE is_deleted = false ORDER BY booking_date DESC`
    );
    hotRes.rows.forEach((r) => {
      const cCode = r.customer_code || "WALKIN";
      (r.hotel_name || []).forEach((name, i) => {
        const type = r.hotel_type?.[i] ? r.hotel_type[i].toUpperCase() : "";
        const rooms = Number(r.hotel_rooms?.[i]) || 0;
        const nights = Number(r.hotel_nights?.[i]) || 0;
        const sar = Number(r.hotel_total?.[i]) || 0;
        const rate = Number(r.sar_rate) || 0;
        rows.push({
          booking_date: r.booking_date,
          customer_code: cCode,
          customer_name: r.customer_name || "Walk-in Customer",
          ref_no: r.ref_no,
          item: `Hotel ${i + 1} - ${name} (${type}${type ? ", " : ""}${rooms} Room${rooms > 1 ? "s" : ""}, ${nights} Night${nights > 1 ? "s" : ""})`,
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: sar * rate,
        });
      });
    });

    // 4. VISA ONLY (VISA-)
    const visaRes = await db.query(
      `SELECT * FROM visa WHERE is_deleted = false ORDER BY booking_date DESC`
    );
    visaRes.rows.forEach((v) => {
      const cCode = v.customer_code || "WALKIN";
      (v.rows || []).forEach((r, i) => {
        const sar = Number(r.total) || Number(r.persons * r.rate) || 0;
        const rate = Number(v.pkr_rate) || 0;
        rows.push({
          booking_date: v.booking_date,
          customer_code: cCode,
          customer_name: v.customer_name || "Walk-in Customer",
          ref_no: v.ref_no,
          item: r.type ? `Visa ${i + 1} - ${r.type} (${r.persons} Person${r.persons > 1 ? "s" : ""})` : `Visa (${r.persons} Person${r.persons > 1 ? "s" : ""})`,
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: sar * rate,
        });
      });
    });

    // 5. CARD ONLY (CARD-)
    const cardRes = await db.query(
      `SELECT * FROM card WHERE is_deleted = false ORDER BY booking_date DESC`
    );
    cardRes.rows.forEach((v) => {
      const cCode = v.customer_code || "WALKIN";
      (v.rows || []).forEach((r, i) => {
        const sar = Number(r.total) || Number(r.persons * r.rate) || 0;
        const rate = Number(v.pkr_rate) || 0;
        rows.push({
          booking_date: v.booking_date,
          customer_code: cCode,
          customer_name: v.customer_name || "Walk-in Customer",
          ref_no: v.ref_no,
          item: r.type ? `Card ${i + 1} - ${r.type} (${r.persons} Person${r.persons > 1 ? "s" : ""})` : `Card (${r.persons} Person${r.persons > 1 ? "s" : ""})`,
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: sar * rate,
        });
      });
    });

    // 6. GROUPS ONLY (GRP-)
    const grpRes = await db.query(
      `SELECT * FROM groups WHERE is_deleted = false ORDER BY booking_date DESC`
    );
    grpRes.rows.forEach((v) => {
      const cCode = v.customer_code || "WALKIN";
      (v.rows || []).forEach((r, i) => {
        const sar = Number(r.total) || Number(r.persons * r.rate) || 0;
        const rate = Number(v.pkr_rate) || 0;
        rows.push({
          booking_date: v.booking_date,
          customer_code: cCode,
          customer_name: v.customer_name || "Walk-in Customer",
          ref_no: v.ref_no,
          item: r.type ? `Groups ${i + 1} - ${r.type} (${r.persons} Person${r.persons > 1 ? "s" : ""})` : `Groups (${r.persons} Person${r.persons > 1 ? "s" : ""})`,
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: sar * rate,
        });
      });
    });

    // 7. TICKETING ONLY (TIC-)
    const ticRes = await db.query(
      `SELECT * FROM ticketing WHERE is_deleted = false ORDER BY booking_date DESC`
    );
    ticRes.rows.forEach((r) => {
      const cCode = r.customer_code || "WALKIN";
      const from = Array.isArray(r.flight_from) ? r.flight_from.join(", ") : r.flight_from || "";
      const to = Array.isArray(r.flight_to) ? r.flight_to.join(", ") : r.flight_to || "";
      const airline = Array.isArray(r.airline) ? r.airline.join(", ") : r.airline || "";
      const routeText = from && to ? `${from} → ${to}` : "";
      const extraInfo = [airline, routeText].filter(Boolean).join(" | ");

      const rate = Number(r.pkr_rate) || 0;

      if (r.adult_qty > 0) {
        const sar = r.adult_qty * r.adult_rate;
        rows.push({
          booking_date: r.booking_date,
          customer_code: cCode,
          customer_name: r.customer_name || "Walk-in Customer",
          ref_no: r.ref_no,
          item: `Ticket – Adult (${r.adult_qty} Person${r.adult_qty > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: sar * rate,
        });
      }
      if (r.child_qty > 0) {
        const sar = r.child_qty * r.child_rate;
        rows.push({
          booking_date: r.booking_date,
          customer_code: cCode,
          customer_name: r.customer_name || "Walk-in Customer",
          ref_no: r.ref_no,
          item: `Ticket – Child (${r.child_qty} Person${r.child_qty > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: sar * rate,
        });
      }
      if (r.infant_qty > 0) {
        const sar = r.infant_qty * r.infant_rate;
        rows.push({
          booking_date: r.booking_date,
          customer_code: cCode,
          customer_name: r.customer_name || "Walk-in Customer",
          ref_no: r.ref_no,
          item: `Ticket – Infant (${r.infant_qty} Person${r.infant_qty > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: sar * rate,
        });
      }
    });

// 8. TRANSPORT ONLY (TRN-)
    const trnRes = await db.query(
      `SELECT * FROM transport WHERE is_deleted = false ORDER BY booking_date DESC`
    );
    trnRes.rows.forEach((r) => {
      const cCode = r.customer_code || "WALKIN";
      if (Array.isArray(r.rows)) {
        r.rows.forEach((t, i) => {
          const base = `Transport ${i + 1}`;
          const label = t.description || t.text || t.route || "";

          // 🔹 Traveling Date Extraction (Checking all possible property names & parent row date)
          const rawDate = t.date || t.travelDate || t.travel_date || r.date || r.travel_date;
          let formattedDate = "";
          
          if (rawDate) {
            const d = new Date(rawDate);
            if (!isNaN(d.getTime())) {
              const day = String(d.getDate()).padStart(2, "0");
              const mon = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
              const year = d.getFullYear();
              formattedDate = ` (${day}/${mon}/${year})`;
            }
          }

          const sar = Number(t.sar || t.amount) || 0;
          const rate = Number(r.pkr_rate) || 0;

          rows.push({
            booking_date: r.booking_date,
            customer_code: cCode,
            customer_name: r.customer_name || "Walk-in Customer",
            ref_no: r.ref_no,
            item: label ? `${base}${formattedDate} - ${label}` : `${base}${formattedDate}`,
            sale_sar: sar,
            sale_rate: rate,
            sale_pkr: sar * rate,
          });
        });
      }
    });

    // 9. ZIYARAT ONLY (ZIY-)
    const ziyRes = await db.query(
      `SELECT * FROM ziyarat WHERE is_deleted = false ORDER BY booking_date DESC`
    );
    ziyRes.rows.forEach((r) => {
      const cCode = r.customer_code || "WALKIN";
      if (Array.isArray(r.rows)) {
        r.rows.forEach((t, i) => {
          const base = `Ziyarat ${i + 1}`;
          const label = t.description || t.text || t.route || "";
          const sar = Number(t.sar || t.amount) || 0;
          const rate = Number(r.pkr_rate) || 0;

          rows.push({
            booking_date: r.booking_date,
            customer_code: cCode,
            customer_name: r.customer_name || "Walk-in Customer",
            ref_no: r.ref_no,
            item: label ? `${base} - ${label}` : base,
            sale_sar: sar,
            sale_rate: rate,
            sale_pkr: sar * rate,
          });
        });
      }
    });

    res.json({
      success: true,
      rows,
      customers: customerList,
    });
  } catch (err) {
    console.error("CUSTOMER SALE DETAIL REPORT ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =====================================================
   🔹 CUSTOMER SALE DETAIL LEDGER ROUTE (WITH INFANT & BANK SUPPORT)
===================================================== */
router.get("/customer-sale-detail-ledger", async (req, res) => {
  try {
    const { customer_code, from_date, to_date } = req.query;

    // 1. Fetch Registered Customers List (Ordered by Customer Code)
    const custRes = await db.query(
      `SELECT customer_code AS code, name FROM customers WHERE is_deleted = false ORDER BY customer_code ASC`
    );
    const customerList = custRes.rows;

    let rows = [];

    // 2. Fetch Latest Archive Snapshot Info
    const snapshotRes = await db.query(`
      SELECT id, date_to 
      FROM archive_snapshots 
      ORDER BY date_to DESC, id DESC 
      LIMIT 1
    `);

    let snapshotDateTo = "1970-01-01";
    let customerBaseline = 0;
    let hasSnapshot = false;

    if (snapshotRes.rows.length > 0 && customer_code && customer_code !== "ALL" && customer_code !== "WALKIN") {
      const snapshotId = snapshotRes.rows[0].id;
      snapshotDateTo = new Date(snapshotRes.rows[0].date_to).toISOString().split("T")[0];
      hasSnapshot = true;

      const custBalRes = await db.query(
        `SELECT balance FROM archive_balances WHERE snapshot_id = $1 AND UPPER(balance_type) = 'CUSTOMER' AND code = $2 LIMIT 1`,
        [snapshotId, customer_code]
      );

      if (custBalRes.rows.length > 0) {
        customerBaseline = Math.round(Number(custBalRes.rows[0].balance || 0));
      }
    }

    const isDateValid = (dateStr) => {
      if (!dateStr) return false;
      const d = new Date(dateStr).toISOString().split("T")[0];
      if (hasSnapshot && d <= snapshotDateTo) return false;
      if (from_date && d < from_date) return false;
      if (to_date && d > to_date) return false;
      return true;
    };

    const validRefsMap = new Map();

    const isCustomerValid = (cCode, cName, refNo) => {
      if (!customer_code || customer_code === "ALL") return true;
      const targetCode = (cCode || "").trim().toUpperCase();
      const filter = customer_code.trim().toUpperCase();

      if (filter === "WALKIN") {
        return !targetCode || targetCode === "WALKIN" || targetCode === "";
      }

      // Direct Code Match
      if (targetCode === filter) return true;

      // Fallback via Ref No mapping
      if (refNo) {
        const mappedCode = validRefsMap.get(refNo.trim().toUpperCase());
        if (mappedCode && mappedCode.toUpperCase() === filter) return true;
      }

      return false;
    };

    const safeParse = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      try { return JSON.parse(val); } catch { return []; }
    };

    // 3. BOOKINGS (PACKAGES) BREAKDOWN
    const pkgRes = await db.query(`SELECT * FROM bookings WHERE is_deleted = false ORDER BY booking_date ASC, id ASC`);
    pkgRes.rows.forEach((s) => {
      const cCode = s.customer_code ? s.customer_code.trim() : "";
      const cName = s.customer_name || "Walk-in Customer";
      if (s.ref_no) validRefsMap.set(s.ref_no.trim().toUpperCase(), cCode || "WALKIN");

      if (!isCustomerValid(cCode, cName, s.ref_no) || !isDateValid(s.booking_date)) return;

      const flights = safeParse(s.flights);
      let airline = "", from = "", to = "";
      if (flights.length > 0) {
        const f = flights[0];
        airline = f.airline || f.airline_name || "";
        from = f.from || f.flight_from || "";
        to = f.to || f.flight_to || "";
      }
      const extraInfo = [airline, from && to ? `${from} → ${to}` : ""].filter(Boolean).join(" | ");

      // Adults
      if (Number(s.adult_count) > 0) {
        const count = Number(s.adult_count);
        const adultRateSar = Number(s.adult_rate || 0);
        const rate = Number(s.flight_sar_rate) || Number(s.pkr_rate) || (adultRateSar > 0 ? Number(Number(s.flight_pkr || 0) / (count * adultRateSar)) : 0);
        const sar = Math.round(count * adultRateSar);
        const pkr = Math.round(Number(s.flight_pkr) || (sar * rate));
        rows.push({
          id: `PKG-ADT-${s.id}`,
          date: s.booking_date,
          customer_code: cCode || "WALKIN",
          customer_name: cName,
          ref_no: s.ref_no,
          item: `Ticket – Adult (${count} Person${count > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          type: "SALE",
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: pkr,
          payment_pkr: 0
        });
      }

      // Child
      if (Number(s.child_count) > 0) {
        const count = Number(s.child_count);
        const childRateSar = Number(s.child_rate || 0);
        const rate = Number(s.flight_sar_rate) || Number(s.pkr_rate) || 0;
        const sar = Math.round(count * childRateSar);
        const pkr = Math.round(sar * rate);
        rows.push({
          id: `PKG-CHD-${s.id}`,
          date: s.booking_date,
          customer_code: cCode || "WALKIN",
          customer_name: cName,
          ref_no: s.ref_no,
          item: `Ticket – Child (${count} Person${count > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          type: "SALE",
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: pkr,
          payment_pkr: 0
        });
      }

      // Infant
      if (Number(s.infant_count) > 0) {
        const count = Number(s.infant_count);
        const infantRateSar = Number(s.infant_rate || 0);
        const rate = Number(s.flight_sar_rate) || Number(s.pkr_rate) || 0;
        const sar = Math.round(count * infantRateSar);
        const pkr = Math.round(sar * rate);
        rows.push({
          id: `PKG-INF-${s.id}`,
          date: s.booking_date,
          customer_code: cCode || "WALKIN",
          customer_name: cName,
          ref_no: s.ref_no,
          item: `Ticket – Infant (${count} Person${count > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          type: "SALE",
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: pkr,
          payment_pkr: 0
        });
      }

      // Hotels
      safeParse(s.hotels).forEach((h, i) => {
        const rooms = Number(h.rooms) || 0;
        const nights = Number(h.nights) || 0;
        const type = h.type ? h.type.toUpperCase() : "";
        const sar = Math.round(Number(h.total) || 0);
        const rate = Number(s.hotel_sar_rate) || Number(s.pkr_rate) || 0;
        rows.push({
          id: `PKG-HOT-${s.id}-${i}`,
          date: s.booking_date,
          customer_code: cCode || "WALKIN",
          customer_name: cName,
          ref_no: s.ref_no,
          item: `Hotel ${i + 1} - ${h.hotel || ""} (${type}${type ? ", " : ""}${rooms} Room${rooms > 1 ? "s" : ""}, ${nights} Night${nights > 1 ? "s" : ""})`,
          type: "SALE",
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: Math.round(sar * rate),
          payment_pkr: 0
        });
      });

      // Visa
      safeParse(s.visa).forEach((v, i) => {
        const persons = Number(v.persons || 0);
        const sar = Math.round(Number(v.total ?? (persons * Number(v.rate || 0))));
        const rate = Number(s.visa_sar_rate) || Number(s.pkr_rate) || 0;
        const itemName = v.type
          ? `Visa ${i + 1} - ${v.type} (${persons} Person${persons > 1 ? "s" : ""})`
          : `Visa ${i + 1} (${persons} Person${persons > 1 ? "s" : ""})`;

        rows.push({
          id: `PKG-VIS-${s.id}-${i}`,
          date: s.booking_date,
          customer_code: cCode || "WALKIN",
          customer_name: cName,
          ref_no: s.ref_no,
          item: itemName,
          type: "SALE",
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: Math.round(sar * rate),
          payment_pkr: 0
        });
      });

      // Transport
      safeParse(s.transport).forEach((t, i) => {
        const base = `Transport ${i + 1}`;
        const label = t.text || t.route || t.description || "";
        
        let formattedDate = "";
        if (t.date) {
          const d = new Date(t.date);
          if (!isNaN(d.getTime())) {
            const day = String(d.getDate()).padStart(2, "0");
            const mon = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
            const year = d.getFullYear();
            formattedDate = ` (${day}/${mon}/${year})`;
          }
        }

        const sar = Math.round(Number(t.amount || t.total || 0));
        const rate = Number(s.transport_sar_rate) || Number(s.pkr_rate) || 0;
        rows.push({
          id: `PKG-TRN-${s.id}-${i}`,
          date: s.booking_date,
          customer_code: cCode || "WALKIN",
          customer_name: cName,
          ref_no: s.ref_no,
          item: label ? `${base}${formattedDate} - ${label}` : `${base}${formattedDate}`,
          type: "SALE",
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: Math.round(sar * rate),
          payment_pkr: 0
        });
      });

      // Ziyarat
      safeParse(s.ziyarat).forEach((z, i) => {
        const base = `Ziyarat ${i + 1}`;
        const label = z.text || z.route || z.description || "";
        const sar = Math.round(Number(z.amount || z.total || 0));
        const rate = Number(s.ziyarat_sar_rate) || Number(s.pkr_rate) || 0;
        rows.push({
          id: `PKG-ZIY-${s.id}-${i}`,
          date: s.booking_date,
          customer_code: cCode || "WALKIN",
          customer_name: cName,
          ref_no: s.ref_no,
          item: label ? `${base} - ${label}` : base,
          type: "SALE",
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: Math.round(sar * rate),
          payment_pkr: 0
        });
      });

      // Agent Commission
      if (s.show_agent_comm) {
        const commList = safeParse(s.agent_comm);
        if (commList.length > 0) {
          commList.forEach((ac, i) => {
            const persons = Number(ac.persons || ac.qty || 1);
            const ratePkr = Number(ac.rate || ac.rate_pkr || 0);
            const totalPkr = Math.round(Number(ac.total || ac.amount || (persons * ratePkr) || 0));

            const agentName = ac.agent_name || ac.name || ac.title || ac.type || "";
            const personText = ` (${persons} Person${persons > 1 ? "s" : ""})`;

            rows.push({
              id: `PKG-COMM-${s.id}-${i}`,
              date: s.booking_date,
              customer_code: cCode || "WALKIN",
              customer_name: cName,
              ref_no: s.ref_no,
              item: agentName 
                ? `Agent Commission ${i + 1} - ${agentName}${personText}` 
                : `Agent Commission ${i + 1}${personText}`,
              type: "SALE",
              sale_sar: totalPkr,
              sale_rate: 1,
              sale_pkr: totalPkr,
              payment_pkr: 0
            });
          });
        } else if (Number(s.agent_comm_total) > 0) {
          const totalPkr = Math.round(Number(s.agent_comm_total));
          rows.push({
            id: `PKG-COMM-${s.id}`,
            date: s.booking_date,
            customer_code: cCode || "WALKIN",
            customer_name: cName,
            ref_no: s.ref_no,
            item: `Agent Commission`,
            type: "SALE",
            sale_sar: totalPkr,
            sale_rate: 1,
            sale_pkr: totalPkr,
            payment_pkr: 0
          });
        }
      }
    });

    // 4. HOTELS ONLY (HOT-)
    const hotRes = await db.query(`SELECT * FROM hotels WHERE is_deleted = false ORDER BY booking_date ASC, id ASC`);
    hotRes.rows.forEach((r) => {
      const cCode = r.customer_code ? r.customer_code.trim() : "";
      const cName = r.customer_name || "Walk-in Customer";
      if (r.ref_no) validRefsMap.set(r.ref_no.trim().toUpperCase(), cCode || "WALKIN");

      if (!isCustomerValid(cCode, cName, r.ref_no) || !isDateValid(r.booking_date)) return;

      const names = safeParse(r.hotel_name);
      if (names.length > 0) {
        names.forEach((name, i) => {
          const type = r.hotel_type?.[i] ? r.hotel_type[i].toUpperCase() : "";
          const rooms = Number(r.hotel_rooms?.[i]) || 0;
          const nights = Number(r.hotel_nights?.[i]) || 0;
          const sar = Math.round(Number(r.hotel_total?.[i]) || 0);
          const rate = Number(r.sar_rate) || Number(r.pkr_rate) || 0;
          rows.push({
            id: `HOT-${r.id}-${i}`,
            date: r.booking_date,
            customer_code: cCode || "WALKIN",
            customer_name: cName,
            ref_no: r.ref_no,
            item: `Hotel ${i + 1} - ${name} (${type}${type ? ", " : ""}${rooms} Room${rooms > 1 ? "s" : ""}, ${nights} Night${nights > 1 ? "s" : ""})`,
            type: "SALE",
            sale_sar: sar,
            sale_rate: rate,
            sale_pkr: Math.round(sar * rate),
            payment_pkr: 0
          });
        });
      }
    });

    // 5. TICKETING ONLY (TIC-)
    const ticRes = await db.query(`SELECT * FROM ticketing WHERE is_deleted = false ORDER BY booking_date ASC, id ASC`);
    ticRes.rows.forEach((r) => {
      const cCode = r.customer_code ? r.customer_code.trim() : "";
      const cName = r.customer_name || "Walk-in Customer";
      if (r.ref_no) validRefsMap.set(r.ref_no.trim().toUpperCase(), cCode || "WALKIN");

      if (!isCustomerValid(cCode, cName, r.ref_no) || !isDateValid(r.booking_date)) return;

      const from = Array.isArray(r.flight_from) ? r.flight_from.join(", ") : r.flight_from || "";
      const to = Array.isArray(r.flight_to) ? r.flight_to.join(", ") : r.flight_to || "";
      const airline = Array.isArray(r.airline) ? r.airline.join(", ") : r.airline || "";
      const routeText = from && to ? `${from} → ${to}` : "";
      const extraInfo = [airline, routeText].filter(Boolean).join(" | ");
      const rate = Number(r.pkr_rate) || Number(r.sar_rate) || 0;

      if (Number(r.adult_qty) > 0) {
        const sar = Math.round(Number(r.adult_qty) * Number(r.adult_rate || 0));
        rows.push({
          id: `TIC-ADT-${r.id}`,
          date: r.booking_date,
          customer_code: cCode || "WALKIN",
          customer_name: cName,
          ref_no: r.ref_no,
          item: `Ticket – Adult (${r.adult_qty} Person${r.adult_qty > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          type: "SALE",
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: Math.round(sar * rate),
          payment_pkr: 0
        });
      }
      if (Number(r.child_qty) > 0) {
        const sar = Math.round(Number(r.child_qty) * Number(r.child_rate || 0));
        rows.push({
          id: `TIC-CHD-${r.id}`,
          date: r.booking_date,
          customer_code: cCode || "WALKIN",
          customer_name: cName,
          ref_no: r.ref_no,
          item: `Ticket – Child (${r.child_qty} Person${r.child_qty > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          type: "SALE",
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: Math.round(sar * rate),
          payment_pkr: 0
        });
      }
      if (Number(r.infant_qty) > 0) {
        const sar = Math.round(Number(r.infant_qty) * Number(r.infant_rate || 0));
        rows.push({
          id: `TIC-INF-${r.id}`,
          date: r.booking_date,
          customer_code: cCode || "WALKIN",
          customer_name: cName,
          ref_no: r.ref_no,
          item: `Ticket – Infant (${r.infant_qty} Person${r.infant_qty > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          type: "SALE",
          sale_sar: sar,
          sale_rate: rate,
          sale_pkr: Math.round(sar * rate),
          payment_pkr: 0
        });
      }
    });

    // 6. OTHER MODULES BREAKDOWN (VISA, CARD, GROUPS, TRANSPORT, ZIYARAT)
    const otherTables = [
      { name: "visa", prefix: "VISA", title: "Visa" },
      { name: "card", prefix: "CARD", title: "Card" },
      { name: "groups", prefix: "GRP", title: "Groups" },
      { name: "transport", prefix: "TRN", title: "Transport" },
      { name: "ziyarat", prefix: "ZIY", title: "Ziyarat" }
    ];

    for (const t of otherTables) {
      const modRes = await db.query(`SELECT * FROM ${t.name} WHERE is_deleted = false ORDER BY booking_date ASC, id ASC`);
      modRes.rows.forEach((r) => {
        let cCode = r.customer_code ? r.customer_code.trim() : "";
        const cName = r.customer_name || "Walk-in Customer";
        
        if (r.ref_no) {
          const existingRefCode = validRefsMap.get(r.ref_no.trim().toUpperCase());
          if (!cCode && existingRefCode) {
            cCode = existingRefCode;
          } else if (r.ref_no) {
            validRefsMap.set(r.ref_no.trim().toUpperCase(), cCode || "WALKIN");
          }
        }

        if (!isCustomerValid(cCode, cName, r.ref_no) || !isDateValid(r.booking_date)) return;

        const subRows = safeParse(r.rows);
        const rate = Number(r.pkr_rate || r.sar_rate || 0);

        if (subRows.length > 0) {
          subRows.forEach((rowItem, i) => {
            let itemLabel = "";

if (t.name === "transport") {
            const base = `Transport ${i + 1}`;
            const label = rowItem.description || rowItem.text || rowItem.route || "";
            let formattedDate = "";
            
            // 🔹 Traveling Date Extraction & DD/MMM/YYYY Format Logic
            const rawDate = rowItem.date || rowItem.travelDate || rowItem.travel_date || r.date || r.travel_date;
            if (rawDate) {
              const d = new Date(rawDate);
              if (!isNaN(d.getTime())) {
                const day = String(d.getDate()).padStart(2, "0");
                const mon = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
                const year = d.getFullYear();
                formattedDate = ` (${day}/${mon}/${year})`;
              }

              }
              itemLabel = label ? `${base}${formattedDate} - ${label}` : `${base}${formattedDate}`;
            } else if (t.name === "ziyarat") {
              const base = `Ziyarat ${i + 1}`;
              const label = rowItem.description || rowItem.text || rowItem.route || "";
              itemLabel = label ? `${base} - ${label}` : base;
            } else {
              const persons = Number(rowItem.persons || 0);
              itemLabel = rowItem.type
                ? `${t.title} ${i + 1} - ${rowItem.type} (${persons} Person${persons > 1 ? "s" : ""})`
                : `${t.title} (${persons} Person${persons > 1 ? "s" : ""})`;
            }

            const sar = Math.round(Number(rowItem.sar || rowItem.total || (Number(rowItem.persons || 0) * Number(rowItem.rate || 0)) || 0));

            rows.push({
              id: `${t.prefix}-${r.id}-${i}`,
              date: r.booking_date,
              customer_code: cCode || "WALKIN",
              customer_name: cName,
              ref_no: r.ref_no,
              item: itemLabel,
              type: "SALE",
              sale_sar: sar,
              sale_rate: rate,
              sale_pkr: Math.round(sar * rate),
              payment_pkr: 0
            });
          });
        } else {
          rows.push({
            id: `${t.prefix}-${r.id}`,
            date: r.booking_date,
            customer_code: cCode || "WALKIN",
            customer_name: cName,
            ref_no: r.ref_no,
            item: `${t.title} Entry - Ref: ${r.ref_no}`,
            type: "SALE",
            sale_sar: Math.round(Number(r.total_sar || 0)),
            sale_rate: rate,
            sale_pkr: Math.round(Number(r.total_pkr || 0)),
            payment_pkr: 0
          });
        }
      });
    }

    // 7. PAYMENTS & OPENING BALANCES (DEEP WALK-IN & REGISTERED NAME RESOLUTION)
    const payRes = await db.query(`
      SELECT cp.*, b.bank_name, 
             COALESCE(
               cust.name,
               arch.name,
               (SELECT customer_name FROM bookings WHERE TRIM(LOWER(ref_no)) = TRIM(LOWER(cp.ref_no)) AND customer_name IS NOT NULL AND customer_name != '' AND customer_name != 'Walk-in Customer' LIMIT 1),
               (SELECT customer_name FROM hotels WHERE TRIM(LOWER(ref_no)) = TRIM(LOWER(cp.ref_no)) AND customer_name IS NOT NULL AND customer_name != '' AND customer_name != 'Walk-in Customer' LIMIT 1),
               (SELECT customer_name FROM visa WHERE TRIM(LOWER(ref_no)) = TRIM(LOWER(cp.ref_no)) AND customer_name IS NOT NULL AND customer_name != '' AND customer_name != 'Walk-in Customer' LIMIT 1),
               (SELECT customer_name FROM card WHERE TRIM(LOWER(ref_no)) = TRIM(LOWER(cp.ref_no)) AND customer_name IS NOT NULL AND customer_name != '' AND customer_name != 'Walk-in Customer' LIMIT 1),
               (SELECT customer_name FROM groups WHERE TRIM(LOWER(ref_no)) = TRIM(LOWER(cp.ref_no)) AND customer_name IS NOT NULL AND customer_name != '' AND customer_name != 'Walk-in Customer' LIMIT 1),
               (SELECT customer_name FROM ticketing WHERE TRIM(LOWER(ref_no)) = TRIM(LOWER(cp.ref_no)) AND customer_name IS NOT NULL AND customer_name != '' AND customer_name != 'Walk-in Customer' LIMIT 1),
               (SELECT customer_name FROM transport WHERE TRIM(LOWER(ref_no)) = TRIM(LOWER(cp.ref_no)) AND customer_name IS NOT NULL AND customer_name != '' AND customer_name != 'Walk-in Customer' LIMIT 1),
               (SELECT customer_name FROM ziyarat WHERE TRIM(LOWER(ref_no)) = TRIM(LOWER(cp.ref_no)) AND customer_name IS NOT NULL AND customer_name != '' AND customer_name != 'Walk-in Customer' LIMIT 1),
               'Walk-in Customer'
             ) AS resolved_name
      FROM customer_payments cp
      LEFT JOIN public.banks b ON b.id = cp.bank_profile_id
      LEFT JOIN customers cust ON cust.customer_code = cp.ref_no AND cust.is_deleted = false
      LEFT JOIN archive_balances arch ON TRIM(LOWER(arch.code)) = TRIM(LOWER(cp.ref_no)) AND arch.balance_type = 'CUSTOMER'
      WHERE (cp.is_deleted IS NOT TRUE OR cp.is_deleted = false)
      ORDER BY cp.payment_date ASC, cp.id ASC
    `);

    payRes.rows.forEach((p) => {
      const pRef = p.ref_no ? p.ref_no.trim().toUpperCase() : "";
      const cCode = validRefsMap.get(pRef) || pRef;
      
      let resolvedCustomerName = p.resolved_name;
      if (!resolvedCustomerName || resolvedCustomerName === "Walk-in Customer") {
        const existingSale = rows.find(r => r.ref_no && r.ref_no.trim().toUpperCase() === pRef && r.customer_name && r.customer_name !== "Walk-in Customer");
        if (existingSale) {
          resolvedCustomerName = existingSale.customer_name;
        } else {
          resolvedCustomerName = "Walk-in Customer";
        }
      }

      if (customer_code === "WALKIN") {
        const isRegisteredRef = Array.from(validRefsMap.values()).includes(pRef) && pRef.startsWith("CUST-");
        if (isRegisteredRef) return;
      }

      if (!isCustomerValid(cCode, resolvedCustomerName, p.ref_no) || !isDateValid(p.payment_date)) return;

      if (p.type === "opening_balance") {
        rows.push({
          id: `PAY-OP-${p.id}`,
          date: p.payment_date,
          customer_code: cCode,
          customer_name: resolvedCustomerName,
          ref_no: p.ref_no,
          item: `🔑 Opening Balance`,
          type: "SALE",
          sale_sar: 0,
          sale_rate: 0,
          sale_pkr: Math.round(Number(p.amount || 0)),
          payment_pkr: 0
        });
      } else {
        let methodText = p.payment_method || "Cash";
        if (p.payment_method?.toLowerCase() === "bank" && p.bank_name) {
          methodText = `Bank (${p.bank_name})`;
        }

        rows.push({
          id: `PAY-${p.id}`,
          date: p.payment_date,
          customer_code: cCode,
          customer_name: resolvedCustomerName,
          ref_no: p.ref_no,
          item: p.type === "adjustment" ? `⚙️ Adjustment` : `💵 Payment Received (${methodText})`,
          type: "PAYMENT",
          sale_sar: 0,
          sale_rate: 0,
          sale_pkr: 0,
          payment_pkr: Math.round(Number(p.amount || 0))
        });
      }
    });

// 8. CHRONOLOGICAL SORTING (SAME DATE PAR SALE PEHLE, PAYMENT BAAD MEIN)
    rows.sort((a, b) => {
      const dateA = new Date(a.date).getTime();
      const dateB = new Date(b.date).getTime();
      
      // 1. Pehle Tariq (Date) ke hisab se sort karein
      if (dateA !== dateB) return dateA - dateB;

      // 2. Agar Tariq same ho, to SALE (priority 1) ko PAYMENT (priority 2) se pehle rakhein
      const priorityA = a.type === "SALE" ? 1 : 2;
      const priorityB = b.type === "SALE" ? 1 : 2;
      if (priorityA !== priorityB) return priorityA - priorityB;

      // 3. Phir ID ke hisab se sort karein
      return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    });

    res.json({
      success: true,
      customers: customerList,
      rows,
      customerBaseline
    });
  } catch (err) {
    console.error("CUSTOMER SALE DETAIL LEDGER ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});



module.exports = router;