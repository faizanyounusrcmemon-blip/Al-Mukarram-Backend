const express = require("express");
const router = express.Router();
const db = require("../db");

/* ================= CREATE USER ================= */
router.post("/create", async (req, res) => {
  try {
    const { name, username, password, role, is_active } = req.body;

    if (!name || !username || !password)
      return res.json({ success: false, error: "Missing fields" });

    const check = await db.query(
      "SELECT id FROM users WHERE username=$1",
      [username]
    );

    if (check.rows.length > 0)
      return res.json({ success: false, error: "Username already exists" });

    await db.query(
      `
      INSERT INTO users (
        name, username, password, role, is_active,

        packages, ticketing, transport, ziyarat, visa, hotels, card, groups,
        purchase_entry, purchase_list, pending_purchase,
        registered_customer_ledger, customer_ledger, bank_profiles, supplier_ledger, bank_ledger, expense_ledger, balance_sheet, cash_ledger,
        hotel_voucher, hotel_voucher3in1, transport_voucher, customiz_transport_voucher, customiz_hotel_voucher,
        all_reports, all_reports_today, profit_report, monthly_profit_dashboard, sale_adjustment_report, supplier_purchase_detail_report, supplier_adjustment_only, item_loss_zero_report, sale_change_check_report,
        create_user, manage_users, supplier, customers_list, deleted_reports, restore, system_storage, password_settings,
        archive_manager, archive_list
      )
      VALUES (
        $1, $2, $3, $4, $5,

        false, false, false, false, false, false, false, false,
        false, false, false,
        false, false, false, false, false, false, false, false,
        false, false, false, false, false,
        false, false, false, false, false, false, false, false, false,
        false, false, false, false, false, false, false, false,
        false, false

      )
      `,
      [
        name,
        username,
        password,
        role || "user",
        is_active === true
      ]
    );

    res.json({ success: true });

  } catch (err) {
    console.error("CREATE USER ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

/* ================= LIST USERS ================= */
router.get("/list", async (req, res) => {
  try {

    const r = await db.query(
      `
      SELECT 
      id,
      name,
      username,
      password,
      role,
      is_active,
      is_online,
      last_login,
      last_logout
      FROM users
      ORDER BY id DESC
      `
    );

    res.json({ success: true, rows: r.rows });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});


/* ================= UPDATE USER ================= */
router.post("/update", async (req, res) => {
  try {
    const {
      id,
      name,
      username,
      password,
      role,
      is_active
    } = req.body;

    if (!id || !name || !username || !role)
      return res.json({ success: false, error: "Missing data" });

    if (password) {
      await db.query(
        `
        UPDATE users
        SET
          name=$1,
          username=$2,
          password=$3,
          role=$4,
          is_active=$5
        WHERE id=$6
        `,
        [
          name,
          username,
          password,
          role,
          is_active === true,
          id
        ]
      );
    } else {
      await db.query(
        `
        UPDATE users
        SET
          name=$1,
          username=$2,
          role=$3,
          is_active=$4
        WHERE id=$5
        `,
        [
          name,
          username,
          role,
          is_active === true,
          id
        ]
      );
    }

    res.json({ success: true });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* ================= DELETE USER (DYNAMIC DB PASSWORD) ================= */
router.delete("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.json({ success: false, error: "Password required" });
    }

    // 🔍 DB Lookup for Delete User Password
    const passCheck = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'delete_user_pass'"
    );
    
    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "Delete user password configuration missing in DB!" });
    }

    // 🔒 Password Match Check
    if (password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Invalid security password" });
    }

    const q = await db.query(
      "DELETE FROM users WHERE id=$1 RETURNING id",
      [id]
    );

    if (q.rows.length === 0) {
      return res.json({ success: false, error: "User not found" });
    }

    res.json({ success: true, message: "User deleted successfully" });
  } catch (err) {
    console.error("DELETE USER ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ================= PERMISSIONS LIST ================= */
router.get("/permissions/list", async (req, res) => {
  const r = await db.query(
    "SELECT * FROM users ORDER BY id"
  );

  res.json({
    success: true,
    rows: r.rows
  });
});

/* ================= PERMISSIONS UPDATE (DYNAMIC DB PASSWORD) ================= */
router.post("/permissions/update", async (req, res) => {
  try {
    const { users, password } = req.body; // Frontend se password bhi accept karein

    if (!password) {
      return res.json({ success: false, error: "Password required" });
    }

    // 🔍 DB Lookup for Save Permissions Password
    const passCheck = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'save_permissions_pass'"
    );
    
    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "Save permissions password configuration missing in DB!" });
    }

    // 🔒 Password Validation Match Check
    if (password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Invalid security password" });
    }

    const perms = [
      "packages","ticketing","transport","ziyarat","visa","hotels","card","groups",
      "purchase_entry","purchase_list","pending_purchase",
      "registered_customer_ledger","customer_ledger","bank_profiles","supplier_ledger","bank_ledger","expense_ledger","balance_sheet","cash_ledger",
      "hotel_voucher","hotel_voucher3in1","transport_voucher","customiz_transport_voucher","customiz_hotel_voucher",
      "all_reports","all_reports_today","profit_report","monthly_profit_dashboard","sale_adjustment_report","supplier_purchase_detail_report","supplier_adjustment_only","item_loss_zero_report","sale_change_check_report",
      "create_user","manage_users","supplier","customers_list","deleted_reports","restore","system_storage","password_settings",
      "archive_manager","archive_list"
    ];

    for (const u of users) {
      const values = perms.map(p => u[p] === true);
      const setSQL = perms.map((p, i) => `${p}=$${i + 1}`).join(", ");
      
      await db.query(
        `UPDATE users SET ${setSQL} WHERE id=$${perms.length + 1}`,
        [...values, u.id]
      );
    }

    res.json({ success: true, message: "Permissions updated successfully" });
  } catch (err) {
    console.error("PERMISSIONS UPDATE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ================= VERIFY EDIT PASSWORD ROUTE ================= */
router.post("/verify-edit-password", async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.json({ success: false, error: "Password required" });

    const passCheck = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'edit_user_pass'"
    );

    if (passCheck.rows.length === 0 || password !== passCheck.rows[0].password_val) {
      return res.json({ success: false, error: "Invalid security password" });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;