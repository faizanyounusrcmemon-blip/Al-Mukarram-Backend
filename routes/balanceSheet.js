const express = require("express");
const router = express.Router();
const db = require("../db");

/* =========================================
   BALANCE SHEET (CUSTOMER + SUPPLIER STATUS)
========================================= */
router.get("/", async (req, res) => {
  try {

let snapshotId = null;
let snapshotDate = null;

const snapshot = await db.query(`
  SELECT id,date_to
  FROM archive_snapshots
  ORDER BY id DESC
  LIMIT 1
`);

if(snapshot.rows.length){
  snapshotId = snapshot.rows[0].id;
  snapshotDate = snapshot.rows[0].date_to;
}

/* ========== CUSTOMERS (ONLY PENDING + PARTIAL) ========== */

const customerSnapshot = await db.query(`
  SELECT
    code,
    balance
  FROM archive_balances
  WHERE snapshot_id=$1
  AND balance_type='CUSTOMER'
`, [snapshotId]);

const customersData = await db.query(`




  SELECT *
  FROM (

    SELECT
      ref_no,
      customer_name,
      payment_status,
      total_pkr
    FROM bookings
    WHERE is_deleted = false
      AND payment_status IN ('PENDING','PARTIAL')

    UNION ALL

    SELECT
      ref_no,
      customer_name,
      payment_status,
      total_pkr
    FROM hotels
    WHERE is_deleted = false
      AND payment_status IN ('PENDING','PARTIAL')

    UNION ALL

    SELECT
      ref_no,
      customer_name,
      payment_status,
      total_pkr
    FROM visa
    WHERE is_deleted = false
      AND payment_status IN ('PENDING','PARTIAL')

    UNION ALL

    SELECT
      ref_no,
      customer_name,
      payment_status,
      total_pkr
    FROM card
    WHERE is_deleted = false
      AND payment_status IN ('PENDING','PARTIAL')

    UNION ALL

    SELECT
      ref_no,
      customer_name,
      payment_status,
      total_pkr
    FROM groups
    WHERE is_deleted = false
      AND payment_status IN ('PENDING','PARTIAL')

    UNION ALL

    SELECT
      ref_no,
      customer_name,
      payment_status,
      total_pkr
    FROM ticketing
    WHERE is_deleted = false
      AND payment_status IN ('PENDING','PARTIAL')

    UNION ALL

    SELECT
      ref_no,
      customer_name,
      payment_status,
      total_pkr
    FROM transport
    WHERE is_deleted = false
      AND payment_status IN ('PENDING','PARTIAL')

    UNION ALL

    SELECT
      ref_no,
      customer_name,
      payment_status,
      total_pkr
    FROM ziyarat
    WHERE is_deleted = false
      AND payment_status IN ('PENDING','PARTIAL')

  ) x
`);

const payments = await db.query(`
SELECT
  ref_no,
  COALESCE(SUM(amount),0) AS received
FROM customer_payments
WHERE (
  $1::date IS NULL
  OR payment_date > $1
)
GROUP BY ref_no

`, [snapshotDate]);

const customerRows = customersData.rows.map(r => {

  const received = Number(
    payments.rows.find(p => p.ref_no === r.ref_no)?.received || 0
  );

  const saleTotal = Number(r.total_pkr || 0);

  const openingBalance =
  Number(
    customerSnapshot.rows.find(
      x => x.code === r.ref_no
    )?.balance || 0
  );

const balance =
  openingBalance +
  saleTotal -
  received;

  return {
    ref_no: r.ref_no,
    customer_name: r.customer_name,
    sale_total: saleTotal,
    received,
    balance,
    status: r.payment_status
  };
})
.sort((a, b) => b.balance - a.balance);







    /* ========== SUPPLIERS ========== */
const supplierSnapshot = await db.query(`
  SELECT
    code,
    balance
  FROM archive_balances
  WHERE snapshot_id=$1
  AND balance_type='SUPPLIER'
`, [snapshotId]);



const purchaseTotals = await db.query(`
  SELECT
    supplier_code,
    SUM(purchase_pkr) AS purchase_total
  FROM purchase_entries
  WHERE is_deleted = false
  AND (
    $1::date IS NULL
    OR created_at::date > $1
  )
  GROUP BY supplier_code
`, [snapshotDate]);



const paymentTotals = await db.query(`
  SELECT
    s.supplier_code,
    COALESCE(SUM(sp.amount),0) AS paid
  FROM suppliers s
  LEFT JOIN supplier_payments sp
    ON sp.supplier_id = s.id
    AND (
      $1::date IS NULL
      OR sp.payment_date > $1
    )
  WHERE s.is_deleted = false
  GROUP BY s.supplier_code
`, [snapshotDate]);



    const suppliersData = await db.query(`
      SELECT supplier_code, supplier_name
      FROM suppliers
      WHERE is_deleted = false
    `);

    const suppliers = suppliersData.rows
      .map(s => {
        const purchase =
          Number(
            purchaseTotals.rows.find(p => p.supplier_code === s.supplier_code)
              ?.purchase_total || 0
          );

        const paid =
          Number(
            paymentTotals.rows.find(p => p.supplier_code === s.supplier_code)
              ?.paid || 0
          );

        const openingBalance =
  Number(
    supplierSnapshot.rows.find(
      x => x.code === s.supplier_code
    )?.balance || 0
  );

const balance =
  openingBalance +
  purchase -
  paid;

        // ✅ SUPPLIER STATUS FIXED
        let status = "PENDING";
        if (balance < 0) status = "EXTRA PAID";
        else if (balance === 0) status = "PAID";
        else if (paid > 0) status = "PARTIAL";

        return {
          supplier_code: s.supplier_code,
          supplier_name: s.supplier_name,
          purchase_total: purchase,
          paid,
          balance,
          status
        };
      })
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));


    /* ========== RESPONSE ========== */


      // ❗ extra paid include — filter remove
const summary = {
  total_receivable: customerRows
    .filter(r => r.balance > 0)
    .reduce((a, r) => a + r.balance, 0),

  total_payable: suppliers
    .filter(r => r.balance > 0)
    .reduce((a, r) => a + r.balance, 0),

  total_extra_received: customerRows
    .filter(r => r.balance < 0)
    .reduce((a, r) => a + Math.abs(r.balance), 0),

  total_extra_paid: suppliers
    .filter(r => r.balance < 0)
    .reduce((a, r) => a + Math.abs(r.balance), 0)
};

return res.json({
  success: true,

  snapshot: {
    snapshotId,
    snapshotDate
  },

  customers: customerRows.sort(
    (a, b) => Math.abs(b.balance) - Math.abs(a.balance)
  ),

  suppliers,

  summary
});



  } catch (err) {
    console.error("BALANCE SHEET ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
