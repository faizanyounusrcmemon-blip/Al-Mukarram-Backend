const express = require("express");
const router = express.Router();
const db = require("../db");

/* =====================================================
   GET ALL DELETED RECORDS (SALES + PURCHASE + SUPPLIERS + CUSTOMERS)
===================================================== */
router.get("/list", async (req, res) => {
  try {
    const q = await db.query(`

      /* BOOKINGS */
      SELECT 'PACKAGE' AS type, ref_no, customer_name, booking_date, total_pkr AS amount
      FROM bookings WHERE is_deleted = true

      UNION ALL
      SELECT 'HOTEL' AS type, ref_no, customer_name, booking_date, total_pkr
      FROM hotels WHERE is_deleted = true

      UNION ALL
      SELECT 'TICKETING' AS type, ref_no, customer_name, booking_date, total_pkr
      FROM ticketing WHERE is_deleted = true

      UNION ALL
      SELECT 'VISA' AS type, ref_no, customer_name, booking_date, total_pkr
      FROM visa WHERE is_deleted = true

      UNION ALL
      SELECT 'CARD' AS type, ref_no, customer_name, booking_date, total_pkr
      FROM card WHERE is_deleted = true

      UNION ALL
      SELECT 'groups' AS type, ref_no, customer_name, booking_date, total_pkr
      FROM groups WHERE is_deleted = true

      UNION ALL
      SELECT 'TRANSPORT' AS type, ref_no, customer_name, booking_date, total_pkr
      FROM transport WHERE is_deleted = true

      UNION ALL
      SELECT 'ZIYARAT' AS type, ref_no, customer_name, booking_date, total_pkr
      FROM ziyarat WHERE is_deleted = true

      /* PURCHASE - get customer_name from any sales table */
      UNION ALL
      SELECT
        'PURCHASE' AS type,
        pe.ref_no,
        COALESCE(
          b.customer_name,
          h.customer_name,
          t.customer_name,
          v.customer_name,
          c.customer_name,
          tr.customer_name,
          z.customer_name,
          '-'
        ) AS customer_name,
        MIN(pe.created_at)::date AS booking_date,
        SUM(pe.purchase_pkr) AS amount
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
      GROUP BY pe.ref_no, b.customer_name, h.customer_name, t.customer_name, v.customer_name, c.customer_name, tr.customer_name, z.customer_name

      /* SUPPLIERS */
      UNION ALL
      SELECT
        'SUPPLIER' AS type,
        supplier_code AS ref_no,
        supplier_name AS customer_name,
        NULL::date AS booking_date,
        NULL::numeric AS amount
      FROM suppliers
      WHERE is_deleted = true

      /* CUSTOMERS */
      UNION ALL
      SELECT
        'CUSTOMER' AS type,
        customer_code AS ref_no,
        name AS customer_name,
        NULL::date AS booking_date,
        NULL::numeric AS amount
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
   ♻ RESTORE RECORD ROUTE (DYNAMIC DB PASSWORD)
===================================================== */
router.post("/restore", async (req, res) => {
  try {
    const { type, ref_no, password } = req.body;

    if (!password) {
      return res.json({ success: false, error: "Password required" });
    }

    // 🔍 DB Lookup for Restore Password
    const passCheck = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'restore_report_pass'"
    );
    
    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "Restore password configuration missing in DB!" });
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
      UPDATE ${table}
      SET is_deleted = false
      WHERE ${lookupColumn} = $1
        AND is_deleted = true
      RETURNING ${lookupColumn} AS ref_no
      `,
      [ref_no]
    );

    if (!q.rows.length) {
      return res.json({ success: false, error: "Record not found or already active" });
    }

    res.json({ success: true, message: "Record restored successfully" });
  } catch (err) {
    console.error("RESTORE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
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