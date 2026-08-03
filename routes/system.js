const express = require("express");
const router = express.Router();
const db = require("../db");

const DB_LIMIT_MB = 500;

router.get("/capacity-rows", async (req, res) => {
  try {
    /* ================= DATABASE SIZE ================= */
    const dbQ = await db.query(`
      SELECT pg_database_size(current_database()) AS size
    `);

    const usedMB = Number(dbQ.rows[0].size || 0) / 1024 / 1024;
    const freeMB = DB_LIMIT_MB - usedMB;

    /* ================= TOTAL ROW COUNT ================= */
    const rowsQ = await db.query(`
      SELECT SUM(n_live_tup)::bigint AS total_rows
      FROM pg_stat_user_tables
    `);
    const totalRows = Number(rowsQ.rows[0]?.total_rows || 0);

    /* ================= SYSTEM START DATE & MONTHS COUNT ================= */
    // Dynamic query with safe fallback
    const minDateQ = await db.query(`
      SELECT MIN(created_date) AS start_date FROM (
        SELECT MIN(created_at)::date AS created_date FROM bookings WHERE created_at IS NOT NULL
        UNION ALL
        SELECT MIN(payment_date)::date AS created_date FROM customer_payments WHERE payment_date IS NOT NULL
        UNION ALL
        SELECT MIN(created_at)::date AS created_date FROM supplier_payments WHERE created_at IS NOT NULL
      ) x WHERE created_date IS NOT NULL
    `);

    let startDateRaw = minDateQ.rows[0]?.start_date;
    let startDate = startDateRaw ? new Date(startDateRaw) : new Date();
    
    // Safety check if date is invalid
    if (isNaN(startDate.getTime())) {
      startDate = new Date(); // Fallback to current date
    }

    const currentDate = new Date();

    // Calculate total months difference
    let totalMonths =
      (currentDate.getFullYear() - startDate.getFullYear()) * 12 +
      (currentDate.getMonth() - startDate.getMonth());

    // Minimum 1 month count rakhein taaki 0 se divide na ho
    if (totalMonths < 1 || isNaN(totalMonths)) {
      totalMonths = 1;
    }

    /* ================= MONTHLY AVERAGE & ESTIMATIONS ================= */
    const avgMBPerMonth = usedMB / totalMonths;
    const remainingMonths = avgMBPerMonth > 0 ? Math.floor(freeMB / avgMBPerMonth) : 0;

    // Estimated End Date
    const exhaustionDate = new Date();
    exhaustionDate.setMonth(exhaustionDate.getMonth() + remainingMonths);

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const estimatedEndDate = `${monthNames[exhaustionDate.getMonth()]}/${exhaustionDate.getFullYear()}`;

    /* ================= GLOBAL AVERAGE ROW SIZE ================= */
    const avgRowMB = totalRows > 0 ? usedMB / totalRows : 0;
    const possibleMoreRows = avgRowMB > 0 ? Math.floor(freeMB / avgRowMB) : 0;

    /* ================= PER TABLE BREAKDOWN ================= */
    const tablesQ = await db.query(`
      SELECT
        relname AS table,
        n_live_tup AS rows
      FROM pg_stat_user_tables
      ORDER BY rows DESC
    `);

    res.json({
      success: true,
      dbLimitMB: DB_LIMIT_MB,
      usedMB: +usedMB.toFixed(2),
      freeMB: +freeMB.toFixed(2),
      totalRows,
      avgRowKB: +(avgRowMB * 1024).toFixed(2),
      possibleMoreRows,

      // Guaranteed Numbers
      totalMonths: Number(totalMonths) || 1,
      avgMBPerMonth: Number(avgMBPerMonth.toFixed(2)) || 0,
      remainingMonths: Number(remainingMonths) || 0,
      estimatedEndDate: estimatedEndDate || "N/A",

      tables: tablesQ.rows || []
    });

  } catch (err) {
    console.error("CAPACITY GLOBAL ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;