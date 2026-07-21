const express = require("express");
const router = express.Router();
const db = require("../db");

/* ================================
   GET ALL PENDING / PARTIAL SUPPLIERS
================================ */
router.get("/pending", async (req, res) => {
  try {
    let snapshotId = null;
    let snapshotDate = null;

    const snapshot = await db.query(`
      SELECT id, date_to
      FROM archive_snapshots
      ORDER BY id DESC
      LIMIT 1
    `);

    if (snapshot.rows.length) {
      snapshotId = snapshot.rows[0].id;
      snapshotDate = snapshot.rows[0].date_to;
    }

    const q = await db.query(`
      WITH purchase_totals AS (
        SELECT
          supplier_code,
          COALESCE(SUM(purchase_pkr), 0) AS total_purchase
        FROM purchase_entries
        WHERE is_deleted = false
        AND ($2::date IS NULL OR created_at::date > $2)
        GROUP BY supplier_code
      ),

      payment_totals AS (
        SELECT
          s.supplier_code,
          COALESCE(SUM(CASE WHEN sp.type = 'opening_balance' THEN sp.amount ELSE 0 END), 0) AS live_opening_balance,
          COALESCE(SUM(CASE WHEN sp.type != 'opening_balance' THEN sp.amount ELSE 0 END), 0) AS total_paid
        FROM suppliers s
        LEFT JOIN supplier_payments sp
          ON sp.supplier_id = s.id
          AND ($2::date IS NULL OR sp.payment_date > $2)
        WHERE s.is_deleted = false
        GROUP BY s.supplier_code
      ),

      snapshot_balances AS (
        SELECT code, balance
        FROM archive_balances
        WHERE snapshot_id = $1 AND balance_type='SUPPLIER'
      ),

      calculated_suppliers AS (
        SELECT
          s.supplier_code,
          s.supplier_name,
          (
            COALESCE(sb.balance, 0) +
            COALESCE(pt.total_purchase, 0) +
            COALESCE(ptot.live_opening_balance, 0)
          ) AS total_purchase,
          COALESCE(ptot.total_paid, 0) AS total_paid,
          (
            COALESCE(sb.balance, 0) +
            COALESCE(pt.total_purchase, 0) +
            COALESCE(ptot.live_opening_balance, 0) -
            COALESCE(ptot.total_paid, 0)
          ) AS pending_amount
        FROM suppliers s
        LEFT JOIN purchase_totals pt ON pt.supplier_code = s.supplier_code
        LEFT JOIN payment_totals ptot ON ptot.supplier_code = s.supplier_code
        LEFT JOIN snapshot_balances sb ON sb.code = s.supplier_code
        WHERE s.is_deleted = false
      )

      SELECT
        supplier_code,
        supplier_name,
        total_purchase,
        total_paid,
        pending_amount,
        CASE
          WHEN pending_amount < -0.5 THEN 'EXTRA PAID'
          WHEN ABS(pending_amount) <= 0.5 THEN 'PAID'
          WHEN total_paid > 0 THEN 'PARTIAL'
          ELSE 'PENDING'
        END AS status
      FROM calculated_suppliers
      -- ✨ FILTER OUT ZERO BALANCE: Sirf wahi ayenge jin ka balance exact 0 na ho
      WHERE ABS(pending_amount) > 0.5
      ORDER BY pending_amount DESC, supplier_name
    `, [snapshotId, snapshotDate]);

    res.json({
      success: true,
      pending: q.rows
    });

  } catch (e) {
    console.error("Pending suppliers error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ====================================================
   DELETE LEDGER ENTRY
==================================================== */
router.delete("/delete/:entryId", async (req, res) => {
  try {
    const { entryId } = req.params;
    const { password, type } = req.body;

    if (!entryId || isNaN(entryId))
      return res.json({ success: false, error: "Invalid entry ID" });

    const passCheck = await db.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1", 
      ['delete_supplier_payment']
    );
    
    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "System password not configured in database!" });
    }

    if (password !== passCheck.rows[0].password_val)
      return res.json({ success: false, error: "Wrong password" });

    if (type === "purchase") {
      const check = await db.query(
        "SELECT status FROM purchase_entries WHERE id=$1",
        [entryId]
      );
      if (!check.rows.length) return res.json({ success: false, error: "Purchase not found" });
      if (check.rows[0].status === "Live Purchase")
        return res.json({ success: false, error: "Cannot delete Live Purchase" });

      await db.query("DELETE FROM purchase_entries WHERE id=$1", [entryId]);
    } else if (type === "payment") {
      const check = await db.query("SELECT id FROM supplier_payments WHERE id=$1", [entryId]);
      if (!check.rows.length) return res.json({ success: false, error: "Payment not found" });

      await db.query("DELETE FROM supplier_payments WHERE id=$1", [entryId]);
    } else {
      return res.json({ success: false, error: "Invalid type" });
    }

    res.json({ success: true, message: "Entry deleted successfully" });
  } catch (e) {
    console.error("Delete error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ====================================================
   EDIT LEDGER ENTRY (WITH BANK_PROFILE_ID)
==================================================== */
router.put("/edit/:entryId", async (req, res) => {
  try {
    const { entryId } = req.params;
    const { password, amount, payment_date, payment_method, bank_profile_id, type } = req.body;

    if (!entryId || isNaN(entryId)) {
      return res.json({ success: false, error: "Invalid entry ID" });
    }

    if (!amount || amount <= 0) {
      return res.json({ success: false, error: "Invalid amount" });
    }

    const passCheck = await db.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1", 
      ['delete_supplier_payment']
    );
    
    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "System password not configured in database!" });
    }

    if (password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Wrong password" });
    }

    const check = await db.query(
      "SELECT id FROM supplier_payments WHERE id = $1",
      [entryId]
    );

    if (!check.rows.length) {
      return res.json({ success: false, error: "Payment entry not found" });
    }

    await db.query(`
      UPDATE supplier_payments 
      SET amount = $1, payment_date = $2, payment_method = $3, bank_profile_id = $4, type = $5
      WHERE id = $6
    `, [
      amount, 
      payment_date, 
      payment_method || "Bank", 
      payment_method === "Bank" ? bank_profile_id : null, 
      type, 
      entryId
    ]);

    res.json({ success: true, message: "Entry updated successfully" });

  } catch (e) {
    console.error("Edit error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ================================
   SAVE PAYMENT / ADJUSTMENT / OPENING BALANCE
================================ */
router.post("/payment", async (req, res) => {
  try {
    const { supplier_code, payment_date, payment_method, bank_profile_id, amount, type } = req.body;

    const supplier = await db.query(
      "SELECT id FROM suppliers WHERE supplier_code=$1",
      [supplier_code]
    );

    if (!supplier.rows.length)
      return res.json({ success: false, error: "Supplier not found" });

    await db.query(`
      INSERT INTO supplier_payments
      (supplier_id, payment_date, payment_method, bank_profile_id, amount, type)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [
      supplier.rows[0].id,
      payment_date,
      payment_method,
      payment_method === "Bank" ? bank_profile_id : null,
      amount,
      type
    ]);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ================================
   GET LEDGER BY SUPPLIER CODE (WITH BANK JOIN)
================================ */
router.get("/:supplierCode", async (req, res) => {
  try {
    const { supplierCode } = req.params;

    const supplier = await db.query(
      "SELECT id, supplier_name FROM suppliers WHERE supplier_code=$1",
      [supplierCode]
    );

    if (!supplier.rows.length)
      return res.json({ success: false, error: "Supplier not found" });

    const supplierId = supplier.rows[0].id;
    let openingBalance = 0;
    let snapshotDate = null;

    const snapshot = await db.query(`
      SELECT id,date_to FROM archive_snapshots ORDER BY id DESC LIMIT 1
    `);

    if(snapshot.rows.length){
      snapshotDate = snapshot.rows[0].date_to;
      const bal = await db.query(`
        SELECT balance FROM archive_balances WHERE snapshot_id=$1 AND balance_type='SUPPLIER' AND code=$2
      `,[snapshot.rows[0].id, supplierCode]);
      openingBalance = Number(bal.rows[0]?.balance || 0);
    }

    const purchases = await db.query(`
      SELECT 
        pe.id, pe.created_at::date AS date, 'Purchase' AS type, s.supplier_name,
        '-' AS payment_method, NULL AS bank_profile_id, NULL AS bank_name,
        pe.purchase_pkr AS debit, 0 AS credit, pe.item, pe.ref_no
      FROM purchase_entries pe
      JOIN suppliers s ON s.supplier_code = pe.supplier_code
      WHERE pe.supplier_code=$1 AND pe.is_deleted=false
      AND ($2::date IS NULL OR pe.created_at::date > $2)
    `, [supplierCode, snapshotDate]);

    // ✨ Bank profile join yahan add kar dia hai
    const payments = await db.query(`
      SELECT
        sp.id,
        sp.payment_date::date AS date,
        sp.type,
        sp.payment_method,
        sp.bank_profile_id,
        b.bank_name,
        CASE WHEN sp.type = 'opening_balance' THEN sp.amount ELSE 0 END AS debit,
        CASE WHEN sp.type != 'opening_balance' THEN sp.amount ELSE 0 END AS credit
      FROM supplier_payments sp
      LEFT JOIN public.banks b ON b.id = sp.bank_profile_id
      WHERE sp.supplier_id=$1
      AND ($2::date IS NULL OR sp.payment_date > $2)
    `, [supplierId, snapshotDate]);

    const ledgerAll = [];

    if(openingBalance !== 0){
      ledgerAll.push({
        id: 0, date: snapshotDate, type: "Snapshot Opening",
        debit: openingBalance > 0 ? openingBalance : 0,
        credit: openingBalance < 0 ? Math.abs(openingBalance) : 0,
        entry_type: "snapshot"
      });
    }

    ledgerAll.push(...purchases.rows, ...payments.rows);

    ledgerAll.sort((a,b)=>{
      const d = new Date(a.date) - new Date(b.date);
      if(d !== 0) return d;
      return Number(a.id) - Number(b.id);
    });

    let balance = 0;
    const finalLedger = ledgerAll.map(r => {
      balance += Number(r.debit || 0) - Number(r.credit || 0);

      let displayType = r.type;
      let itemDescription = r.item || `${r.type} (${r.payment_method || ""})`;

      if (r.type === 'opening_balance') {
        displayType = 'Opening Bal';
        itemDescription = 'opening_balance';
      }

      return {
        ...r,
        type: displayType,
        description: itemDescription,
        balance,
        entry_type: (r.type === 'opening_balance' || r.type === 'Opening Bal') ? "payment" : 
                    (String(r.type || "").toLowerCase().includes("payment") || String(r.type || "").toLowerCase().includes("adjustment") ? "payment" : (r.type === "Snapshot Opening" ? "snapshot" : "purchase"))
      };
    });

    return res.json({
      success: true,
      ledger: finalLedger,
      snapshotDate,
      openingBalance
    });

  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;