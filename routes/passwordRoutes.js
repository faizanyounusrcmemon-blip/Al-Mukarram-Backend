const express = require("express");
const router = express.Router();
const db = require("../db");

/* =====================================================
   🔐 GLOBAL SYSTEM PASSWORD MANAGER ROUTINGS
===================================================== */

/**
 * 1. GET ALL SYSTEM PASSWORD SETTINGS
 * URL: /api/system-settings/list
 */
router.get("/list", async (req, res) => {
  try {
    const q = await db.query(
      "SELECT id, key_name, display_name, description FROM public.system_passwords ORDER BY id ASC"
    );
    res.json({ success: true, data: q.rows });
  } catch (err) {
    console.error("Fetch Password Settings List Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 2. UNIVERSAL PASSWORD VERIFICATION API
 * URL: /api/system-settings/verify
 */
router.post("/verify", async (req, res) => {
  const { key_name, password } = req.body;
  
  if (!key_name || !password) {
    return res.status(400).json({ success: false, message: "Missing attributes!" });
  }

  try {
    const q = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = $1",
      [key_name]
    );
    
    if (q.rows.length === 0) {
      return res.status(404).json({ success: false, message: "System key attribute not found" });
    }
    
    const isValid = q.rows[0].password_val === password;
    res.json({ success: true, valid: isValid });
  } catch (err) {
    console.error("Password Verification API Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 3. UPDATE PASSWORD WITH OLD & NEW PASSWORD VERIFICATION
 * URL: /api/system-settings/update
 */
router.post("/update", async (req, res) => {
  const { key_name, oldPassword, newPassword } = req.body;

  if (!key_name || !oldPassword || !newPassword) {
    return res.status(400).json({ success: false, message: "All fields are required!" });
  }

  try {
    // A. Database se dynamic specific key ka active record check karna
    const checkQuery = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = $1",
      [key_name]
    );
    
    if (checkQuery.rows.length === 0) {
      return res.status(404).json({ success: false, message: "System key configuration not found" });
    }

    const currentPassword = checkQuery.rows[0].password_val;

    // B. Old Password match validation check
    if (oldPassword !== currentPassword) {
      return res.status(403).json({ 
        success: false, 
        message: "Incorrect Old Password! Please try again. 😎" 
      });
    }

    // C. Data database update command execution
    const updateResult = await db.query(
      "UPDATE public.system_passwords SET password_val = $1 WHERE key_name = $2",
      [newPassword, key_name]
    );

    if (updateResult.rowCount === 0) {
      return res.status(500).json({ success: false, message: "Failed to apply updates to database table." });
    }

    res.json({ 
      success: true, 
      message: "System password configurations synced successfully!" 
    });

  } catch (err) {
    console.error("Update System Password Engine Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;