const express = require("express");
const router = express.Router();
const db = require("../db");

/* =====================================
   AUTO SUPPLIER CODE
===================================== */
const genCode = async () => {
  const r = await db.query("SELECT nextval('suppliers_code_seq') AS seq");
  return "SUP-" + String(r.rows[0].seq).padStart(4, "0");
};

/* =====================================
   CREATE SUPPLIER
===================================== */
router.post("/create", async (req, res) => {
  try {
    const { supplier_name, category, contact_no } = req.body;

    if (!supplier_name)
      return res.json({ success: false, error: "Supplier name required" });

    // 🔹 generate unique code
    const code = await genCode();

    await db.query(
      `
      INSERT INTO suppliers
      (supplier_code, supplier_name, category, contact_no)
      VALUES ($1,$2,$3,$4)
      `,
      [code, supplier_name, category, contact_no]
    );

    res.json({ success: true, message: "Supplier added", supplier_code: code });

  } catch (err) {
    console.error("SUPPLIER CREATE ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

/* =====================================
   LIST SUPPLIERS
===================================== */
router.get("/list", async (req, res) => {
  const q = await db.query(
    `
    SELECT *
    FROM suppliers
    WHERE is_deleted=false
    ORDER BY supplier_code
    `
  );
  res.json({ success: true, rows: q.rows });
});

/* =====================================
   UPDATE SUPPLIER
===================================== */
router.put("/update/:id", async (req, res) => {
  try {
    const { supplier_name, category, contact_no } = req.body;

    await db.query(
      `
      UPDATE suppliers
      SET supplier_name=$1,
          category=$2,
          contact_no=$3
      WHERE id=$4
      `,
      [supplier_name, category, contact_no, req.params.id]
    );

    res.json({ success: true });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* =====================================
   VERIFY EDIT PASSWORD (DATABASE LOOKUP)
===================================== */
router.post("/verify-edit-password", async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.json({ success: false, error: "Password required" });

    const passCheck = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'edit_supplier_pass'"
    );

    if (passCheck.rows.length === 0 || password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Wrong Password 😎" });
    }

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* =====================================
   DELETE SUPPLIER (ONLY IF BALANCE IS 0)
===================================== */
router.delete("/delete/:id", async (req, res) => {
  try {
    const { password } = req.body;
    const supplierId = req.params.id;

    if (!password) return res.json({ success: false, error: "Password required" });

    // 1. Database lookup for delete password
    const passCheck = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'delete_supplier_pass'"
    );

    if (passCheck.rows.length === 0 || password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Wrong Password 😎" });
    }

    // 2. Fetch Supplier Code
    const suppRes = await db.query(
      "SELECT supplier_code FROM public.suppliers WHERE id = $1 AND is_deleted = false",
      [supplierId]
    );

    if (suppRes.rows.length === 0) {
      return res.json({ success: false, error: "Supplier not found" });
    }

    const supplierCode = suppRes.rows[0].supplier_code;

    // 3. Fetch Snapshot Info
    const snapshotRes = await db.query(`
      SELECT id, date_to FROM archive_snapshots ORDER BY id DESC LIMIT 1
    `);

    let snapshotId = null;
    let snapshotDate = null;
    if (snapshotRes.rows.length > 0) {
      snapshotId = snapshotRes.rows[0].id;
      snapshotDate = snapshotRes.rows[0].date_to;
    }

    // 4. Calculate Purchases, Payments & Opening Balances
    const purchasesRes = await db.query(
      `
      SELECT COALESCE(SUM(purchase_pkr), 0) AS total_purchase
      FROM purchase_entries
      WHERE supplier_code = $1 AND is_deleted = false
        AND ($2::date IS NULL OR created_at::date > $2)
      `,
      [supplierCode, snapshotDate]
    );

    const paymentsRes = await db.query(
      `
      SELECT 
        COALESCE(SUM(CASE WHEN type = 'opening_balance' THEN amount ELSE 0 END), 0) AS opening_balance,
        COALESCE(SUM(CASE WHEN type != 'opening_balance' THEN amount ELSE 0 END), 0) AS total_paid
      FROM supplier_payments
      WHERE supplier_id = $1
        AND ($2::date IS NULL OR payment_date > $2)
      `,
      [supplierId, snapshotDate]
    );

    const snapshotBalRes = await db.query(
      `
      SELECT balance FROM archive_balances 
      WHERE snapshot_id = $1 AND balance_type = 'SUPPLIER' AND code = $2
      `,
      [snapshotId, supplierCode]
    );

    const snapshotBal = snapshotBalRes.rows.length > 0 ? Number(snapshotBalRes.rows[0].balance || 0) : 0;
    const totalPurchase = Number(purchasesRes.rows[0].total_purchase || 0);
    const openingBalance = Number(paymentsRes.rows[0].opening_balance || 0);
    const totalPaid = Number(paymentsRes.rows[0].total_paid || 0);

    // Total Remaining Payable/Overpaid Balance
    const pendingAmount = snapshotBal + totalPurchase + openingBalance - totalPaid;

    // 5. Strict Balance Check (Must be 0)
    if (Math.abs(pendingAmount) > 0.5) {
      if (pendingAmount > 0) {
        return res.json({
          success: false,
          error: `Supplier cannot be deleted! Outstanding pending balance: PKR ${pendingAmount.toLocaleString("en-US")}`
        });
      } else {
        return res.json({
          success: false,
          error: `Supplier cannot be deleted! Supplier has extra paid balance: PKR ${Math.abs(pendingAmount).toLocaleString("en-US")}`
        });
      }
    }

    // 6. SOFT DELETE (Only if balance is 0)
    await db.query(
      `
      UPDATE suppliers
      SET is_deleted = true
      WHERE id = $1
      `,
      [supplierId]
    );

    res.json({ success: true, message: "Supplier profile deleted successfully" });

  } catch (err) {
    console.error("SUPPLIER DELETE ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;