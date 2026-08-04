const express = require("express");
const router = express.Router();
const db = require("../db");

/* =========================================
   BALANCE SHEET (FIXED: CUSTOMER NAME FALLBACK)
========================================= */
router.get("/", async (req, res) => {
  try {
    let snapshotId = null;
    let snapshotDate = null;

    const snapshot = await db.query(`
      SELECT id, date_to FROM archive_snapshots ORDER BY id DESC LIMIT 1
    `);

    if (snapshot.rows.length) {
      snapshotId = snapshot.rows[0].id;
      snapshotDate = snapshot.rows[0].date_to;
    }

    /* ========== 1. ALL REGISTERED CUSTOMER CODES ========== */
    const regCustomerCodesRes = await db.query(`
      SELECT DISTINCT customer_code FROM bookings WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION SELECT customer_code FROM hotels WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION SELECT customer_code FROM visa WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION SELECT customer_code FROM card WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION SELECT customer_code FROM groups WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION SELECT customer_code FROM ticketing WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION SELECT customer_code FROM transport WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION SELECT customer_code FROM ziyarat WHERE customer_code IS NOT NULL AND customer_code != '' AND is_deleted=false
      UNION SELECT ref_no AS customer_code FROM customer_payments WHERE ref_no LIKE 'CUST-%' AND is_deleted=false
      UNION SELECT code AS customer_code FROM archive_balances WHERE snapshot_id = $1 AND UPPER(balance_type) = 'CUSTOMER' AND code LIKE 'CUST-%'
    `, [snapshotId]);

    const regCodes = regCustomerCodesRes.rows.map(row => row.customer_code).filter(Boolean);

    /* ========== 2. ARCHIVE SNAPSHOT BALANCES ========== */
    const customerSnapshotRes = await db.query(`
      SELECT code, name, balance FROM archive_balances WHERE snapshot_id = $1 AND UPPER(balance_type) = 'CUSTOMER'
    `, [snapshotId]);
    const customerSnapshot = customerSnapshotRes.rows;

    const supplierSnapshotRes = await db.query(`
      SELECT code, balance FROM archive_balances WHERE snapshot_id = $1 AND UPPER(balance_type) = 'SUPPLIER'
    `, [snapshotId]);
    const supplierSnapshot = supplierSnapshotRes.rows;

    /* ========== 3. STANDARD MODULE CUSTOMERS (WALK-IN) ========== */
    const customersData = await db.query(`
      SELECT * FROM (
        SELECT ref_no, customer_name, payment_status, total_pkr FROM bookings WHERE is_deleted = false AND ($1::date IS NULL OR created_at::date > $1) AND (customer_code IS NULL OR customer_code = '')
        UNION ALL
        SELECT ref_no, customer_name, payment_status, total_pkr FROM hotels WHERE is_deleted = false AND ($1::date IS NULL OR created_at::date > $1) AND (customer_code IS NULL OR customer_code = '')
        UNION ALL
        SELECT ref_no, customer_name, payment_status, total_pkr FROM visa WHERE is_deleted = false AND ($1::date IS NULL OR created_at::date > $1) AND (customer_code IS NULL OR customer_code = '')
        UNION ALL
        SELECT ref_no, customer_name, payment_status, total_pkr FROM card WHERE is_deleted = false AND ($1::date IS NULL OR created_at::date > $1) AND (customer_code IS NULL OR customer_code = '')
        UNION ALL
        SELECT ref_no, customer_name, payment_status, total_pkr FROM groups WHERE is_deleted = false AND ($1::date IS NULL OR created_at::date > $1) AND (customer_code IS NULL OR customer_code = '')
        UNION ALL
        SELECT ref_no, customer_name, payment_status, total_pkr FROM ticketing WHERE is_deleted = false AND ($1::date IS NULL OR created_at::date > $1) AND (customer_code IS NULL OR customer_code = '')
        UNION ALL
        SELECT ref_no, customer_name, payment_status, total_pkr FROM transport WHERE is_deleted = false AND ($1::date IS NULL OR created_at::date > $1) AND (customer_code IS NULL OR customer_code = '')
        UNION ALL
        SELECT ref_no, customer_name, payment_status, total_pkr FROM ziyarat WHERE is_deleted = false AND ($1::date IS NULL OR created_at::date > $1) AND (customer_code IS NULL OR customer_code = '')
      ) x
    `, [snapshotDate]);

    const payments = await db.query(`
      SELECT ref_no, COALESCE(SUM(amount),0) AS received
      FROM customer_payments
      WHERE ($1::date IS NULL OR payment_date::date > $1) AND type != 'opening_balance' AND is_deleted = false
      GROUP BY ref_no
    `, [snapshotDate]);

    // Unique standard ref_nos combining sales & snapshot
    const allStdRefNos = Array.from(new Set([
      ...customersData.rows.map(r => r.ref_no),
      ...customerSnapshot.filter(s => !s.code.startsWith("CUST-")).map(s => s.code)
    ]));

    let standardCustomerRows = allStdRefNos.map(refNo => {
      const salesRows = customersData.rows.filter(r => r.ref_no === refNo);
      const saleTotal = salesRows.reduce((acc, curr) => acc + Number(curr.total_pkr || 0), 0);
      const received = Number(payments.rows.find(p => p.ref_no === refNo)?.received || 0);

      const snapItem = customerSnapshot.find(x => x.code === refNo);
      const openingBalance = Number(snapItem?.balance || 0);
      const balance = openingBalance + saleTotal - received;

      // Extract Name properly from sales module or archive snapshot
      const foundName = salesRows.find(r => r.customer_name && r.customer_name.trim() !== '')?.customer_name 
                      || snapItem?.name 
                      || "Walk-In Customer";

      let status = salesRows[0]?.payment_status || "PENDING";
      if (balance <= 0 && saleTotal + openingBalance > 0) status = balance === 0 ? "PAID" : "EXTRA PAID";

      return {
        ref_no: refNo,
        customer_name: foundName,
        sale_total: saleTotal + openingBalance,
        received,
        balance,
        status
      };
    }).filter(r => r.balance !== 0 || r.sale_total !== 0);

    /* ========== 4. REGISTERED CUSTOMERS BALANCES ========== */
    let registeredRows = [];
    if (regCodes.length > 0) {
      const regSalesAndPayments = await db.query(`
        WITH all_debits AS (
          SELECT customer_code, total_pkr AS amount FROM bookings WHERE customer_code = ANY($1) AND is_deleted=false AND ($2::date IS NULL OR created_at::date > $2)
          UNION ALL SELECT customer_code, total_pkr FROM hotels WHERE customer_code = ANY($1) AND is_deleted=false AND ($2::date IS NULL OR created_at::date > $2)
          UNION ALL SELECT customer_code, total_pkr FROM visa WHERE customer_code = ANY($1) AND is_deleted=false AND ($2::date IS NULL OR created_at::date > $2)
          UNION ALL SELECT customer_code, total_pkr FROM card WHERE customer_code = ANY($1) AND is_deleted=false AND ($2::date IS NULL OR created_at::date > $2)
          UNION ALL SELECT customer_code, total_pkr FROM groups WHERE customer_code = ANY($1) AND is_deleted=false AND ($2::date IS NULL OR created_at::date > $2)
          UNION ALL SELECT customer_code, total_pkr FROM ticketing WHERE customer_code = ANY($1) AND is_deleted=false AND ($2::date IS NULL OR created_at::date > $2)
          UNION ALL SELECT customer_code, total_pkr FROM transport WHERE customer_code = ANY($1) AND is_deleted=false AND ($2::date IS NULL OR created_at::date > $2)
          UNION ALL SELECT customer_code, total_pkr FROM ziyarat WHERE customer_code = ANY($1) AND is_deleted=false AND ($2::date IS NULL OR created_at::date > $2)
          UNION ALL SELECT ref_no AS customer_code, amount FROM customer_payments WHERE ref_no = ANY($1) AND type='opening_balance' AND is_deleted=false AND ($2::date IS NULL OR payment_date::date > $2)
        ),
        all_credits AS (
          SELECT ref_no AS customer_code, amount FROM customer_payments WHERE ref_no = ANY($1) AND type != 'opening_balance' AND is_deleted=false AND ($2::date IS NULL OR payment_date::date > $2)
        ),
        customer_names AS (
          SELECT DISTINCT ON (customer_code) customer_code, customer_name
          FROM (
            SELECT customer_code, customer_name FROM bookings WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
            UNION ALL SELECT customer_code, customer_name FROM hotels WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
            UNION ALL SELECT customer_code, customer_name FROM visa WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
            UNION ALL SELECT customer_code, customer_name FROM card WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
            UNION ALL SELECT customer_code, customer_name FROM groups WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
            UNION ALL SELECT customer_code, customer_name FROM ticketing WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
            UNION ALL SELECT customer_code, customer_name FROM transport WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
            UNION ALL SELECT customer_code, customer_name FROM ziyarat WHERE customer_code = ANY($1) AND customer_name IS NOT NULL AND customer_name != '' AND is_deleted=false
            UNION ALL SELECT customer_code, name AS customer_name FROM customers WHERE customer_code = ANY($1) AND name IS NOT NULL AND name != ''
            UNION ALL SELECT code AS customer_code, name AS customer_name FROM archive_balances WHERE code = ANY($1) AND name IS NOT NULL AND name != ''
          ) n
        )
        SELECT 
          a.customer_code,
          COALESCE(n.customer_name, 'Registered Client') AS name,
          COALESCE(d.total_debit, 0) AS sales,
          COALESCE(p.total_credit, 0) AS paid
        FROM (
          SELECT unnest($1::text[]) AS customer_code
        ) a
        LEFT JOIN (SELECT customer_code, SUM(amount) AS total_debit FROM all_debits GROUP BY customer_code) d ON a.customer_code = d.customer_code
        LEFT JOIN (SELECT customer_code, SUM(amount) AS total_credit FROM all_credits GROUP BY customer_code) p ON a.customer_code = p.customer_code
        LEFT JOIN customer_names n ON a.customer_code = n.customer_code
      `, [regCodes, snapshotDate]);

      registeredRows = regSalesAndPayments.rows.map(r => {
        const snapshotOB = Number(customerSnapshot.find(x => x.code === r.customer_code)?.balance || 0);
        const totalSales = Number(r.sales) + snapshotOB;
        const paid = Number(r.paid);
        const bal = totalSales - paid;

        let status = "PARTIAL";
        if (bal > 0) status = paid === 0 ? "PENDING" : "PARTIAL";
        else if (bal === 0) status = "PAID";
        else status = "EXTRA PAID";

        return {
          customer_code: r.customer_code,
          customer_name: r.name,
          sale_total: totalSales,
          received: paid,
          balance: bal,
          status: status
        };
      }).filter(r => r.balance !== 0 || r.sale_total !== 0);
    }

    /* ========== 5. SUPPLIERS SECTIONS ========== */
    const purchaseTotals = await db.query(`
      SELECT supplier_code, SUM(purchase_pkr) AS purchase_total FROM purchase_entries WHERE is_deleted = false AND ($1::date IS NULL OR created_at::date > $1) GROUP BY supplier_code
    `, [snapshotDate]);

    const paymentTotals = await db.query(`
      SELECT 
        s.supplier_code, 
        COALESCE(SUM(CASE WHEN sp.type = 'opening_balance' THEN sp.amount ELSE 0 END), 0) AS live_opening_balance,
        COALESCE(SUM(CASE WHEN sp.type != 'opening_balance' THEN sp.amount ELSE 0 END), 0) AS paid 
      FROM suppliers s 
      LEFT JOIN supplier_payments sp ON sp.supplier_id = s.id AND ($1::date IS NULL OR sp.payment_date::date > $1) 
      WHERE s.is_deleted = false 
      GROUP BY s.supplier_code
    `, [snapshotDate]);

    const suppliersData = await db.query(`SELECT supplier_code, supplier_name FROM suppliers WHERE is_deleted = false`);

    const suppliers = suppliersData.rows.map(s => {
      const pData = paymentTotals.rows.find(p => p.supplier_code === s.supplier_code);
      const purchase = Number(purchaseTotals.rows.find(p => p.supplier_code === s.supplier_code)?.purchase_total || 0);
      const paid = Number(pData?.paid || 0);
      const liveOB = Number(pData?.live_opening_balance || 0);
      const snapshotOB = Number(supplierSnapshot.find(x => x.code === s.supplier_code)?.balance || 0);

      const totalPurchase = purchase + liveOB + snapshotOB;
      const balance = totalPurchase - paid;

      let status = "PENDING";
      if (balance < 0) status = "EXTRA PAID";
      else if (balance === 0) status = "PAID";
      else if (paid > 0) status = "PARTIAL";

      return { 
        supplier_code: s.supplier_code, 
        supplier_name: s.supplier_name, 
        purchase_total: totalPurchase, 
        paid, 
        balance, 
        status 
      };
    }).filter(s => s.balance !== 0 || s.purchase_total !== 0).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

    /* ========== 6. SUMMARY CALCULATION ========== */
    const totalRegReceivable = registeredRows.filter(r => r.balance > 0).reduce((a, r) => a + r.balance, 0);
    const totalStdReceivable = standardCustomerRows.filter(r => r.balance > 0).reduce((a, r) => a + r.balance, 0);
    const totalRegExtra = registeredRows.filter(r => r.balance < 0).reduce((a, r) => a + Math.abs(r.balance), 0);
    const totalStdExtra = standardCustomerRows.filter(r => r.balance < 0).reduce((a, r) => a + Math.abs(r.balance), 0);

    const summary = {
      total_receivable: totalStdReceivable + totalRegReceivable,
      total_payable: suppliers.filter(r => r.balance > 0).reduce((a, r) => a + r.balance, 0),
      total_extra_received: totalStdExtra + totalRegExtra,
      total_extra_paid: suppliers.filter(r => r.balance < 0).reduce((a, r) => a + Math.abs(r.balance), 0)
    };

    return res.json({
      success: true,
      snapshot: { snapshotId, snapshotDate },
      customers: standardCustomerRows.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)),
      registeredCustomers: registeredRows.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)),
      suppliers,
      summary
    });

  } catch (err) {
    console.error("BALANCE SHEET ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;