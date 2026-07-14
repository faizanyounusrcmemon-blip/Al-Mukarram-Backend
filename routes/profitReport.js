const express = require("express");
const router = express.Router();
const db = require("../db");

router.get("/", async (req, res) => {
  try {
    const { year, month } = req.query;
    const selectedYear = year ? Number(year) : new Date().getFullYear();
    const selectedMonth = month ? Number(month) : null;

    // Is array mein hum store karenge ke kis mahine ka data hum archive se utha chuke hain
    let archivedMonthsList = [];

    // Pehle se variables define kar letay hain taake dono surto mein sum ho sakein
    let totalSales = 0;
    let totalPurchase = 0;
    let baseProfit = 0;
    let supplierAdjustment = 0;
    let customerAdjustment = 0;
    let totalExpense = 0;

    /* ======================================================
       1. CHECK ARCHIVE PROFIT FIRST (MONTHLY OR YEARLY)
    ====================================================== */
    let archiveQuery = `
      SELECT
        report_month,
        COALESCE(total_sales,0) AS total_sales,
        COALESCE(total_purchase,0) AS total_purchase,
        COALESCE(base_profit,0) AS base_profit,
        COALESCE(supplier_adjustment,0) AS supplier_adjustment,
        COALESCE(customer_adjustment,0) AS customer_adjustment,
        COALESCE(total_expense,0) AS total_expense,
        COALESCE(net_profit,0) AS net_profit
      FROM archive_profit_monthly
      WHERE report_year = $1
    `;
    let archiveParams = [selectedYear];

    if (selectedMonth) {
      archiveQuery += ` AND report_month = $2`;
      archiveParams.push(selectedMonth);
    }

    // FIX: 'archive.query' ki jagah seedha 'db.query' chalayein
    const archiveRes = await db.query(archiveQuery, archiveParams);

    // Agar SPECIFIC MONTH manga tha aur archive mein mil gaya, toh directly return karein
    if (selectedMonth && archiveRes.rows.length > 0) {
      const archiveData = archiveRes.rows[0];
      return res.json({
        success: true,
        source: "archive",
        report: {
          total_sales: Math.round(Number(archiveData.total_sales)),
          total_purchase: Math.round(Number(archiveData.total_purchase)),
          base_profit: Math.round(Number(archiveData.base_profit)),
          supplier_adjustment: Math.round(Number(archiveData.supplier_adjustment)),
          customer_adjustment: Math.round(Number(archiveData.customer_adjustment)),
          total_expense: Math.round(Number(archiveData.total_expense)),
          net_profit: Math.round(Number(archiveData.net_profit))
        }
      });
    }

    // Agar YEARLY report hai, toh archived rows ka data initial totals mein jama kar lein
    if (!selectedMonth && archiveRes.rows.length > 0) {
      archiveRes.rows.forEach(row => {
        totalSales += Number(row.total_sales);
        totalPurchase += Number(row.total_purchase);
        baseProfit += Number(row.base_profit);
        supplierAdjustment += Number(row.supplier_adjustment);
        customerAdjustment += Number(row.customer_adjustment);
        totalExpense += Number(row.total_expense);
        
        archivedMonthsList.push(Number(row.report_month)); // Yaad rakhne ke liye ke is mahine ka data le liya hai
      });
    }

    /* ======================================================
       2. LIVE CALCULATION (FOR MISSING MONTHS)
    ====================================================== */
    const startMonth = selectedMonth ? selectedMonth : 1;
    const endMonth = selectedMonth ? selectedMonth : 12;

    const tables = ["bookings", "hotels", "visa", "groups", "card", "ticketing", "transport", "ziyarat"];

    for (let m = startMonth; m <= endMonth; m++) {
      // Agar yeh mahina pehle hi archive se plus ho chuka hai, toh iska live data mat nikalo
      if (archivedMonthsList.includes(m)) {
        continue;
      }

      /* LIVE SALES FOR THIS MONTH */
      for (const table of tables) {
        const q = await db.query(`
          SELECT COALESCE(SUM(total_pkr),0) total
          FROM ${table}
          WHERE is_deleted=false
            AND EXTRACT(YEAR FROM created_at)=$1
            AND EXTRACT(MONTH FROM created_at)=$2
        `, [selectedYear, m]);
        
        totalSales += Number(q.rows[0].total || 0);
      }

      /* LIVE PURCHASE FOR THIS MONTH */
      const purchase = await db.query(`
        SELECT
          COALESCE(SUM(purchase_pkr),0) purchase,
          COALESCE(SUM(profit),0) profit
        FROM purchase_entries
        WHERE is_deleted=false
          AND EXTRACT(YEAR FROM created_at)=$1
          AND EXTRACT(MONTH FROM created_at)=$2
      `, [selectedYear, m]);

      totalPurchase += Number(purchase.rows[0].purchase || 0);
      baseProfit += Number(purchase.rows[0].profit || 0);

      /* LIVE SUPPLIER ADJUSTMENT FOR THIS MONTH */
      const supplier = await db.query(`
        SELECT COALESCE(SUM(amount),0) total
        FROM supplier_payments
        WHERE LOWER(type)='adjustment'
          AND EXTRACT(YEAR FROM payment_date)=$1
          AND EXTRACT(MONTH FROM payment_date)=$2
      `, [selectedYear, m]);

      supplierAdjustment += Number(supplier.rows[0].total || 0);

      /* LIVE CUSTOMER ADJUSTMENT FOR THIS MONTH */
      const customer = await db.query(`
        SELECT COALESCE(SUM(amount),0) total
        FROM customer_payments
        WHERE LOWER(type)='adjustment'
          AND EXTRACT(YEAR FROM payment_date)=$1
          AND EXTRACT(MONTH FROM payment_date)=$2
      `, [selectedYear, m]);

      customerAdjustment += Number(customer.rows[0].total || 0);

      /* LIVE EXPENSE FOR THIS MONTH */
      const expense = await db.query(`
        SELECT COALESCE(SUM(amount),0) total
        FROM expense_ledger
        WHERE EXTRACT(YEAR FROM expense_date)=$1
          AND EXTRACT(MONTH FROM expense_date)=$2
      `, [selectedYear, m]);

      totalExpense += Number(expense.rows[0].total || 0);
    }

    // Final Net Profit Calculate karein (Archive + Live dono milakar)
    const netProfit = baseProfit + supplierAdjustment - customerAdjustment - totalExpense;

    // Response Source define karein pehchan ke liye
    let responseSource = "live";
    if (archivedMonthsList.length > 0) {
      responseSource = archivedMonthsList.length === 12 ? "archive" : "combined";
    }

    res.json({
      success: true,
      source: responseSource,
      report: {
        total_sales: Math.round(totalSales),
        total_purchase: Math.round(totalPurchase),
        base_profit: Math.round(baseProfit),
        supplier_adjustment: Math.round(supplierAdjustment),
        customer_adjustment: Math.round(customerAdjustment),
        total_expense: Math.round(totalExpense),
        net_profit: Math.round(netProfit)
      }
    });

  } catch (err) {
    console.error("PROFIT REPORT ERROR:", err);
    res.json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;