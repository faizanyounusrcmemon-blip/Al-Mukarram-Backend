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
   DELETE SUPPLIER (DATABASE LOOKUP)
===================================== */
router.delete("/delete/:id", async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.json({ success: false, error: "Password required" });

    // Database lookup for delete password
    const passCheck = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'delete_supplier_pass'"
    );

    if (passCheck.rows.length === 0 || password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Wrong Password 😎" });
    }

    await db.query(
      `
      UPDATE suppliers
      SET is_deleted=true
      WHERE id=$1
      `,
      [req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;