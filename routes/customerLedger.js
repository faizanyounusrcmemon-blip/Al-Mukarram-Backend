const express = require("express");
const router = express.Router();
const db = require("../db");

/* =====================================================
   HELPER: SALE AMOUNT (Fast Single-Lookup)
===================================================== */
async function getSaleAmount(ref_no) {
  const cleanRef = (ref_no || "").trim();
  if (!cleanRef) return 0;

  const tables = ["bookings", "hotels", "visa", "card", "groups", "ticketing", "transport", "ziyarat"];

  // 1. Live booking / sales tables
  for (const tbl of tables) {
    try {
      const res = await db.query(
        `SELECT total_pkr AS amount FROM ${tbl} 
         WHERE TRIM(LOWER(ref_no)) = LOWER($1) 
         AND (customer_code IS NULL OR TRIM(customer_code) = '')
         AND (is_deleted IS NOT TRUE OR is_deleted IS NULL) LIMIT 1`,
        [cleanRef]
      );

      if (res.rows.length > 0) {
        return Number(res.rows[0].amount || 0);
      }
    } catch (e) {}
  }

  // 2. Archive balances table fallback (Only non-registered customers)
  try {
    const arch = await db.query(
      `SELECT balance FROM archive_balances 
       WHERE TRIM(LOWER(code)) = LOWER($1) 
       AND balance_type = 'CUSTOMER'
       AND UPPER(code) NOT LIKE 'CUST-%' LIMIT 1`,
      [cleanRef]
    );
    if (arch.rows.length > 0) {
      return Number(arch.rows[0].balance || 0);
    }
  } catch (e) {}

  return 0;
}

/* =====================================================
   HELPER: UPDATE PAYMENT STATUS
===================================================== */
async function updatePaymentStatus(ref_no) {
  try {
    const cleanRef = (ref_no || "").trim();
    if (!cleanRef) return;

    const totalSale = await getSaleAmount(cleanRef);

    const paid = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS paid FROM customer_payments 
       WHERE TRIM(LOWER(ref_no)) = LOWER($1) AND (is_deleted IS NOT TRUE OR is_deleted IS NULL)`,
      [cleanRef]
    );

    const totalPaid = Number(paid.rows[0]?.paid || 0);
    let status = "PENDING";

    if (totalPaid <= 0) {
      status = "PENDING";
    } else if (totalPaid > 0 && totalPaid < totalSale) {
      status = "PARTIAL";
    } else if (totalPaid >= totalSale && totalSale > 0) {
      status = "COMPLETE";
    }

    let table = null;
    const upperRef = cleanRef.toUpperCase();
    if (upperRef.startsWith("PKG-")) table = "bookings";
    else if (upperRef.startsWith("HOT-")) table = "hotels";
    else if (upperRef.startsWith("VISA-")) table = "visa";
    else if (upperRef.startsWith("CARD-")) table = "card";
    else if (upperRef.startsWith("GRP-")) table = "groups";
    else if (upperRef.startsWith("TIC-")) table = "ticketing";
    else if (upperRef.startsWith("TRN-")) table = "transport";
    else if (upperRef.startsWith("ZIY-")) table = "ziyarat";

    if (table) {
      await db.query(
        `UPDATE ${table} SET payment_status = $1 WHERE TRIM(LOWER(ref_no)) = LOWER($2)`,
        [status, cleanRef]
      );
    }

    return status;
  } catch (err) {
    console.error("Error updating payment status:", err.message);
  }
}

/* =====================================================
   PAYMENT PENDING / PARTIAL LIST (SUPER FAST & OPTIMIZED)
===================================================== */
router.get("/pending/list", async (req, res) => {
  try {
    const pendingMap = new Map();
    const tables = ["bookings", "hotels", "visa", "card", "groups", "ticketing", "transport", "ziyarat"];

    // 1. Direct Lookup: Fetch records directly using saved payment_status column (INSTANT)
    for (const tbl of tables) {
      try {
        const liveRes = await db.query(
          `SELECT ref_no, customer_name, payment_status 
           FROM ${tbl} 
           WHERE (customer_code IS NULL OR TRIM(customer_code) = '')
           AND (is_deleted IS NOT TRUE OR is_deleted IS NULL)
           AND UPPER(payment_status) IN ('PENDING', 'PARTIAL')`
        );

        for (const row of liveRes.rows) {
          if (!row.ref_no) continue;
          const cleanRef = row.ref_no.trim();
          const refKey = cleanRef.toLowerCase();

          pendingMap.set(refKey, {
            ref_no: cleanRef,
            customer_name: row.customer_name || "Walk-in Customer",
            payment_status: (row.payment_status || "PENDING").toUpperCase()
          });
        }
      } catch (e) {}
    }

    // 2. Archive Balances Lookup (Calculates PENDING/PARTIAL against payments)
    try {
      const payRes = await db.query(
        `SELECT LOWER(TRIM(ref_no)) as ref_key, COALESCE(SUM(amount), 0) as paid 
         FROM customer_payments 
         WHERE (is_deleted IS NOT TRUE OR is_deleted IS NULL)
         GROUP BY LOWER(TRIM(ref_no))`
      );

      const paymentsMap = new Map();
      payRes.rows.forEach(r => paymentsMap.set(r.ref_key, Number(r.paid || 0)));

      const archRes = await db.query(
        `SELECT code AS ref_no, name AS customer_name, COALESCE(balance, 0) as balance 
         FROM archive_balances 
         WHERE balance_type = 'CUSTOMER' 
         AND UPPER(code) NOT LIKE 'CUST-%'`
      );

      for (const arch of archRes.rows) {
        if (!arch.ref_no) continue;
        const cleanRef = arch.ref_no.trim();
        const refKey = cleanRef.toLowerCase();

        if (pendingMap.has(refKey)) continue;

        const totalSale = Number(arch.balance || 0);
        const totalPaid = paymentsMap.get(refKey) || 0;

        if (totalPaid < totalSale) {
          pendingMap.set(refKey, {
            ref_no: cleanRef,
            customer_name: arch.customer_name || "Walk-in Customer",
            payment_status: totalPaid > 0 ? "PARTIAL" : "PENDING"
          });
        }
      }
    } catch (e) {}

    const allPending = Array.from(pendingMap.values()).sort((a, b) => (b.ref_no > a.ref_no ? 1 : -1));

    res.json({
      success: true,
      rows: allPending
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* =====================================================
   CUSTOMER LEDGER DETAIL
===================================================== */
router.get("/:ref_no", async (req, res) => {
  try {
    const ref_no = (req.params.ref_no || "").trim();
    let rows = [];
    let balance = 0;
    let customerName = null;
    let baseDate = new Date();

    const tables = ["bookings", "hotels", "visa", "card", "groups", "ticketing", "transport", "ziyarat"];

    // 1. Prevent loading if it belongs to a Registered Customer
    if (ref_no.toUpperCase().startsWith("CUST-")) {
      return res.json({
        success: false,
        error: `Registered Customers [${ref_no}] ko Manual Ledger se load nahi kiya ja sakta. Registered Customer Ledger use karein.`
      });
    }

    for (const tbl of tables) {
      try {
        const checkRef = await db.query(
          `SELECT ref_no, customer_code FROM ${tbl} 
           WHERE TRIM(LOWER(ref_no)) = LOWER($1) 
           AND (is_deleted IS NOT TRUE OR is_deleted IS NULL) LIMIT 1`,
          [ref_no]
        );
        if (checkRef.rows.length > 0 && checkRef.rows[0].customer_code && checkRef.rows[0].customer_code.trim() !== "") {
          const linkedCode = checkRef.rows[0].customer_code.trim();
          return res.json({
            success: false,
            error: `Yeh Ref No (${ref_no}) Registered Customer Code [${linkedCode}] par mapped hai. Iska ledger Registered Customer module se load karein.`
          });
        }
      } catch (e) {}
    }

    // 2. Check Archive Balances (Non-Registered)
    try {
      const arch = await db.query(
        `SELECT name AS customer_name FROM archive_balances 
         WHERE TRIM(LOWER(code)) = LOWER($1) 
         AND balance_type = 'CUSTOMER' LIMIT 1`,
        [ref_no]
      );
      if (arch.rows.length > 0) {
        customerName = arch.rows[0].customer_name || "Walk-in Customer";
      }
    } catch (e) {}

    // 3. Check Live Sales Tables
    if (!customerName) {
      for (const tbl of tables) {
        try {
          const customer = await db.query(
            `SELECT customer_name, booking_date FROM ${tbl} 
             WHERE TRIM(LOWER(ref_no)) = LOWER($1) 
             AND (is_deleted IS NOT TRUE OR is_deleted IS NULL) LIMIT 1`,
            [ref_no]
          );
          if (customer.rows.length > 0) {
            customerName = customer.rows[0].customer_name || "Walk-in Customer";
            baseDate = customer.rows[0].booking_date || new Date();
            break;
          }
        } catch (e) {}
      }
    }

    if (!customerName) {
      return res.json({
        success: false,
        error: `No active record found for Customer / Reference No: ${ref_no}`
      });
    }

    /* HEADER */
    rows.push({
      id: "CUSTOMER",
      date: baseDate,
      description: `Customer: ${customerName}`,
      debit: 0,
      credit: 0,
      balance: 0
    });

    /* SALE / OPENING BALANCE */
    let saleDescription = `Sale Invoice (${ref_no})`;

    try {
      const archCheck = await db.query(
        `SELECT balance FROM archive_balances 
         WHERE TRIM(LOWER(code)) = LOWER($1) 
         AND balance_type = 'CUSTOMER' LIMIT 1`,
        [ref_no]
      );
      if (archCheck.rows.length > 0) {
        saleDescription = `Opening Balance (${ref_no})`;
      }
    } catch (e) {}

    const totalSale = Math.round(await getSaleAmount(ref_no));

    if (totalSale > 0) {
      balance += totalSale;
      rows.push({
        id: "SALE",
        date: baseDate,
        description: saleDescription,
        debit: 0,
        credit: totalSale,
        balance
      });
    }

    /* PAYMENTS WITH BANK NAME JOIN */
    const payments = await db.query(
      `SELECT 
         cp.id, 
         cp.payment_date, 
         cp.amount, 
         cp.type, 
         cp.payment_method, 
         b.bank_name
       FROM customer_payments cp
       LEFT JOIN public.banks b ON b.id = cp.bank_profile_id
       WHERE TRIM(LOWER(cp.ref_no)) = LOWER($1) 
       AND (cp.is_deleted IS NOT TRUE OR cp.is_deleted IS NULL) 
       ORDER BY cp.payment_date, cp.id`,
      [ref_no]
    );

    payments.rows.forEach(p => {
      const amount = Math.round(Number(p.amount || 0));
      balance -= amount;

      let methodDesc = p.payment_method || "";
      if (p.payment_method?.toLowerCase() === "bank" && p.bank_name) {
        methodDesc = `Bank: ${p.bank_name}`;
      } else if (p.payment_method?.toLowerCase() === "bank") {
        methodDesc = "Bank";
      }

rows.push({
  id: p.id,
  date: p.payment_date,
  description: p.type === "adjustment" ? "Adjustment" : `Payment Received (${methodDesc})`,
  debit: amount,
  credit: 0,
  balance,
  payment_method: p.payment_method || "-", // 👈 Yeh Add karein
  bank_name: p.bank_name || null           // 👈 Yeh Add karein
});
    });

    res.json({
      success: true,
      customer: customerName,
      customerName,
      totalSale,
      currentBalance: balance,
      rows
    });

  } catch (err) {
    console.error("CUSTOMER LEDGER ERROR:", err);
    res.json({
      success: false,
      error: err.message
    });
  }
});

/* =====================================================
   SAVE CUSTOMER PAYMENT
===================================================== */
router.post("/payment", async (req, res) => {
  const client = await db.connect();
  try {
    const { ref_no, amount, payment_method, bank_profile_id, type, payment_date } = req.body;

    if (!ref_no) return res.json({ success: false, error: "Ref No required" });
    if (!amount || Number(amount) <= 0) return res.json({ success: false, error: "Invalid amount" });
    if (!payment_date) return res.json({ success: false, error: "Date required" });

    const isBank = (payment_method || "").toLowerCase() === "bank";

    await client.query("BEGIN");
    await client.query(
      `
      INSERT INTO customer_payments (ref_no, amount, payment_method, bank_profile_id, type, payment_date)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        ref_no, 
        amount, 
        payment_method || "cash", 
        isBank ? (bank_profile_id || null) : null, 
        type || "payment", 
        payment_date
      ]
    );

    await client.query("COMMIT");
    await updatePaymentStatus(ref_no);

    res.json({
      success: true,
      message: "Payment saved successfully"
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.json({
      success: false,
      error: err.message
    });
  } finally {
    client.release();
  }
});

/* =====================================================
   DELETE CUSTOMER PAYMENT
===================================================== */
router.delete("/delete/:id", async (req, res) => {
  try {
    const { password } = req.body;

    const passCheck = await db.query("SELECT password_val FROM system_passwords WHERE key_name = $1", ['delete_customer_payment']);
    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "System password not configured in database!" });
    }

    const dbPassword = passCheck.rows[0].password_val;
    if (password !== dbPassword) {
      return res.json({ success: false, error: "Wrong password" });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const payRes = await client.query("SELECT ref_no FROM customer_payments WHERE id=$1", [req.params.id]);
      if (payRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.json({ success: false, error: "Payment not found" });
      }
      const ref_no = payRes.rows[0].ref_no;

      await client.query("DELETE FROM customer_payments WHERE id=$1", [req.params.id]);
      
      await client.query("COMMIT");

      await updatePaymentStatus(ref_no);
      
      res.json({ success: true, message: "Payment deleted" });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* =====================================================
   VERIFY PASSWORD FOR EDIT (STEP 1)
===================================================== */
router.post("/verify-password", async (req, res) => {
  try {
    const { password } = req.body;

    const passCheck = await db.query(
      "SELECT password_val FROM system_passwords WHERE key_name = $1",
      ["delete_customer_payment"]
    );

    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "System password not configured in database!" });
    }

    const dbPassword = passCheck.rows[0].password_val;

    if (password !== dbPassword) {
      return res.json({ success: false, error: "Incorrect Password!" });
    }

    res.json({ success: true, message: "Password verified" });
  } catch (err) {
    console.error("CUSTOMER LEDGER VERIFY PASSWORD ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =====================================================
   EDIT CUSTOMER PAYMENT (STEP 2 SUBMIT)
===================================================== */
router.put("/edit/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, payment_date, payment_method, bank_profile_id, type } = req.body;

    if (!id || isNaN(id)) {
      return res.json({ success: false, error: "Invalid payment ID" });
    }

    if (!amount || Number(amount) <= 0) {
      return res.json({ success: false, error: "Amount must be greater than zero" });
    }

    if (!payment_date) {
      return res.json({ success: false, error: "Payment date is required" });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const payRes = await client.query(
        "SELECT ref_no FROM customer_payments WHERE id = $1",
        [id]
      );

      if (payRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.json({ success: false, error: "Payment record not found!" });
      }

      const ref_no = payRes.rows[0].ref_no;
      const isBank = (payment_method || "").toLowerCase() === "bank";

      await client.query(
        `
        UPDATE customer_payments
        SET amount = $1, payment_date = $2, payment_method = $3, bank_profile_id = $4, type = $5
        WHERE id = $6
        `,
        [
          amount, 
          payment_date, 
          payment_method || "Bank", 
          isBank ? (bank_profile_id || null) : null, 
          type || "payment", 
          id
        ]
      );

      await client.query("COMMIT");

      await updatePaymentStatus(ref_no);

      res.json({ success: true, message: "Payment entry updated successfully" });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

  } catch (err) {
    console.error("CUSTOMER LEDGER EDIT ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;