const express = require("express");
const router = express.Router();
const db = require("../db");

/* ======================================================
   GET MONTHLY PROFIT REPORT (COMBINED ARCHIVE + LIVE)
====================================================== */
router.get("/", async (req, res) => {
  try {
    const { year } = req.query;
    const selectedYear = Number(year || new Date().getFullYear());

    /* 1. Sab se pehle is saal ka jitna bhi archived data hai woh uthalain */
    const archiveProfit = await db.query(`
      SELECT 
        report_month AS month,
        total_sales,
        total_purchase,
        base_profit,
        supplier_adjustment,
        customer_adjustment,
        total_expense,
        net_profit
      FROM archive_profit_monthly
      WHERE report_year = $1
      ORDER BY report_month
    `, [selectedYear]);

    // Archive data ko easy lookup ke liye key-value map mein convert kar letay hain
    const archiveMap = new Map();
    archiveProfit.rows.forEach(row => {
      archiveMap.set(Number(row.month), row);
    });

    const months = [];

    /* 2. Pure 12 mahino par loop chalayein aur jahan archive nahi hai wahan live data layein */
    for (let month = 1; month <= 12; month++) {
      const monthName = new Date(0, month - 1).toLocaleString("en", { month: "long" });

      // AGAR ARCHIVE MAUJOOD HAI TO US MAHINE KA SNAPSHOT UTHAO
      if (archiveMap.has(month)) {
        const r = archiveMap.get(month);
        months.push({
          month,
          month_name: monthName,
          total_sales: Math.round(Number(r.total_sales || 0)),
          total_purchase: Math.round(Number(r.total_purchase || 0)),
          base_profit: Math.round(Number(r.base_profit || 0)),
          supplier_adjustment: Math.round(Number(r.supplier_adjustment || 0)),
          customer_adjustment: Math.round(Number(r.customer_adjustment || 0)),
          total_expense: Math.round(Number(r.total_expense || 0)),
          net_profit: Math.round(Number(r.net_profit || 0)),
          source: "archive" // Pehchan ke liye ke yeh snapshot data hai
        });
        continue; // Agle mahine par chaly jao, niche live query chalane ki zaroorat nahi
      }

      // AGAR ARCHIVE NAHI HAI TO US MAHINE KA LIVE DATA UTHAO
      /* LIVE SALES */
      const sales = await db.query(`
        SELECT COALESCE(SUM(total),0) total
        FROM (
          SELECT SUM(total_pkr) total FROM bookings WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
          UNION ALL
          SELECT SUM(total_pkr) FROM hotels WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
          UNION ALL
          SELECT SUM(total_pkr) FROM visa WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
          UNION ALL
          SELECT SUM(total_pkr) FROM groups WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
          UNION ALL
          SELECT SUM(total_pkr) FROM card WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
          UNION ALL
          SELECT SUM(total_pkr) FROM ticketing WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
          UNION ALL
          SELECT SUM(total_pkr) FROM transport WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
          UNION ALL
          SELECT SUM(total_pkr) FROM ziyarat WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
        ) x
      `, [selectedYear, month]);

      const totalSales = Number(sales.rows[0].total || 0);

      /* LIVE PURCHASE */
      const purchase = await db.query(`
        SELECT 
          COALESCE(SUM(purchase_pkr),0) purchase,
          COALESCE(SUM(profit),0) profit
        FROM purchase_entries
        WHERE is_deleted=false
          AND EXTRACT(YEAR FROM created_at)=$1
          AND EXTRACT(MONTH FROM created_at)=$2
      `, [selectedYear, month]);

      const totalPurchase = Number(purchase.rows[0].purchase || 0);
      const baseProfit = Number(purchase.rows[0].profit || 0);

      /* LIVE EXPENSE */
      const expense = await db.query(`
        SELECT COALESCE(SUM(amount),0) total
        FROM expense_ledger
        WHERE EXTRACT(YEAR FROM expense_date)=$1
          AND EXTRACT(MONTH FROM expense_date)=$2
      `, [selectedYear, month]);

      const totalExpense = Number(expense.rows[0].total || 0);

      /* LIVE ADJUSTMENTS */
      const supplier = await db.query(`
        SELECT COALESCE(SUM(amount),0) total
        FROM supplier_payments
        WHERE LOWER(type)='adjustment'
          AND EXTRACT(YEAR FROM payment_date)=$1
          AND EXTRACT(MONTH FROM payment_date)=$2
      `, [selectedYear, month]);

      const customer = await db.query(`
        SELECT COALESCE(SUM(amount),0) total
        FROM customer_payments
        WHERE LOWER(type)='adjustment'
          AND EXTRACT(YEAR FROM payment_date)=$1
          AND EXTRACT(MONTH FROM payment_date)=$2
      `, [selectedYear, month]);

      const supplierAdjustment = Number(supplier.rows[0].total || 0);
      const customerAdjustment = Number(customer.rows[0].total || 0);

      const netProfit = baseProfit + supplierAdjustment - customerAdjustment - totalExpense;

      months.push({
        month,
        month_name: monthName,
        total_sales: Math.round(totalSales),
        total_purchase: Math.round(totalPurchase),
        base_profit: Math.round(baseProfit),
        supplier_adjustment: Math.round(supplierAdjustment),
        customer_adjustment: Math.round(customerAdjustment),
        total_expense: Math.round(totalExpense),
        net_profit: Math.round(netProfit),
        source: "live" // Pehchan ke liye ke yeh live calculation hai
      });
    }

    // Response send karein poore 12 mahino ka mixed data (Archive + Live)
    res.json({
      success: true,
      year: selectedYear,
      months
    });

  } catch (err) {
    console.error("MONTHLY PROFIT ERROR:", err);
    res.json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;