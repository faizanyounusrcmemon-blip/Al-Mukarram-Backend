const express = require("express");
const router = express.Router();
const db = require("../db");

/* =====================================
   AUTO CUSTOMER CODE GENERATOR
===================================== */
const genCustomerCode = async () => {
  const r = await db.query("SELECT nextval('customer_code_seq') AS seq");
  return "CUST-" + String(r.rows[0].seq).padStart(5, "0");
};

/* =====================================
   CREATE CUSTOMER (Email & Contact are Optional)
===================================== */
router.post("/create", async (req, res) => {
  try {
    const { name, contact_no, email } = req.body;

    if (!name) {
      return res.json({ success: false, error: "Customer name is required" });
    }

    const code = await genCustomerCode();
    const final_contact = contact_no ? contact_no.trim() : "";
    const final_email = email ? email.trim() : "";

    await db.query(
      `
      INSERT INTO customers
      (customer_code, name, contact_no, email, is_deleted)
      VALUES ($1, $2, $3, $4, false)
      `,
      [code, name, final_contact, final_email]
    );

    res.json({ success: true, message: "Customer profile added", customer_code: code });

  } catch (err) {
    console.error("CUSTOMER CREATE ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

/* =====================================
   LIST CUSTOMERS (Safe Lookup)
===================================== */
router.get("/list", async (req, res) => {
  try {
    const { search } = req.query;

    let query = `
      SELECT id, customer_code, name, contact_no, email 
      FROM public.customers 
      WHERE is_deleted = false
    `;
    let params = [];

    // Agar Frontend search key bhejta hai to search karein, warna pure list load ho jaye!
    if (search && search.trim() !== "") {
      query += ` AND (name ILIKE $1 OR customer_code ILIKE $1)`;
      params.push(`%${search.trim()}%`);
    }

    query += ` ORDER BY customer_code ASC`;

    const q = await db.query(query, params);
    res.json({ success: true, rows: q.rows });
  } catch (err) {
    console.error("CUSTOMER LIST ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

/* =====================================
   UPDATE CUSTOMER
===================================== */
router.put("/update/:id", async (req, res) => {
  try {
    const { name, contact_no, email } = req.body;
    const final_contact = contact_no ? contact_no.trim() : "";
    const final_email = email ? email.trim() : "";

    await db.query(
      `
      UPDATE customers
      SET name = $1,
          contact_no = $2,
          email = $3
      WHERE id = $4
      `,
      [name, final_contact, final_email, req.params.id]
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
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'edit_customer_profile'"
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
   DELETE CUSTOMER (ONLY IF BALANCE IS 0)
===================================== */
router.delete("/delete/:id", async (req, res) => {
  try {
    const { password } = req.body;
    const customerId = req.params.id;

    if (!password) {
      return res.json({ success: false, error: "Password required" });
    }

    // 1. Database lookup for delete password
    const passCheck = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'delete_customer_profile'"
    );

    if (passCheck.rows.length === 0 || password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Wrong Password 😎" });
    }

    // 2. Fetch Customer Code
    const custRes = await db.query(
      "SELECT customer_code FROM public.customers WHERE id = $1 AND is_deleted = false",
      [customerId]
    );

    if (custRes.rows.length === 0) {
      return res.json({ success: false, error: "Customer not found" });
    }

    const customerCode = custRes.rows[0].customer_code;

    // 3. Calculate Total Sales + Opening Balance
    const salesRes = await db.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS total_sales
      FROM (
        SELECT total_pkr AS amount FROM bookings WHERE customer_code = $1 AND is_deleted = false
        UNION ALL SELECT total_pkr FROM hotels WHERE customer_code = $1 AND is_deleted = false
        UNION ALL SELECT total_pkr FROM visa WHERE customer_code = $1 AND is_deleted = false
        UNION ALL SELECT total_pkr FROM card WHERE customer_code = $1 AND is_deleted = false
        UNION ALL SELECT total_pkr FROM groups WHERE customer_code = $1 AND is_deleted = false
        UNION ALL SELECT total_pkr FROM ticketing WHERE customer_code = $1 AND is_deleted = false
        UNION ALL SELECT total_pkr FROM transport WHERE customer_code = $1 AND is_deleted = false
        UNION ALL SELECT total_pkr FROM ziyarat WHERE customer_code = $1 AND is_deleted = false
        UNION ALL SELECT amount FROM customer_payments WHERE ref_no = $1 AND type = 'opening_balance'
      ) sales
      `,
      [customerCode]
    );

    // 4. Calculate Total Customer Payments
    const paymentsRes = await db.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS total_payments
      FROM customer_payments
      WHERE ref_no = $1 AND type != 'opening_balance'
      `,
      [customerCode]
    );

    // 5. Fetch Archive Snapshot Balance (if exists)
    const snapshotRes = await db.query(
      `
      SELECT balance FROM archive_balances 
      WHERE snapshot_id = (SELECT id FROM archive_snapshots ORDER BY date_to DESC, id DESC LIMIT 1) 
        AND UPPER(balance_type) = 'CUSTOMER' AND code = $1
      `,
      [customerCode]
    );

    const snapshotBal = snapshotRes.rows.length > 0 ? Number(snapshotRes.rows[0].balance || 0) : 0;
    const totalSales = Number(salesRes.rows[0].total_sales || 0);
    const totalPayments = Number(paymentsRes.rows[0].total_payments || 0);

    // Total Remaining Balance Calculation
    const currentBalance = snapshotBal + totalSales - totalPayments;

// 6. Balance Check (Must be strictly 0)
    if (Math.abs(currentBalance) > 0.01) {
      if (currentBalance > 0) {
        return res.json({
          success: false,
          error: `Customer cannot be deleted! Outstanding pending balance: PKR ${currentBalance.toLocaleString("en-US")}`
        });
      } else {
        return res.json({
          success: false,
          error: `Customer cannot be deleted! Customer has extra paid balance: PKR ${Math.abs(currentBalance).toLocaleString("en-US")}`
        });
      }
    }

    // 7. SOFT DELETE: setting is_deleted=true (Only if balance is 0)
    await db.query(
      `
      UPDATE customers
      SET is_deleted = true
      WHERE id = $1
      `,
      [customerId]
    );

    res.json({ success: true, message: "Customer profile deleted successfully" });

  } catch (err) {
    console.error("CUSTOMER DELETE ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;