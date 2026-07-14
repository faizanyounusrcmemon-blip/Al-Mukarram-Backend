const express = require("express");
const router = express.Router();
const db = require("../db");
const fs = require("fs-extra");
const path = require("path");
const archiver = require("archiver");
const { stringify } = require("csv-stringify/sync");
const multer = require("multer");
const unzipper = require("unzipper");
const { parse } = require("csv-parse/sync"); // CSV parse karne ke liye

// Multer in-memory storage configuration
const upload = multer({ storage: multer.memoryStorage() });

// Note: Ab is function ko zipPath ya zipName return karne ki zaroorat nahi, yeh direct response me write karega.
async function createArchiveBackup(fromDate, toDate, res) {
  const archive = archiver("zip", { zlib: { level: 9 } });

  // Browser ko batane ke liye k yeh ek downloadable ZIP file hai
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const zipName = `archive-${fromDate}-${toDate}-${stamp}.zip`;
  
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=${zipName}`);

  // Direct archive ko response (res) ke sath jod dein
  archive.pipe(res);

  const tables = [
    "bookings", "hotels", "visa", "card", "ticketing", "transport", "ziyarat", "groups",
    "purchase_entries", "customer_payments", "supplier_payments", "expense_ledger",
    "bank_transactions", "cash_transactions",
    "archive_snapshots", "archive_balances", "archive_profit_monthly", "archive_logs"
  ];

  for (const table of tables) {
    let query = `SELECT * FROM ${table}`;
    let params = [];

    if (!table.startsWith("archive_")) {
      if (["bookings", "hotels", "visa", "card", "ticketing", "transport", "ziyarat", "groups"].includes(table)) {
        query += ` WHERE booking_date BETWEEN $1 AND $2`;
        params = [fromDate, toDate];
      } else if (table === "purchase_entries") {
        query += ` WHERE created_at::date BETWEEN $1 AND $2`;
        params = [fromDate, toDate];
      } else if (["customer_payments", "supplier_payments"].includes(table)) {
        query += ` WHERE payment_date BETWEEN $1 AND $2`;
        params = [fromDate, toDate];
      } else if (table === "expense_ledger") {
        query += ` WHERE expense_date BETWEEN $1 AND $2`;
        params = [fromDate, toDate];
      } else if (["bank_transactions", "cash_transactions"].includes(table)) {
        query += ` WHERE created_at::date BETWEEN $1 AND $2`;
        params = [fromDate, toDate];
      }
    }

    const result = await db.query(query, params);
    
    // ⭐ BACKUP ENGINE FIX: Data ko sanitize karein taake null values track ho sakein
    const sanitizedRows = result.rows.map(row => {
      const newRow = { ...row };

      Object.keys(newRow).forEach(col => {
        const colName = col.toLowerCase();
        
        // Agar column delete flag hai aur database mein empty ya null hai toh 'false' string set karein
        if (colName.includes("delete") || colName === "is_delete" || colName === "is_deleted") {
          if (newRow[col] === null || newRow[col] === undefined || newRow[col] === "") {
            newRow[col] = false;
          }
        }
      });

      return newRow;
    });

    // ⭐ CSV-STRINGIFY CASTING FIX: Yeh settings ensure karengi ke 0 aur false gayab na hon CSV se
    const csv = stringify(sanitizedRows, { 
      header: true,
      cast: {
        boolean: function(value) {
          return value ? "true" : "false"; // Boolean values explicit text banengi
        },
        number: function(value) {
          return String(value); // '0' ya negative values hamesha visible rahengi
        }
      }
    });

    archive.append(csv, { name: `${table}.csv` });
  }

  await archive.finalize();
}
/* =========================================================================
   PREVIEW ROUTE (UPDATED FOR NEGATIVE/ZERO SUPPLIER BALANCES)
========================================================================= */
router.post("/preview", async (req, res) => {
  try {
    const { date_from, date_to } = req.body;

    if (!date_from || !date_to) {
      return res.json({ success: false, error: "Date range required" });
    }

    const fromDate = new Date(date_from).toISOString().split("T")[0];
    const toDate = new Date(date_to).toISOString().split("T")[0];

    const lastSnapshot = await db.query(`
      SELECT id, opening_cash, opening_bank, date_to 
      FROM archive_snapshots 
      WHERE date_to < $1 
      ORDER BY date_to DESC, id DESC LIMIT 1
    `, [toDate]);

    let baseCash = 0;
    let baseBank = 0;
    let calculationStartDate = '1970-01-01'; 

    if (lastSnapshot.rows.length > 0) {
      baseCash = Number(lastSnapshot.rows[0].opening_cash || 0);
      baseBank = Number(lastSnapshot.rows[0].opening_bank || 0);
      calculationStartDate = lastSnapshot.rows[0].date_to;
    }

    const openingCashLive = await db.query(`
      SELECT COALESCE(SUM(balance),0) AS total FROM (
        SELECT SUM(cp.amount) AS balance FROM customer_payments cp
        WHERE LOWER(COALESCE(cp.payment_method,''))='cash' AND cp.payment_date > $1 AND cp.payment_date <= $2 AND LOWER(COALESCE(cp.type,''))!='adjustment' AND cp.is_deleted=false
        UNION ALL
        SELECT -SUM(sp.amount) AS balance FROM supplier_payments sp
        WHERE LOWER(sp.payment_method)='cash' AND sp.payment_date > $1 AND sp.payment_date <= $2 AND LOWER(COALESCE(sp.type,''))!='adjustment'
        UNION ALL
        SELECT -SUM(e.amount) AS balance FROM expense_ledger e
        WHERE LOWER(e.payment_method)='cash' AND e.expense_date > $1 AND e.expense_date <= $2
        UNION ALL
        SELECT SUM(CASE WHEN type='deposit' THEN amount WHEN type='withdraw' THEN -amount ELSE 0 END) AS balance FROM cash_transactions
        WHERE created_at::date > $1 AND created_at::date <= $2
      ) x
    `, [calculationStartDate, toDate]);

    const openingBankLive = await db.query(`
      SELECT COALESCE(SUM(balance),0) AS total FROM (
        SELECT SUM(cp.amount) AS balance FROM customer_payments cp
        WHERE LOWER(COALESCE(cp.payment_method,''))='bank' AND cp.payment_date > $1 AND cp.payment_date <= $2 AND LOWER(COALESCE(cp.type,''))!='adjustment' AND cp.is_deleted=false
        UNION ALL
        SELECT -SUM(sp.amount) AS balance FROM supplier_payments sp
        WHERE LOWER(sp.payment_method)='bank' AND sp.payment_date > $1 AND sp.payment_date <= $2 AND LOWER(COALESCE(sp.type,''))!='adjustment'
        UNION ALL
        SELECT -SUM(e.amount) AS balance FROM expense_ledger e
        WHERE LOWER(e.payment_method)='bank' AND e.expense_date > $1 AND e.expense_date <= $2
        UNION ALL
        SELECT SUM(CASE WHEN type='deposit' THEN amount WHEN type='withdraw' THEN -amount ELSE 0 END) AS balance FROM bank_transactions
        WHERE created_at::date > $1 AND created_at::date <= $2
      ) x
    `, [calculationStartDate, toDate]);

    const openingProfit = await db.query(`
      SELECT COALESCE(SUM(net_profit),0) total FROM archive_profit_monthly WHERE archive_to <= $1
    `, [toDate]);

    /* CUSTOMER OUTSTANDING */
    const customers = await db.query(`
      SELECT x.ref_no, x.customer_name, x.payment_status, x.total_pkr, COALESCE(cp.received,0) AS received,
             (COALESCE(x.total_pkr,0) - COALESCE(cp.received,0)) AS balance
      FROM (
        SELECT ref_no, customer_name, payment_status::text, total_pkr FROM bookings WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
        UNION ALL
        SELECT ref_no, customer_name, payment_status::text, total_pkr FROM hotels WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
        UNION ALL
        SELECT ref_no, customer_name, payment_status::text, total_pkr FROM visa WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
        UNION ALL
        SELECT ref_no, customer_name, payment_status::text, total_pkr FROM card WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
        UNION ALL
        SELECT ref_no, customer_name, payment_status::text, total_pkr FROM ticketing WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
        UNION ALL
        SELECT ref_no, customer_name, payment_status::text, total_pkr FROM transport WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
        UNION ALL
        SELECT ref_no, customer_name, payment_status::text, total_pkr FROM groups WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
        UNION ALL
        SELECT ref_no, customer_name, payment_status::text, total_pkr FROM ziyarat WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
      ) x
      LEFT JOIN (
        SELECT ref_no, SUM(amount) received FROM customer_payments WHERE payment_date <= $2 GROUP BY ref_no
      ) cp ON cp.ref_no=x.ref_no
      WHERE COALESCE(x.payment_status,'') IN ('PENDING','PARTIAL') AND (COALESCE(x.total_pkr,0) - COALESCE(cp.received,0)) > 0
      ORDER BY balance DESC
    `, [fromDate, toDate]);

/* SUPPLIER OUTSTANDING (UPDATED: SKIPS ZERO BALANCES, ALLOWS POSITIVE & NEGATIVE) */
const lastSnapshotId = lastSnapshot.rows[0]?.id || 0;
const suppliers = await db.query(`
  SELECT s.supplier_code, s.supplier_name,
         (COALESCE(past.snap_bal,0) + COALESCE(SUM(pe.purchase_pkr),0) - COALESCE(sp.paid,0)) AS balance
  FROM suppliers s
  LEFT JOIN (
    SELECT code, COALESCE(balance,0) as snap_bal FROM archive_balances 
    WHERE balance_type='SUPPLIER' AND snapshot_id = $3
  ) past ON past.code = s.supplier_code
  LEFT JOIN purchase_entries pe ON pe.supplier_code=s.supplier_code AND pe.is_deleted=false AND pe.created_at::date BETWEEN $1 AND $2
  LEFT JOIN (
    SELECT supplier_id, SUM(amount) paid FROM supplier_payments WHERE payment_date BETWEEN $1 AND $2 GROUP BY supplier_id
  ) sp ON sp.supplier_id=s.id
  WHERE s.is_deleted=false
  GROUP BY s.id, s.supplier_code, s.supplier_name, sp.paid, past.snap_bal
  HAVING (COALESCE(past.snap_bal,0) + COALESCE(SUM(pe.purchase_pkr),0) - COALESCE(sp.paid,0)) <> 0
  ORDER BY balance DESC
`, [fromDate, toDate, lastSnapshotId]);

    res.json({
      success: true,
      opening_cash: baseCash + Number(openingCashLive.rows[0].total || 0),
      opening_bank: baseBank + Number(openingBankLive.rows[0].total || 0),
      opening_profit: Number(openingProfit.rows[0].total || 0),
      customer_count: customers.rows.length,
      supplier_count: suppliers.rows.length,
      customers: customers.rows,
      suppliers: suppliers.rows
    });

  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message });
  }
});

/* =========================================================================
   CREATE SNAPSHOT ROUTE (UPDATED FOR NEGATIVE/ZERO SUPPLIER BALANCES)
========================================================================= */
router.post("/snapshot", async (req, res) => {
  const client = await db.connect();
  try {
    const { from_date, to_date } = req.body;

    if (!from_date || !to_date) {
      return res.json({ success: false, error: "Date range required" });
    }

    const fromDate = new Date(from_date).toISOString().split("T")[0];
    const toDate = new Date(to_date).toISOString().split("T")[0];

    await client.query("BEGIN");

    const lastSnapshot = await client.query(`
      SELECT id, opening_cash, opening_bank, date_to 
      FROM archive_snapshots 
      WHERE date_to < $1 
      ORDER BY date_to DESC, id DESC LIMIT 1
    `, [toDate]);

    const lastSnapshotId = lastSnapshot.rows[0]?.id || 0;
    const snapCash = Number(lastSnapshot.rows[0]?.opening_cash || 0);
    const snapBank = Number(lastSnapshot.rows[0]?.opening_bank || 0);
    let calculationStartDate = '1970-01-01';

    if (lastSnapshot.rows.length > 0) {
      calculationStartDate = lastSnapshot.rows[0].date_to;
    }

    const openingCash = await client.query(`
      SELECT COALESCE(SUM(balance),0) AS total FROM (
        SELECT SUM(cp.amount) AS balance FROM customer_payments cp
        WHERE LOWER(cp.payment_method)='cash' AND cp.payment_date > $1 AND cp.payment_date <= $2 AND LOWER(COALESCE(cp.type,''))!='adjustment' AND cp.is_deleted=false
        UNION ALL
        SELECT -SUM(sp.amount) AS balance FROM supplier_payments sp
        WHERE LOWER(sp.payment_method)='cash' AND sp.payment_date > $1 AND sp.payment_date <= $2 AND LOWER(COALESCE(sp.type,''))!='adjustment'
        UNION ALL
        SELECT -SUM(e.amount) AS balance FROM expense_ledger e
        WHERE LOWER(e.payment_method)='cash' AND e.expense_date > $1 AND e.expense_date <= $2
        UNION ALL
        SELECT SUM(CASE WHEN type='deposit' THEN amount WHEN type='withdraw' THEN -amount ELSE 0 END) AS balance FROM cash_transactions
        WHERE created_at::date > $1 AND created_at::date <= $2
      ) x
    `, [calculationStartDate, toDate]);

    const openingBank = await client.query(`
      SELECT COALESCE(SUM(balance),0) AS total FROM (
        SELECT SUM(cp.amount) AS balance FROM customer_payments cp
        WHERE LOWER(cp.payment_method)='bank' AND cp.payment_date > $1 AND cp.payment_date <= $2 AND LOWER(COALESCE(cp.type,''))!='adjustment' AND cp.is_deleted=false
        UNION ALL
        SELECT -SUM(sp.amount) AS balance FROM supplier_payments sp
        WHERE LOWER(sp.payment_method)='bank' AND sp.payment_date > $1 AND sp.payment_date <= $2 AND LOWER(COALESCE(sp.type,''))!='adjustment'
        UNION ALL
        SELECT -SUM(e.amount) AS balance FROM expense_ledger e
        WHERE LOWER(e.payment_method)='bank' AND e.expense_date > $1 AND e.expense_date <= $2
        UNION ALL
        SELECT SUM(CASE WHEN type='deposit' THEN amount WHEN type='withdraw' THEN -amount ELSE 0 END) AS balance FROM bank_transactions
        WHERE created_at::date > $1 AND created_at::date <= $2
      ) x
    `, [calculationStartDate, toDate]);

    const openingProfit = await client.query(`
      SELECT COALESCE(SUM(net_profit),0) AS total FROM archive_profit_monthly WHERE archive_to <= $1
    `, [toDate]);

    const finalCash = snapCash + Number(openingCash.rows[0].total || 0);
    const finalBank = snapBank + Number(openingBank.rows[0].total || 0);

    const snapshotRes = await client.query(`
      INSERT INTO archive_snapshots
      (date_from, date_to, opening_cash, opening_bank, opening_profit, total_customer_receivable, total_supplier_payable)
      VALUES ($1, $2, $3, $4, $5, 0, 0)
      RETURNING id
    `, [
      fromDate, toDate,
      finalCash, finalBank,
      Number(openingProfit.rows[0].total || 0)
    ]);

    const snapshotId = snapshotRes.rows[0].id;

    /* CUSTOMER BALANCE */
    const customers = await client.query(`
      SELECT x.ref_no, x.customer_name, x.payment_status, x.total_pkr, COALESCE(cp.received,0) received,
             (COALESCE(x.total_pkr,0) - COALESCE(cp.received,0)) balance
      FROM (
        SELECT ref_no,customer_name, payment_status::text,total_pkr FROM bookings WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
        UNION ALL
        SELECT ref_no,customer_name, payment_status::text,total_pkr FROM hotels WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
        UNION ALL
        SELECT ref_no,customer_name, payment_status::text,total_pkr FROM visa WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
        UNION ALL
        SELECT ref_no,customer_name, payment_status::text,total_pkr FROM card WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
        UNION ALL
        SELECT ref_no,customer_name, payment_status::text,total_pkr FROM groups WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
        UNION ALL
        SELECT ref_no,customer_name, payment_status::text,total_pkr FROM ticketing WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
        UNION ALL
        SELECT ref_no,customer_name, payment_status::text,total_pkr FROM transport WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
        UNION ALL
        SELECT ref_no,customer_name, payment_status::text,total_pkr FROM ziyarat WHERE is_deleted=false AND booking_date BETWEEN $1 AND $2
      ) x
      LEFT JOIN (
        SELECT ref_no, SUM(amount) received FROM customer_payments WHERE payment_date <= $2 GROUP BY ref_no
      ) cp ON cp.ref_no=x.ref_no
      WHERE COALESCE(x.payment_status,'') IN ('PENDING','PARTIAL') AND (COALESCE(x.total_pkr,0) - COALESCE(cp.received,0)) > 0
    `, [fromDate, toDate]);

    let customerTotal = 0;
    let customerCount = 0;

    for (const c of customers.rows) {
      const balance = Number(c.balance || 0);
      await client.query(`
        INSERT INTO archive_balances (snapshot_id, balance_type, code, name, balance, status)
        VALUES ($1, 'CUSTOMER', $2, $3, $4, $5)
      `, [snapshotId, c.ref_no, c.customer_name, balance, c.payment_status]);

      customerTotal += balance;
      customerCount++;
    }

/* SUPPLIER BALANCE (UPDATED: SKIPS ZERO BALANCES, ALLOWS POSITIVE & NEGATIVE) */
const suppliers = await client.query(`
  SELECT s.supplier_code, s.supplier_name,
         (COALESCE(past.snap_bal,0) + COALESCE(SUM(pe.purchase_pkr),0) - COALESCE(sp.paid,0)) AS balance
  FROM suppliers s
  LEFT JOIN (
    SELECT code, COALESCE(balance,0) as snap_bal FROM archive_balances 
    WHERE balance_type='SUPPLIER' AND snapshot_id = $3
  ) past ON past.code = s.supplier_code
  LEFT JOIN purchase_entries pe ON pe.supplier_code=s.supplier_code AND pe.is_deleted=false AND pe.created_at::date BETWEEN $1 AND $2
  LEFT JOIN (
    SELECT supplier_id, SUM(amount) paid FROM supplier_payments WHERE payment_date BETWEEN $1 AND $2 GROUP BY supplier_id
  ) sp ON sp.supplier_id=s.id
  WHERE s.is_deleted=false
  GROUP BY s.id, s.supplier_code, s.supplier_name, sp.paid, past.snap_bal
  HAVING (COALESCE(past.snap_bal,0) + COALESCE(SUM(pe.purchase_pkr),0) - COALESCE(sp.paid,0)) <> 0
  ORDER BY balance DESC
`, [fromDate, toDate, lastSnapshotId]);

let supplierTotal = 0;
let supplierCount = 0;

for (const s of suppliers.rows) {
  const balance = Number(s.balance || 0);
  
  // Double safety check: Agar balance zero hai toh loop agle supplier par chala jaye
  if (balance === 0) continue;
  
  // Status determine karna: Agar balance negative hai toh 'ADVANCE', positive hai toh 'PAYABLE'
  let currentStatus = balance < 0 ? 'ADVANCE' : 'PAYABLE';

  await client.query(`
    INSERT INTO archive_balances (snapshot_id, balance_type, code, name, balance, status)
    VALUES ($1, 'SUPPLIER', $2, $3, $4, $5)
  `, [snapshotId, s.supplier_code, s.supplier_name, balance, currentStatus]);

  supplierTotal += balance;
  supplierCount++;
}

    /* UPDATE TOTALS */
    await client.query(`
      UPDATE archive_snapshots SET total_customer_receivable=$1, total_supplier_payable=$2 WHERE id=$3
    `, [customerTotal, supplierTotal, snapshotId]);

    /* ARCHIVE MONTHLY PROFIT */
    const startDate = new Date(fromDate);
    const endDate = new Date(toDate);
    let current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

    while (current <= endDate) {
      const year = current.getFullYear();
      const month = current.getMonth() + 1;

      const salesQ = await client.query(`
        SELECT COALESCE(SUM(total),0) AS total FROM (
          SELECT COALESCE(SUM(total_pkr),0) total FROM bookings WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
          UNION ALL
          SELECT COALESCE(SUM(total_pkr),0) FROM hotels WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
          UNION ALL
          SELECT COALESCE(SUM(total_pkr),0) FROM visa WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
          UNION ALL
          SELECT COALESCE(SUM(total_pkr),0) FROM card WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
          UNION ALL
          SELECT COALESCE(SUM(total_pkr),0) FROM groups WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
          UNION ALL
          SELECT COALESCE(SUM(total_pkr),0) FROM ticketing WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
          UNION ALL
          SELECT COALESCE(SUM(total_pkr),0) FROM transport WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
          UNION ALL
          SELECT COALESCE(SUM(total_pkr),0) FROM ziyarat WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
        ) x
      `, [year, month]);

      const totalSales = Number(salesQ.rows[0].total || 0);

      const purchaseQ = await client.query(`
        SELECT COALESCE(SUM(purchase_pkr),0) purchase, COALESCE(SUM(profit),0) profit FROM purchase_entries
        WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
      `, [year, month]);

      const totalPurchase = Number(purchaseQ.rows[0].purchase || 0);
      const baseProfit = Number(purchaseQ.rows[0].profit || 0);

      const supplierAdjustmentQ = await client.query(`
        SELECT COALESCE(SUM(sp.amount),0) total FROM supplier_payments sp
        WHERE LOWER(sp.type)='adjustment' AND EXTRACT(YEAR FROM sp.payment_date)=$1 AND EXTRACT(MONTH FROM sp.payment_date)=$2
      `, [year, month]);
      const supplierAdjustment = Number(supplierAdjustmentQ.rows[0].total || 0);

      const customerAdjustmentQ = await client.query(`
        SELECT COALESCE(SUM(amount),0) total FROM customer_payments
        WHERE LOWER(type)='adjustment' AND EXTRACT(YEAR FROM payment_date)=$1 AND EXTRACT(MONTH FROM payment_date)=$2
      `, [year, month]);
      const customerAdjustment = Number(customerAdjustmentQ.rows[0].total || 0);

      const expenseQ = await client.query(`
        SELECT COALESCE(SUM(amount),0) total FROM expense_ledger WHERE EXTRACT(YEAR FROM expense_date)=$1 AND EXTRACT(MONTH FROM expense_date)=$2
      `, [year, month]);
      const totalExpense = Number(expenseQ.rows[0].total || 0);

      const netProfit = baseProfit + supplierAdjustment - customerAdjustment - totalExpense;

      await client.query(`
        INSERT INTO archive_profit_monthly
        (report_year, report_month, total_sales, total_purchase, base_profit, supplier_adjustment, customer_adjustment, total_expense, net_profit, archive_from, archive_to, snapshot_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [year, month, totalSales, totalPurchase, baseProfit, supplierAdjustment, customerAdjustment, totalExpense, netProfit, fromDate, toDate, snapshotId]);

      current.setMonth(current.getMonth() + 1);
    }

await client.query("COMMIT");

    // Vercel Friendly Response: Sirf batayein k snapshot ban gaya hai, ab front-end download trigger karega
    res.json({
      success: true,
      snapshotId,
      customerCount,
      supplierCount,
      opening_cash: finalCash,
      opening_bank: finalBank,
      customer_receivable: customerTotal,
      supplier_payable: supplierTotal,
      fromDate, // Yeh dates wapas bhejen taake front-end is se download api call kare
      toDate
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

/* =========================================================================
   DELETE ROUTE
========================================================================= */
router.post("/delete", async (req, res) => {
  const client = await db.connect();
  try {
    const { from_date, to_date, backup_file } = req.body;

    if (!from_date || !to_date) {
      return res.json({ success: false, error: "Date range required" });
    }

    const fromDate = new Date(from_date).toISOString().split("T")[0];
    const toDate = new Date(to_date).toISOString().split("T")[0];

    await client.query("BEGIN");

    const bookingsCount = await client.query(`SELECT COUNT(*) FROM bookings WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    const hotelsCount = await client.query(`SELECT COUNT(*) FROM hotels WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    const visaCount = await client.query(`SELECT COUNT(*) FROM visa WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    const cardCount = await client.query(`SELECT COUNT(*) FROM card WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    const groupsCount = await client.query(`SELECT COUNT(*) FROM groups WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    const ticketingCount = await client.query(`SELECT COUNT(*) FROM ticketing WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    const transportCount = await client.query(`SELECT COUNT(*) FROM transport WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    const ziyaratCount = await client.query(`SELECT COUNT(*) FROM ziyarat WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    const customerPaymentsCount = await client.query(`SELECT COUNT(*) FROM customer_payments WHERE payment_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    const supplierPaymentsCount = await client.query(`SELECT COUNT(*) FROM supplier_payments WHERE payment_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    const purchaseEntriesCount = await client.query(`SELECT COUNT(*) FROM purchase_entries WHERE created_at::date BETWEEN $1 AND $2`, [fromDate, toDate]);

    const snapshotRes = await client.query(`
      SELECT id FROM archive_snapshots WHERE date_from=$1 AND date_to=$2 ORDER BY id DESC LIMIT 1
    `, [fromDate, toDate]);

    if (snapshotRes.rows.length === 0) {
      throw new Error("Snapshot not found. Create snapshot first.");
    }

    const snapshotId = snapshotRes.rows[0].id;
    let current = new Date(new Date(fromDate).getFullYear(), new Date(fromDate).getMonth(), 1);
    const end = new Date(toDate);

    while (current <= end) {
      const year = current.getFullYear();
      const month = current.getMonth() + 1;

      const salesQ = await client.query(`
        SELECT COALESCE(SUM(total),0)::numeric total FROM (
          SELECT COALESCE(SUM(total_pkr),0)::numeric total FROM bookings WHERE is_deleted=false AND EXTRACT(YEAR FROM booking_date)=$1 AND EXTRACT(MONTH FROM booking_date)=$2
          UNION ALL
          SELECT COALESCE(SUM(total_pkr),0)::numeric FROM hotels WHERE is_deleted=false AND EXTRACT(YEAR FROM booking_date)=$1 AND EXTRACT(MONTH FROM booking_date)=$2
          UNION ALL
          SELECT COALESCE(SUM(total_pkr),0)::numeric FROM visa WHERE is_deleted=false AND EXTRACT(YEAR FROM booking_date)=$1 AND EXTRACT(MONTH FROM booking_date)=$2
          UNION ALL
          SELECT COALESCE(SUM(total_pkr),0)::numeric FROM card WHERE is_deleted=false AND EXTRACT(YEAR FROM booking_date)=$1 AND EXTRACT(MONTH FROM booking_date)=$2
          UNION ALL
          SELECT COALESCE(SUM(total_pkr),0)::numeric FROM groups WHERE is_deleted=false AND EXTRACT(YEAR FROM booking_date)=$1 AND EXTRACT(MONTH FROM booking_date)=$2
          UNION ALL
          SELECT COALESCE(SUM(total_pkr),0)::numeric FROM ticketing WHERE is_deleted=false AND EXTRACT(YEAR FROM booking_date)=$1 AND EXTRACT(MONTH FROM booking_date)=$2
          UNION ALL
          SELECT COALESCE(SUM(total_pkr),0)::numeric FROM transport WHERE is_deleted=false AND EXTRACT(YEAR FROM booking_date)=$1 AND EXTRACT(MONTH FROM booking_date)=$2
          UNION ALL
          SELECT COALESCE(SUM(total_pkr),0)::numeric FROM ziyarat WHERE is_deleted=false AND EXTRACT(YEAR FROM booking_date)=$1 AND EXTRACT(MONTH FROM booking_date)=$2
        ) x
      `, [year, month]);

      const totalSales = Number(salesQ.rows[0].total || 0);

      const purchaseQ = await client.query(`
        SELECT COALESCE(SUM(purchase_pkr),0) purchase, COALESCE(SUM(profit),0) profit FROM purchase_entries
        WHERE is_deleted=false AND EXTRACT(YEAR FROM created_at)=$1 AND EXTRACT(MONTH FROM created_at)=$2
      `, [year, month]);

      const totalPurchase = Number(purchaseQ.rows[0].purchase || 0);
      const baseProfit = Number(purchaseQ.rows[0].profit || 0);

      const supplierAdj = await client.query(`
        SELECT COALESCE(SUM(amount),0) total FROM supplier_payments WHERE LOWER(type)='adjustment' AND EXTRACT(YEAR FROM payment_date)=$1 AND EXTRACT(MONTH FROM payment_date)=$2
      `, [year, month]);
      const supplierAdjustment = Number(supplierAdj.rows[0].total || 0);

      const customerAdj = await client.query(`
        SELECT COALESCE(SUM(amount),0) total FROM customer_payments WHERE LOWER(type)='adjustment' AND EXTRACT(YEAR FROM payment_date)=$1 AND EXTRACT(MONTH FROM payment_date)=$2
      `, [year, month]);
      const customerAdjustment = Number(customerAdj.rows[0].total || 0);

      const expenseQ = await client.query(`
        SELECT COALESCE(SUM(amount),0) total FROM expense_ledger WHERE EXTRACT(YEAR FROM expense_date)=$1 AND EXTRACT(MONTH FROM expense_date)=$2
      `, [year, month]);
      const totalExpense = Number(expenseQ.rows[0].total || 0);

      const netProfit = baseProfit + supplierAdjustment - customerAdjustment - totalExpense;

      await client.query(`DELETE FROM archive_profit_monthly WHERE snapshot_id=$1 AND report_year=$2 AND report_month=$3`, [snapshotId, year, month]);

      await client.query(`
        INSERT INTO archive_profit_monthly (snapshot_id, report_year, report_month, total_sales, total_purchase, base_profit, supplier_adjustment, customer_adjustment, total_expense, net_profit, archive_from, archive_to)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [snapshotId, year, month, totalSales, totalPurchase, baseProfit, supplierAdjustment, customerAdjustment, totalExpense, netProfit, fromDate, toDate]);

      current.setMonth(current.getMonth() + 1);
    }

    /* DELETE STATEMENTS */
    await client.query(`DELETE FROM bookings WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    await client.query(`DELETE FROM hotels WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    await client.query(`DELETE FROM visa WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    await client.query(`DELETE FROM card WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    await client.query(`DELETE FROM groups WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    await client.query(`DELETE FROM ticketing WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    await client.query(`DELETE FROM transport WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    await client.query(`DELETE FROM ziyarat WHERE booking_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    await client.query(`DELETE FROM customer_payments WHERE payment_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    await client.query(`DELETE FROM supplier_payments WHERE payment_date BETWEEN $1 AND $2`, [fromDate, toDate]);
    await client.query(`DELETE FROM purchase_entries WHERE created_at::date BETWEEN $1 AND $2`, [fromDate, toDate]);
    await client.query(`DELETE FROM bank_transactions WHERE created_at::date BETWEEN $1 AND $2`, [fromDate, toDate]);
    await client.query(`DELETE FROM cash_transactions WHERE created_at::date BETWEEN $1 AND $2`, [fromDate, toDate]);
    await client.query(`DELETE FROM expense_ledger WHERE expense_date BETWEEN $1 AND $2`, [fromDate, toDate]);

    await client.query(`
      INSERT INTO archive_logs (snapshot_id, date_from, date_to, bookings_count, hotels_count, visa_count, card_count, ticketing_count, transport_count, ziyarat_count, groups_count, customer_payments_count, purchase_entries_count, supplier_payments_count, deleted_at, backup_file)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, NOW(), $15)
    `, [
      snapshotId, fromDate, toDate,
      Number(bookingsCount.rows[0].count), Number(hotelsCount.rows[0].count), Number(visaCount.rows[0].count), Number(cardCount.rows[0].count), Number(ticketingCount.rows[0].count), Number(transportCount.rows[0].count), Number(groupsCount.rows[0].count), Number(ziyaratCount.rows[0].count),
      Number(customerPaymentsCount.rows[0].count), Number(purchaseEntriesCount.rows[0].count), Number(supplierPaymentsCount.rows[0].count),
      backup_file || null
    ]);

    await client.query("COMMIT");
    return res.json({ success: true, snapshot_id: snapshotId, message: "Archive deleted successfully" });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    return res.json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

/* =========================================================================
   ARCHIVE LIST (STRICT LOGS CHECK LOGIC)
========================================================================= */
router.get("/list", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT s.id, s.date_from, s.date_to,
             COALESCE(s.total_customer_receivable, 0) AS total_customer_receivable,
             COALESCE(s.total_supplier_payable, 0) AS total_supplier_payable,
             COALESCE(s.opening_cash, 0) AS opening_cash,
             COALESCE(s.opening_bank, 0) AS opening_bank,
             COALESCE(s.opening_profit, 0) AS opening_profit,
             s.created_at,
             
             -- ⭐ 1 agar log mil gaya (Data Deleted), 0 agar log nahi mila (Data Not Deleted)
             CASE WHEN EXISTS (
               SELECT 1 FROM archive_logs l WHERE l.snapshot_id = s.id
             ) THEN 1 ELSE 0 END as has_log,
             
             COALESCE((SELECT SUM(ap.net_profit) FROM archive_profit_monthly ap WHERE ap.snapshot_id = s.id), 0) AS total_profit
      FROM archive_snapshots s 
      ORDER BY s.id DESC
    `);
    res.json({ success: true, rows: result.rows });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message });
  }
});

/* =========================================================================
   GET ARCHIVE VIEW DETAILS (FIXED FOR ARCHIVE_BALANCES TABLE)
========================================================================= */
router.get("/view/:id", async (req, res) => {
  const { id } = req.params;
  try {
    // 1. Snapshot base core detail
    const snapshotRes = await db.query(`
      SELECT *, 
             COALESCE((SELECT SUM(net_profit) FROM archive_profit_monthly WHERE snapshot_id = $1), 0) as total_profit
      FROM archive_snapshots 
      WHERE id = $1
    `, [id]);

    if (snapshotRes.rows.length === 0) {
      return res.json({ success: false, error: "Snapshot not found." });
    }

    // 2. Fetch Customer Balances from archive_balances (balance_type lowercase check ke sath)
    const customersRes = await db.query(`
      SELECT id, name, COALESCE(balance, 0) as balance 
      FROM archive_balances 
      WHERE snapshot_id = $1 AND LOWER(balance_type) LIKE '%customer%'
      ORDER BY name ASC
    `, [id]);

    // 3. Fetch Supplier Balances from archive_balances
    const suppliersRes = await db.query(`
      SELECT id, name, COALESCE(balance, 0) as balance 
      FROM archive_balances 
      WHERE snapshot_id = $1 AND LOWER(balance_type) LIKE '%supplier%'
      ORDER BY name ASC
    `, [id]);

    // 4. Monthly profit detail
    const profitRes = await db.query(`
      SELECT id, report_month, report_year, 
             COALESCE(total_sales, 0) as total_sales, 
             COALESCE(total_purchase, 0) as total_purchase, 
             COALESCE(net_profit, 0) as net_profit
      FROM archive_profit_monthly 
      WHERE snapshot_id = $1
      ORDER BY report_year DESC, report_month DESC
    `, [id]);

    // Response packet sending
    res.json({
      success: true,
      snapshot: snapshotRes.rows[0],
      suppliers: suppliersRes.rows,
      customers: customersRes.rows,
      profit: profitRes.rows
    });

  } catch (err) {
    console.error("Backend Archive View Schema Error:", err);
    res.json({ success: false, error: err.message });
  }
});

/* =========================================================================
   GET ARCHIVE DELETE LOGS SUMMARY (FIXED FOR ARCHIVE_LOGS TABLE)
========================================================================= */
router.get("/logs/:id", async (req, res) => {
  const { id } = req.params; // Yeh aapki snapshot_id hai
  try {
    // archive_logs table se exact snapshot_id ka record query karenge
    const logRes = await db.query(`
      SELECT 
        id,
        snapshot_id,
        COALESCE(deleted_at, archived_at) AS deleted_at,
        archived_at,
        COALESCE(bookings_count, 0) AS bookings_count,
        COALESCE(hotels_count, 0) AS hotels_count,
        COALESCE(visa_count, 0) AS visa_count,
        COALESCE(card_count, 0) AS card_count,
        COALESCE(groups_count, 0) AS groups_count,
        COALESCE(ticketing_count, 0) AS ticketing_count,
        COALESCE(transport_count, 0) AS transport_count,
        COALESCE(ziyarat_count, 0) AS ziyarat_count,
        COALESCE(customer_payments_count, 0) AS customer_payments_count,
        COALESCE(supplier_payments_count, 0) AS supplier_payments_count,
        COALESCE(purchase_entries_count, 0) AS purchase_entries_count
      FROM archive_logs 
      WHERE snapshot_id = $1
      LIMIT 1
    `, [id]);

    if (logRes.rows.length === 0) {
      return res.json({ success: false, error: "No delete log found for this archive." });
    }

    // React component ki demand ke mutabik wrapper object return karenge
    res.json({
      success: true,
      log: logRes.rows[0]
    });

  } catch (err) {
    console.error("Archive Logs Route Schema Error:", err);
    res.json({ success: false, error: err.message });
  }
});

/* =========================================================================
   VERCEL COMPATIBLE STREAMING DOWNLOAD ROUTE
========================================================================= */
router.get("/download-stream", async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;

    if (!fromDate || !toDate) {
      return res.status(400).send("Date range parameters required");
    }

    // Direct stream backup to browser
    await createArchiveBackup(fromDate, toDate, res);

  } catch (err) {
    console.error("Backup Download Error:", err);
    if (!res.headersSent) {
      res.status(500).send("Could not generate backup: " + err.message);
    }
  }
});

/* =========================================================================
   VERCEL COMPATIBLE RESTORE ROUTE (WITH BOOLEAN & DATE CAST FIX)
========================================================================= */
router.post("/restore", upload.single("backup_file"), async (req, res) => {
  const client = await db.connect();
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No backup ZIP file uploaded" });
    }

    await client.query("BEGIN");

    // ZIP archive ko memory buffer se read karna
    const directory = await unzipper.Open.buffer(req.file.buffer);
    
    for (const file of directory.files) {
      if (!file.path.endsWith(".csv")) continue;

      const tableName = file.path.replace(".csv", "");
      const contentBuffer = await file.buffer();
      const contentString = contentBuffer.toString("utf-8");

      // CSV data ko parse karke rows nikalna
      const rows = parse(contentString, { columns: true, skip_empty_lines: true });
      if (rows.length === 0) continue;

      console.log(`Restoring ${rows.length} rows into table: ${tableName}`);

      let hasIdColumn = false; 

      for (const row of rows) {
        const columns = Object.keys(row);
        if (columns.includes("id")) {
          hasIdColumn = true;
        }
        
        // ⭐ VALUE FIXING ENGINE (For Millisecond Dates, Booleans & Nulls)
        const sanitizedValues = columns.map(col => {
          let val = row[col];
          
          // Agar value bilkul empty string ya undefined hai, toh SQL NULL bhejein
          // Note: "0" ya "false" string yahan filter nahi hongi kyunki wo empty nahi hain.
          if (val === "" || val === undefined || val === null) return null;

          // ⭐ BOOLEAN FIX: Postgres ko string data types se bachane ke liye actual boolean convert karein
          if (typeof val === "string") {
            if (val.toLowerCase() === "true") return true;
            if (val.toLowerCase() === "false") return false;
          }

          // ⭐ DATE FIX: Agar column ke naam me 'date', 'time', ya 'at' ho aur value pure numbers ho (milliseconds)
          if ((col.toLowerCase().includes("date") || col.toLowerCase().includes("time") || col.toLowerCase().includes("at")) && /^\d+$/.test(val)) {
            const ms = Number(val);
            if (ms > 946684800000) { 
              return new Date(ms).toISOString(); 
            }
          }
          
          return val;
        });

        const colNames = columns.map(c => `"${c}"`).join(", ");
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");

        let insertQuery = `INSERT INTO ${tableName} (${colNames}) VALUES (${placeholders})`;
        
        if (columns.includes("id")) {
          insertQuery += ` ON CONFLICT (id) DO NOTHING`;
        } else if (columns.includes("ref_no") && tableName !== "customer_payments") {
          insertQuery += ` ON CONFLICT (ref_no) DO NOTHING`;
        }

        await client.query(insertQuery, sanitizedValues);
      }

      // ⭐ SCOPE FIX: Postgres id sequence fix
      if (hasIdColumn) {
        await client.query(`
          SELECT setval(pg_get_serial_sequence('${tableName}', 'id'), COALESCE(MAX(id), 1)) FROM ${tableName}
        `).catch(() => {/* sequence nahi hai ya non-serial id hai toh ignore */});
      }
    }

    await client.query("COMMIT");
    res.json({ success: true, message: "Database restored successfully with complete data-type auto-correction!" });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Restore Error:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

router.delete("/delete/:id", async (req, res) => {

  const client = await db.connect();

  try {

    const snapshotId =
      Number(req.params.id);

    if (!snapshotId) {

      return res.json({
        success: false,
        error: "Invalid snapshot id"
      });

    }

    await client.query("BEGIN");

    /* =========================
       CHECK ALREADY DELETED
    ========================= */

    const logCheck = await client.query(`

      SELECT id

      FROM archive_logs

      WHERE snapshot_id=$1

      LIMIT 1

    `,[snapshotId]);

    if (logCheck.rows.length > 0) {

      throw new Error(
        "Archive already deleted"
      );

    }

    /* =========================
       GET SNAPSHOT
    ========================= */

    const snapshot = await client.query(`

      SELECT
        id,
        date_from,
        date_to,
        backup_file

      FROM archive_snapshots

      WHERE id=$1

    `,[snapshotId]);

    if (snapshot.rows.length === 0) {

      throw new Error(
        "Snapshot not found"
      );

    }

    const row = snapshot.rows[0];

    const fromDate = row.date_from;
    const toDate = row.date_to;

    /* =========================
       CALL EXISTING DELETE LOGIC
    ========================= */

    const bookingsCount = await client.query(
      `SELECT COUNT(*) FROM bookings
       WHERE booking_date BETWEEN $1 AND $2`,
      [fromDate,toDate]
    );

    const hotelsCount = await client.query(
      `SELECT COUNT(*) FROM hotels
       WHERE booking_date BETWEEN $1 AND $2`,
      [fromDate,toDate]
    );

    const visaCount = await client.query(
      `SELECT COUNT(*) FROM visa
       WHERE booking_date BETWEEN $1 AND $2`,
      [fromDate,toDate]
    );

    const cardCount = await client.query(
      `SELECT COUNT(*) FROM card
       WHERE booking_date BETWEEN $1 AND $2`,
      [fromDate,toDate]
    );

    const groupsCount = await client.query(
      `SELECT COUNT(*) FROM groups
       WHERE booking_date BETWEEN $1 AND $2`,
      [fromDate,toDate]
    );

    const ticketingCount = await client.query(
      `SELECT COUNT(*) FROM ticketing
       WHERE booking_date BETWEEN $1 AND $2`,
      [fromDate,toDate]
    );

    const transportCount = await client.query(
      `SELECT COUNT(*) FROM transport
       WHERE booking_date BETWEEN $1 AND $2`,
      [fromDate,toDate]
    );

    const ziyaratCount = await client.query(
      `SELECT COUNT(*) FROM ziyarat
       WHERE booking_date BETWEEN $1 AND $2`,
      [fromDate,toDate]
    );

    const customerPaymentsCount = await client.query(
      `SELECT COUNT(*) FROM customer_payments
       WHERE payment_date BETWEEN $1 AND $2`,
      [fromDate,toDate]
    );

    const supplierPaymentsCount = await client.query(
      `SELECT COUNT(*) FROM supplier_payments
       WHERE payment_date BETWEEN $1 AND $2`,
      [fromDate,toDate]
    );

    const purchaseEntriesCount = await client.query(
      `SELECT COUNT(*) FROM purchase_entries
       WHERE created_at::date BETWEEN $1 AND $2`,
      [fromDate,toDate]
    );

    /* =========================
       DELETE DATA
    ========================= */

    await client.query(`
      DELETE FROM bookings
      WHERE booking_date BETWEEN $1 AND $2
    `,[fromDate,toDate]);

    await client.query(`
      DELETE FROM hotels
      WHERE booking_date BETWEEN $1 AND $2
    `,[fromDate,toDate]);

    await client.query(`
      DELETE FROM visa
      WHERE booking_date BETWEEN $1 AND $2
    `,[fromDate,toDate]);

    await client.query(`
      DELETE FROM card
      WHERE booking_date BETWEEN $1 AND $2
    `,[fromDate,toDate]);

    await client.query(`
      DELETE FROM groups
      WHERE booking_date BETWEEN $1 AND $2
    `,[fromDate,toDate]);

    await client.query(`
      DELETE FROM ticketing
      WHERE booking_date BETWEEN $1 AND $2
    `,[fromDate,toDate]);

    await client.query(`
      DELETE FROM transport
      WHERE booking_date BETWEEN $1 AND $2
    `,[fromDate,toDate]);

    await client.query(`
      DELETE FROM ziyarat
      WHERE booking_date BETWEEN $1 AND $2
    `,[fromDate,toDate]);

    await client.query(`
      DELETE FROM customer_payments
      WHERE payment_date BETWEEN $1 AND $2
    `,[fromDate,toDate]);

    await client.query(`
      DELETE FROM supplier_payments
      WHERE payment_date BETWEEN $1 AND $2
    `,[fromDate,toDate]);

    await client.query(`
      DELETE FROM purchase_entries
      WHERE created_at::date BETWEEN $1 AND $2
    `,[fromDate,toDate]);

    await client.query(`
      DELETE FROM expense_ledger
      WHERE expense_date BETWEEN $1 AND $2
    `,[fromDate,toDate]);

    await client.query(`
      DELETE FROM bank_transactions
      WHERE created_at::date BETWEEN $1 AND $2
    `,[fromDate,toDate]);

    await client.query(`
      DELETE FROM cash_transactions
      WHERE created_at::date BETWEEN $1 AND $2
    `,[fromDate,toDate]);

/* =========================
   CREATE LOG (FIXED PLACEHOLDERS)
========================= */

await client.query(`
  INSERT INTO archive_logs
  (
    snapshot_id,
    date_from,
    date_to,

    bookings_count,
    hotels_count,
    visa_count,
    card_count,
    groups_count,
    ticketing_count,
    transport_count,
    ziyarat_count,

    customer_payments_count,
    purchase_entries_count,
    supplier_payments_count,

    deleted_at,
    backup_file
  )
  VALUES
  (
    $1, $2, $3,
    $4, $5, $6, $7, $8, $9, $10, $11,
    $12, $13, $14,
    NOW(),
    $15
  )
`, [
  snapshotId,                                  // $1
  fromDate,                                    // $2
  toDate,                                      // $3
  Number(bookingsCount.rows[0].count),         // $4
  Number(hotelsCount.rows[0].count),           // $5
  Number(visaCount.rows[0].count),             // $6
  Number(cardCount.rows[0].count),             // $7
  Number(groupsCount.rows[0].count),           // $8
  Number(ticketingCount.rows[0].count),        // $9
  Number(transportCount.rows[0].count),        // $10
  Number(ziyaratCount.rows[0].count),          // $11
  Number(customerPaymentsCount.rows[0].count), // $12
  Number(purchaseEntriesCount.rows[0].count),  // $13
  Number(supplierPaymentsCount.rows[0].count),  // $14
  row.backup_file || null                      // $15
]);

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Archive deleted successfully"
    });

  } catch (err) {

    await client.query("ROLLBACK");

    return res.json({
      success: false,
      error: err.message
    });

  } finally {

    client.release();

  }

});

router.delete(
  "/delete-snapshot/:id",
  async (req, res) => {

    try {

      const id =
        Number(req.params.id);

      if (!id) {

        return res.json({
          success: false,
          error: "Invalid snapshot id"
        });

      }

      await db.query(
        "DELETE FROM archive_balances WHERE snapshot_id=$1",
        [id]
      );

      await db.query(
        "DELETE FROM archive_profit_monthly WHERE snapshot_id=$1",
        [id]
      );

      await db.query(
        "DELETE FROM archive_logs WHERE snapshot_id=$1",
        [id]
      );

      await db.query(
        "DELETE FROM archive_snapshots WHERE id=$1",
        [id]
      );

      return res.json({
        success: true
      });

    } catch (err) {

      return res.json({
        success: false,
        error: err.message
      });

    }

  }
);

// GET LIVE DATABASE START DATE (Supabase live data coverage)
router.get("/live-data-start", async (req, res) => {
  try {
    // Note: Agar aapki table ka naam 'bookings' nahi hai toh yahan apni actual main table ka naam likhein
    const dateRes = await db.query(`
      SELECT MIN(created_at) as first_date FROM bookings
    `);

    let startDate = null;
    if (dateRes.rows.length > 0 && dateRes.rows[0].first_date) {
      startDate = dateRes.rows[0].first_date;
    }

    res.json({
      success: true,
      first_date: startDate // Format: YYYY-MM-DD
    });
  } catch (err) {
    console.error("Error fetching live data start date:", err);
    res.json({ success: false, first_date: null });
  }
});

module.exports = router;