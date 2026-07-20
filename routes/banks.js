const express = require("express");
const router = express.Router();
const pool = require("../db");

/* ======================================================
   GET ALL BANKS
====================================================== */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM banks ORDER BY id ASC"
    );
    res.json({ success: true, rows: result.rows });
  } catch (err) {
    console.error("GET BANKS ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

/* ======================================================
   ADD NEW BANK
====================================================== */
router.post("/", async (req, res) => {
  try {
    const { bank_name, account_title, account_number, status } = req.body;

    if (!bank_name || !account_title || !account_number) {
      return res.json({ success: false, error: "Missing required fields" });
    }

    const result = await pool.query(
      `INSERT INTO banks (bank_name, account_title, account_number, status) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [bank_name.trim(), account_title.trim(), account_number.trim(), status || "Active"]
    );

    res.json({
      success: true,
      message: "Bank profile created successfully",
      bank: result.rows[0],
    });
  } catch (err) {
    console.error("ADD BANK ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

/* ======================================================
   EDIT BANK PROFILE (PASSWORD AUTHORIZATION)
====================================================== */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { bank_name, account_title, account_number, status, password } = req.body;

    if (!bank_name || !account_title || !account_number) {
      return res.json({ success: false, error: "Missing required fields" });
    }

    if (!password) {
      return res.json({ success: false, error: "Authorization password required" });
    }

    // 🔑 Password check from system_passwords table
    const passCheck = await pool.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1",
      ["manage_bank_profile"]
    );

    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "System password 'manage_bank_profile' not configured!" });
    }

    if (password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Wrong Authorization Password!" });
    }

    // Update Record
    await pool.query(
      `UPDATE banks 
       SET bank_name = $1, account_title = $2, account_number = $3, status = $4 
       WHERE id = $5`,
      [bank_name.trim(), account_title.trim(), account_number.trim(), status || "Active", id]
    );

    res.json({ success: true, message: "Bank profile updated successfully" });
  } catch (err) {
    console.error("EDIT BANK ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

/* ======================================================
   DELETE BANK PROFILE (PASSWORD AUTHORIZATION)
====================================================== */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.json({ success: false, error: "Authorization password required" });
    }

    // 🔑 Password check from system_passwords table
    const passCheck = await pool.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1",
      ["manage_bank_profile"]
    );

    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "System password 'manage_bank_profile' not configured!" });
    }

    if (password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Wrong Authorization Password!" });
    }

    await pool.query("DELETE FROM banks WHERE id = $1", [id]);

    res.json({ success: true, message: "Bank profile deleted successfully" });
  } catch (err) {
    console.error("DELETE BANK ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;