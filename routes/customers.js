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

    query += ` ORDER BY name ASC`;

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
   DELETE CUSTOMER (SOFT DELETE + DB LOOKUP)
===================================== */
router.delete("/delete/:id", async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.json({ success: false, error: "Password required" });

    // Database lookup for delete password
    const passCheck = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'delete_customer_profile'"
    );

    if (passCheck.rows.length === 0 || password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Wrong Password 😎" });
    }

    // SOFT DELETE: setting is_deleted=true
    await db.query(
      `
      UPDATE customers
      SET is_deleted = true
      WHERE id = $1
      `,
      [req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;