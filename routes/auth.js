const express = require("express");
const router = express.Router();
const db = require("../db");

/* ================= LOGIN ================= */
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password)
      return res.json({
        success: false,
        error: "Missing credentials"
      });

    // 1️⃣ user only by username
    const r = await db.query(
      "SELECT * FROM users WHERE username=$1",
      [username]
    );

    if (r.rows.length === 0)
      return res.json({
        success: false,
        error: "Username not found"
      });

    const user = r.rows[0];

    // 2️⃣ inactive check
    if (user.is_active === false) {
      return res.json({
        success: false,
        error: "User inactive"
      });
    }

    // 3️⃣ password check
    if (user.password !== password) {
      return res.json({
        success: false,
        error: "Wrong password"
      });
    }

    // 4️⃣ login success update
    const updateRes = await db.query(
      `
      UPDATE users
      SET last_login = NOW(),
          is_online = true
      WHERE id = $1
      RETURNING *
      `,
      [user.id]
    );

    res.json({
      success: true,
      user: updateRes.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.json({
      success: false,
      error: err.message
    });
  }
});

/* ================= LOGOUT ================= */
router.post("/logout", async (req, res) => {
  try {

    const { id } = req.body;

    if (!id)
      return res.json({
        success: false,
        error: "User ID required"
      });

    const updateRes = await db.query(
      `
      UPDATE users
      SET
        last_logout = NOW(),
        is_online = false
      WHERE id = $1
      RETURNING
        id,
        name,
        username,
        role,
        is_online,
        last_login,
        last_logout
      `,
      [id]
    );

    res.json({
      success: true,
      user: updateRes.rows[0]
    });

  } catch (err) {

    console.error("LOGOUT ERROR:", err);

    res.json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;