const express = require("express");
const router = express.Router();
const db = require("../db");

/* =====================================================
   GET ALL DELETED RECORDS WITH CODE / STATUS
===================================================== */
router.get("/list", async (req, res) => {
  try {
    const q = await db.query(`

      /* BOOKINGS */
      SELECT 
        'PACKAGE' AS type, ref_no, customer_name, customer_code, booking_date, total_pkr AS amount,
        CASE WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered' ELSE 'Walk-in' END AS customer_type
      FROM bookings WHERE is_deleted = true

      UNION ALL
      SELECT 
        'HOTEL' AS type, ref_no, customer_name, customer_code, booking_date, total_pkr,
        CASE WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered' ELSE 'Walk-in' END AS customer_type
      FROM hotels WHERE is_deleted = true

      UNION ALL
      SELECT 
        'TICKETING' AS type, ref_no, customer_name, customer_code, booking_date, total_pkr,
        CASE WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered' ELSE 'Walk-in' END AS customer_type
      FROM ticketing WHERE is_deleted = true

      UNION ALL
      SELECT 
        'VISA' AS type, ref_no, customer_name, customer_code, booking_date, total_pkr,
        CASE WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered' ELSE 'Walk-in' END AS customer_type
      FROM visa WHERE is_deleted = true

      UNION ALL
      SELECT 
        'CARD' AS type, ref_no, customer_name, customer_code, booking_date, total_pkr,
        CASE WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered' ELSE 'Walk-in' END AS customer_type
      FROM card WHERE is_deleted = true

      UNION ALL
      SELECT 
        'GROUPS' AS type, ref_no, customer_name, customer_code, booking_date, total_pkr,
        CASE WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered' ELSE 'Walk-in' END AS customer_type
      FROM groups WHERE is_deleted = true

      UNION ALL
      SELECT 
        'TRANSPORT' AS type, ref_no, customer_name, customer_code, booking_date, total_pkr,
        CASE WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered' ELSE 'Walk-in' END AS customer_type
      FROM transport WHERE is_deleted = true

      UNION ALL
      SELECT 
        'ZIYARAT' AS type, ref_no, customer_name, customer_code, booking_date, total_pkr,
        CASE WHEN customer_code IS NOT NULL AND TRIM(customer_code) != '' THEN 'Registered' ELSE 'Walk-in' END AS customer_type
      FROM ziyarat WHERE is_deleted = true

      /* PURCHASE */
      UNION ALL
      SELECT
        'PURCHASE' AS type,
        pe.ref_no,
        COALESCE(b.customer_name, h.customer_name, t.customer_name, v.customer_name, c.customer_name, tr.customer_name, z.customer_name, '-') AS customer_name,
        COALESCE(b.customer_code, h.customer_code, t.customer_code, v.customer_code, c.customer_code, tr.customer_code, z.customer_code, NULL) AS customer_code,
        MIN(pe.created_at)::date AS booking_date,
        SUM(pe.purchase_pkr) AS amount,
        'Purchase' AS customer_type
      FROM purchase_entries pe
      LEFT JOIN bookings b ON b.ref_no = pe.ref_no
      LEFT JOIN hotels h ON h.ref_no = pe.ref_no
      LEFT JOIN ticketing t ON t.ref_no = pe.ref_no
      LEFT JOIN visa v ON v.ref_no = pe.ref_no
      LEFT JOIN card c ON c.ref_no = pe.ref_no
      LEFT JOIN groups g ON g.ref_no = pe.ref_no
      LEFT JOIN transport tr ON tr.ref_no = pe.ref_no
      LEFT JOIN ziyarat z ON z.ref_no = pe.ref_no
      WHERE pe.is_deleted = true
      GROUP BY pe.ref_no, b.customer_name, h.customer_name, t.customer_name, v.customer_name, c.customer_name, tr.customer_name, z.customer_name, b.customer_code, h.customer_code, t.customer_code, v.customer_code, c.customer_code, tr.customer_code, z.customer_code

      /* SUPPLIERS */
      UNION ALL
      SELECT
        'SUPPLIER' AS type,
        supplier_code AS ref_no,
        supplier_name AS customer_name,
        supplier_code AS customer_code,
        NULL::date AS booking_date,
        NULL::numeric AS amount,
        'Supplier' AS customer_type
      FROM suppliers
      WHERE is_deleted = true

      /* CUSTOMERS */
      UNION ALL
      SELECT
        'CUSTOMER' AS type,
        customer_code AS ref_no,
        name AS customer_name,
        customer_code AS customer_code,
        NULL::date AS booking_date,
        NULL::numeric AS amount,
        'Customer' AS customer_type
      FROM customers
      WHERE is_deleted = true

      ORDER BY booking_date DESC NULLS LAST
    `);

    res.json({ success: true, rows: q.rows });

  } catch (err) {
    console.error("DELETED LIST ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

/* =====================================================
    NAV RESTORE RECORD ROUTE (COMPLETE & FIXED)
===================================================== */
router.post("/restore", async (req, res) => {
  try {
    const { type, ref_no, password } = req.body;

    if (!password) {
      return res.status(400).json({ success: false, error: "Password required" });
    }

    // 🔑 DB Lookup for Restore Password
    const passCheck = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'restore_report_pass'"
    );

    if (passCheck.rows.length === 0) {
      return res.status(500).json({ success: false, error: "Restore password configuration missing in DB!" });
    }

    if (password !== passCheck.rows[0].password_val) {
      return res.status(401).json({ success: false, error: "Invalid password" });
    }

    const uppercaseType = type?.toUpperCase();

    // ---------------------------------------------------------
    // 🛑 PURCHASE RESTORE VALIDATION & EXECUTION
    // ---------------------------------------------------------
    if (uppercaseType === "PURCHASE") {
      // 1. Check duplicate active purchase
      const activeCheck = await db.query(
        `SELECT id FROM purchase_entries WHERE ref_no = $1 AND is_deleted = false LIMIT 1`,
        [ref_no]
      );

      if (activeCheck.rows.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Ref No (${ref_no}) ki purchase pehle se active hai. Duplicate restore allow nahi hai!`
        });
      }

      // 2. Fetch deleted purchase totals
      const deletedPurchase = await db.query(
        `SELECT ref_no, SUM(sale_pkr) AS purchase_sale_pkr 
         FROM purchase_entries 
         WHERE ref_no = $1 AND is_deleted = true 
         GROUP BY ref_no`,
        [ref_no]
      );

      if (deletedPurchase.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Deleted purchase entry record nahi mila!" });
      }

      // 3. Parent Active Sale Match Check
      const activeSaleCheck = await db.query(
        `
        SELECT ref_no, total_pkr FROM (
          SELECT ref_no, total_pkr FROM bookings WHERE ref_no = $1 AND is_deleted = false
          UNION ALL
          SELECT ref_no, total_pkr FROM hotels WHERE ref_no = $1 AND is_deleted = false
          UNION ALL
          SELECT ref_no, total_pkr FROM ticketing WHERE ref_no = $1 AND is_deleted = false
          UNION ALL
          SELECT ref_no, total_pkr FROM visa WHERE ref_no = $1 AND is_deleted = false
          UNION ALL
          SELECT ref_no, total_pkr FROM card WHERE ref_no = $1 AND is_deleted = false
          UNION ALL
          SELECT ref_no, total_pkr FROM groups WHERE ref_no = $1 AND is_deleted = false
          UNION ALL
          SELECT ref_no, total_pkr FROM transport WHERE ref_no = $1 AND is_deleted = false
          UNION ALL
          SELECT ref_no, total_pkr FROM ziyarat WHERE ref_no = $1 AND is_deleted = false
        ) active_sales LIMIT 1;
        `,
        [ref_no]
      );

      if (activeSaleCheck.rows.length === 0) {
        return res.status(400).json({
          success: false,
          error: `Is Purchase ki main Sale active nahi hai (delete ho chuki hai). Restore allow nahi hai!`
        });
      }

      // 4. Amount match validation
      const activeSalePkr = Number(activeSaleCheck.rows[0].total_pkr || 0);
      const purchaseSalePkr = Number(deletedPurchase.rows[0].purchase_sale_pkr || 0);

      if (Math.abs(activeSalePkr - purchaseSalePkr) > 1) {
        return res.status(400).json({
          success: false,
          error: `Main Sale me change/modification ho chuki hai! Active Sale Amount (${activeSalePkr.toLocaleString()}) aur Purchase Sale Amount (${purchaseSalePkr.toLocaleString()}) match nahi kar rahe.`
        });
      }

      // 5. UPDATE Purchase Entry in DB
      const updateResult = await db.query(
        `UPDATE purchase_entries SET is_deleted = false WHERE ref_no = $1 AND is_deleted = true`,
        [ref_no]
      );

      if (updateResult.rowCount === 0) {
        return res.status(400).json({ success: false, error: "Record restore nahi ho saka." });
      }

      return res.json({ success: true, message: `Purchase ${ref_no} successfully restored.` });
    }

    // ---------------------------------------------------------
    // 🛑 ALL OTHER TYPES RESTORE EXECUTION (PACKAGE, HOTEL, VISA, ETC)
    // ---------------------------------------------------------
    let tableName = "";
    if (uppercaseType === "PACKAGE") tableName = "bookings";
    else if (uppercaseType === "HOTEL") tableName = "hotels";
    else if (uppercaseType === "TICKETING") tableName = "ticketing";
    else if (uppercaseType === "TRANSPORT") tableName = "transport";
    else if (uppercaseType === "ZIYARAT") tableName = "ziyarat";
    else if (uppercaseType === "VISA") tableName = "visa";
    else if (uppercaseType === "CARD") tableName = "card";
    else if (uppercaseType === "GROUPS") tableName = "groups";
    else if (uppercaseType === "SUPPLIER") tableName = "suppliers";
    else if (uppercaseType === "CUSTOMER") tableName = "customers";

    if (!tableName) {
      return res.status(400).json({ success: false, error: "Invalid record type!" });
    }

    const restoreRes = await db.query(
      `UPDATE ${tableName} SET is_deleted = false WHERE ref_no = $1 AND is_deleted = true`,
      [ref_no]
    );

    if (restoreRes.rowCount === 0) {
      return res.status(404).json({ success: false, error: "Record delete status me nahi mila!" });
    }

    return res.json({ success: true, message: `${ref_no} successfully restored.` });

  } catch (err) {
    console.error("RESTORE ERROR:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* =====================================================
   🗑 PERMANENT DELETE ROUTE (DYNAMIC DB PASSWORD)
===================================================== */
router.post("/permanent-delete", async (req, res) => {
  try {
    const { type, ref_no, password } = req.body;

    if (!password) {
      return res.json({ success: false, error: "Password required" });
    }

    // 🔍 DB Lookup for Permanent Delete Password
    const passCheck = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'perm_delete_report_pass'"
    );
    
    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "Permanent delete password configuration missing in DB!" });
    }

    if (password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Invalid password" });
    }

    let table = "";
    let lookupColumn = "ref_no";

    if (type === "PACKAGE") table = "bookings";
    else if (type === "HOTEL") table = "hotels";
    else if (type === "TICKETING") table = "ticketing";
    else if (type === "VISA") table = "visa";
    else if (type === "CARD") table = "card";
    else if (type === "GROUPS") table = "groups";
    else if (type === "TRANSPORT") table = "transport";
    else if (type === "ZIYARAT") table = "ziyarat";
    else if (type === "PURCHASE") table = "purchase_entries";
    else if (type === "SUPPLIER") {
      table = "suppliers";
      lookupColumn = "supplier_code";
    } else if (type === "CUSTOMER") {
      table = "customers";
      lookupColumn = "customer_code";
    } else {
      return res.json({ success: false, error: "Invalid type" });
    }

    const q = await db.query(
      `
      DELETE FROM ${table}
      WHERE ${lookupColumn} = $1
        AND is_deleted = true
      RETURNING ${lookupColumn} AS ref_no
      `,
      [ref_no]
    );

    if (!q.rows.length) {
      return res.json({ success: false, error: "Record not found" });
    }

    res.json({ success: true, message: "Record permanently deleted from database" });
  } catch (err) {
    console.error("PERMANENT DELETE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;