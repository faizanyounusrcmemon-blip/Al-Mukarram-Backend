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

    const usedMB = Number(dbQ.rows[0].size) / 1024 / 1024;
    const freeMB = DB_LIMIT_MB - usedMB;

    /* ================= TOTAL ROW COUNT (ALL TABLES) ================= */
    const rowsQ = await db.query(`
      SELECT SUM(n_live_tup)::bigint AS total_rows
      FROM pg_stat_user_tables
    `);

    const totalRows = Number(rowsQ.rows[0].total_rows || 0);

    /* ================= GLOBAL AVERAGE ROW SIZE ================= */
    const avgRowMB =
      totalRows > 0 ? usedMB / totalRows : 0;

    /* ================= POSSIBLE MORE ROWS ================= */
    const possibleMoreRows =
      avgRowMB > 0 ? Math.floor(freeMB / avgRowMB) : 0;

    /* ================= OPTIONAL: PER TABLE BREAKDOWN ================= */
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

      tables: tablesQ.rows
    });

  } catch (err) {
    console.error("CAPACITY GLOBAL ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
