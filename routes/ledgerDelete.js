const express = require("express");
const router = express.Router();
const db = require("../db");

router.post("/delete", async (req, res) => {
  try {
    const { id, password, type } = req.body;

    if (password !== "786") {
      return res.json({ success: false, error: "Wrong password" });
    }

    const table =
      type === "customer" ? "customer_ledger"
      : "purchase_ledger";

    await db.query(
      `UPDATE ${table} SET is_deleted = true WHERE id = $1`,
      [id]
    );

    res.json({ success: true });

  } catch (err) {
    console.error("LEDGER DELETE ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
