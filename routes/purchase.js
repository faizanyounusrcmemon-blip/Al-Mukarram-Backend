const express = require("express");
const router = express.Router();
const db = require("../db");

/* =====================================================
   LOAD PURCHASE (UNIVERSAL SMART DESCRIPTION UPDATE) ✅
===================================================== */
router.get("/load/:ref_no", async (req, res) => {
  try {
    const { ref_no } = req.params;
    let rows = [];

    /* =========================
       CHECK EDIT MODE
    ========================= */
    const chk = await db.query(
      `SELECT COUNT(*) FROM purchase_entries 
       WHERE ref_no=$1 AND is_deleted=false`,
      [ref_no]
    );
    const isEdit = Number(chk.rows[0].count) > 0;

    /* =========================
       FETCH SALES DATA BASED ON REF PREFIX
    ========================= */
    let salesRow = null;
    if (ref_no.startsWith("PKG-")) {
      const q = await db.query(
        `SELECT * FROM bookings WHERE ref_no=$1 AND is_deleted=false`,
        [ref_no]
      );
      if (!q.rows.length) return res.json({ success:false, error:"Package not found" });
      salesRow = q.rows[0];

      let airline = "";
      let from = "";
      let to = "";

      if (Array.isArray(salesRow.flights) && salesRow.flights.length > 0) {
        const f = salesRow.flights[0];
        airline = f.airline || f.airline_name || "";
        from = f.from || f.flight_from || "";
        to = f.to || f.flight_to || "";
      }

      const routeText = from && to ? `${from} → ${to}` : "";
      const extraInfo = [airline, routeText].filter(Boolean).join(" | ");

      // TICKETS (Per Person)
      if (salesRow.adult_count > 0) {
        const qty = Number(salesRow.adult_count);
        const rateSar = Number(salesRow.adult_rate);
        rows.push({
          item: `Ticket – Adult (${qty} Person${qty > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          unit_qty: qty,
          sale_per_unit: rateSar,
          sale_sar: qty * rateSar,
          sale_rate: salesRow.flight_sar_rate || 0,
          sale_pkr: (qty * rateSar) * (salesRow.flight_sar_rate || 0),
        });
      }

      if (salesRow.child_count > 0) {
        const qty = Number(salesRow.child_count);
        const rateSar = Number(salesRow.child_rate);
        rows.push({
          item: `Ticket – Child (${qty} Person${qty > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          unit_qty: qty,
          sale_per_unit: rateSar,
          sale_sar: qty * rateSar,
          sale_rate: salesRow.flight_sar_rate || 0,
          sale_pkr: (qty * rateSar) * (salesRow.flight_sar_rate || 0),
        });
      }

      if (salesRow.infant_count > 0) {
        const qty = Number(salesRow.infant_count);
        const rateSar = Number(salesRow.infant_rate);
        rows.push({
          item: `Ticket – Infant (${qty} Person${qty > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          unit_qty: qty,
          sale_per_unit: rateSar,
          sale_sar: qty * rateSar,
          sale_rate: salesRow.flight_sar_rate || 0,
          sale_pkr: (qty * rateSar) * (salesRow.flight_sar_rate || 0),
        });
      }

      // HOTELS (Per Nights / Rooms calculation factor)
      if (Array.isArray(salesRow.hotels)) {
        salesRow.hotels.forEach((h, i) => {
          const rooms = Number(h.rooms) || 1;
          const nights = Number(h.nights) || 1;
          const unitFactor = rooms * nights;
          const totalSar = Number(h.total) || 0;
          const perUnit = unitFactor > 0 ? totalSar / unitFactor : 0;
          const type = h.type ? h.type.toUpperCase() : "";

          rows.push({
            item: `Hotel ${i + 1} - ${h.hotel || ""} (${type}${type ? ", " : ""}${rooms} Room${rooms > 1 ? "s" : ""}, ${nights} Night${nights > 1 ? "s" : ""})`,
            unit_qty: unitFactor,
            sale_per_unit: perUnit,
            sale_sar: totalSar,
            sale_rate: salesRow.hotel_sar_rate || 0,
            sale_pkr: totalSar * (salesRow.hotel_sar_rate || 0),
          });
        });
      }

      // VISA (Per Person)
      if (Array.isArray(salesRow.visa)) {
        salesRow.visa.forEach((v, i) => {
          const persons = Number(v.persons) || 1;
          const rate = Number(v.rate) || 0;
          const total = Number(v.total ?? (persons * rate));

          const itemName = v.type
            ? `Visa ${i+1} - ${v.type} (${persons} Person${persons > 1 ? "s" : ""})`
            : `Visa ${i+1} (${persons} Person${persons > 1 ? "s" : ""})`;

          rows.push({
            item: itemName,
            unit_qty: persons,
            sale_per_unit: rate,
            sale_sar: total,
            sale_rate: Number(salesRow.visa_sar_rate || 0),
            sale_pkr: total * Number(salesRow.visa_sar_rate || 0)
          });
        });
      }

      // PACKAGES TRANSPORT (With Vehicle Support)
      if (Array.isArray(salesRow.transport)) {
        salesRow.transport.forEach((t, i) => {
          const base = `Transport ${i + 1}`;
          const label = t.text || t.route || t.description || "";
          const vehicle = t.vehicle ? ` [${t.vehicle}]` : "";
          const persons = Number(t.persons) || 1;
          const rate = Number(t.rate) || 0;
          const sar = Number(t.amount) || (persons * rate);
          const perUnit = persons > 0 ? sar / persons : rate;
          
          let formattedDate = "";
          if (t.date) {
            const d = new Date(t.date);
            if (!isNaN(d.getTime())) {
              const day = String(d.getDate()).padStart(2, "0");
              const mon = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
              const year = d.getFullYear();
              formattedDate = ` (${day}/${mon}/${year})`;
            }
          }

          const descPart = label ? ` - ${label}` : "";
          const itemName = `${base}${formattedDate}${descPart}${vehicle} (${persons} Person${persons > 1 ? "s" : ""})`;

          rows.push({
            item: itemName,
            unit_qty: persons,
            sale_per_unit: perUnit,
            sale_sar: sar,
            sale_rate: salesRow.transport_sar_rate || 0,
            sale_pkr: sar * (salesRow.transport_sar_rate || 0)
          });
        });
      }

      // PACKAGES ZIYARAT (With Vehicle Support)
      if (Array.isArray(salesRow.ziyarat)) {
        salesRow.ziyarat.forEach((t, i) => {
          const base = `Ziyarat ${i+1}`;
          const label = t.text || t.route || t.description || "";
          const vehicle = t.vehicle ? ` [${t.vehicle}]` : "";
          const persons = Number(t.persons) || 1;
          const rate = Number(t.rate) || 0;
          const sar = Number(t.amount) || (persons * rate);
          const perUnit = persons > 0 ? sar / persons : rate;

          let formattedDate = "";
          if (t.date) {
            const d = new Date(t.date);
            if (!isNaN(d.getTime())) {
              const day = String(d.getDate()).padStart(2, "0");
              const mon = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
              const year = d.getFullYear();
              formattedDate = ` (${day}/${mon}/${year})`;
            }
          }

          const descPart = label ? ` - ${label}` : "";
          const itemName = `${base}${formattedDate}${descPart}${vehicle} (${persons} Person${persons > 1 ? "s" : ""})`;

          rows.push({
            item: itemName,
            unit_qty: persons,
            sale_per_unit: perUnit,
            sale_sar: sar,
            sale_rate: salesRow.ziyarat_sar_rate || 0,
            sale_pkr: sar * (salesRow.ziyarat_sar_rate || 0)
          });
        });
      }

      // AGENT COMMISSION
      if (salesRow.show_agent_comm) {
        if (Array.isArray(salesRow.agent_comm) && salesRow.agent_comm.length > 0) {
          salesRow.agent_comm.forEach((ac, i) => {
            const persons = Number(ac.persons || ac.qty || 1);
            const ratePkr = Number(ac.rate || ac.rate_pkr || 0);
            const totalPkr = Number(ac.total || ac.amount || (persons * ratePkr) || 0);
            const perUnitPkr = persons > 0 ? (totalPkr / persons) : totalPkr;

            const agentName = ac.agent_name || ac.name || ac.title || ac.type || "";
            const personText = ` (${persons} Person${persons > 1 ? "s" : ""})`;

            rows.push({
              item: agentName ? `Agent Commission ${i + 1} - ${agentName}${personText}` : `Agent Commission ${i + 1}${personText}`,
              unit_qty: persons,
              sale_per_unit: perUnitPkr,
              sale_sar: totalPkr,
              sale_rate: 1,
              sale_pkr: totalPkr
            });
          });
        } else if (Number(salesRow.agent_comm_total) > 0) {
          const totalPkr = Number(salesRow.agent_comm_total);
          rows.push({
            item: `Agent Commission`,
            unit_qty: 1,
            sale_per_unit: totalPkr,
            sale_sar: totalPkr,
            sale_rate: 1,
            sale_pkr: totalPkr
          });
        }
      }
    }

    /* =========================
       HOTEL ONLY (HOT-)
    ========================= */
    else if (ref_no.startsWith("HOT-")) {
      const q = await db.query(
        `
        SELECT
          hotel_name,
          hotel_total,
          sar_rate,
          hotel_type,
          hotel_rooms,
          hotel_nights
        FROM hotels
        WHERE ref_no=$1 AND is_deleted=false
        `,
        [ref_no]
      );

      if (!q.rows.length)
        return res.json({ success: false, error: "Hotel not found" });

      const r = q.rows[0];

      (r.hotel_name || []).forEach((name, i) => {
        const type = r.hotel_type?.[i]
          ? r.hotel_type[i].toUpperCase()
          : "";
        const rooms = Number(r.hotel_rooms?.[i]) || 1;
        const nights = Number(r.hotel_nights?.[i]) || 1;
        const unitFactor = rooms * nights || 1;
        const totalSar = Number(r.hotel_total?.[i]) || 0;
        const perUnit = unitFactor > 0 ? totalSar / unitFactor : 0;

        rows.push({
          item: `Hotel ${i + 1} - ${name} (${type}${type ? ", " : ""}${rooms} Room${rooms > 1 ? "s" : ""}, ${nights} Night${nights > 1 ? "s" : ""})`,
          unit_qty: unitFactor,
          sale_per_unit: perUnit,
          sale_sar: totalSar,
          sale_rate: r.sar_rate || 0,
          sale_pkr: totalSar * (r.sar_rate || 0),
        });
      });
    }

    // =======================
    // VISA ONLY REF (VISA-)
    // =======================
    else if (ref_no.startsWith("VISA-")) {
      const q = await db.query(
        `SELECT * FROM visa WHERE ref_no=$1 AND is_deleted=false`,
        [ref_no]
      );
      if (!q.rows.length) return res.json({ success:false, error:"Visa not found" });

      const v = q.rows[0];
      (v.rows || []).forEach((r, i) => {
        const persons = Number(r.persons) || 1;
        const rate = Number(r.rate) || 0;
        const sar = Number(r.total) || (persons * rate);
        const perUnit = persons > 0 ? sar / persons : rate;
        const pkrRate = Number(v.pkr_rate) || 0;

        const itemName = r.type
          ? `Visa ${i + 1} - ${r.type} (${persons} Person${persons > 1 ? "s" : ""})`
          : `Visa (${persons} Person${persons > 1 ? "s" : ""})`;

        rows.push({
          item: itemName,
          unit_qty: persons,
          sale_per_unit: perUnit,
          sale_sar: sar,
          sale_rate: pkrRate,
          sale_pkr: sar * pkrRate
        });
      });
    }

    // =======================
    // CARD ONLY REF (CARD-)
    // =======================
    else if (ref_no.startsWith("CARD-")) {
      const q = await db.query(
        `SELECT * FROM card WHERE ref_no=$1 AND is_deleted=false`,
        [ref_no]
      );
      if (!q.rows.length) return res.json({ success:false, error:"Card not found" });

      const v = q.rows[0];
      (v.rows || []).forEach((r, i) => {
        const persons = Number(r.persons) || 1;
        const rate = Number(r.rate) || 0;
        const sar = Number(r.total) || (persons * rate);
        const perUnit = persons > 0 ? sar / persons : rate;
        const pkrRate = Number(v.pkr_rate) || 0;

        const itemName = r.type
          ? `Card ${i + 1} - ${r.type} (${persons} Person${persons > 1 ? "s" : ""})`
          : `Card (${persons} Person${persons > 1 ? "s" : ""})`;

        rows.push({
          item: itemName,
          unit_qty: persons,
          sale_per_unit: perUnit,
          sale_sar: sar,
          sale_rate: pkrRate,
          sale_pkr: sar * pkrRate
        });
      });
    }

    // =======================
    // GROUPS ONLY REF (GRP-)
    // =======================
    else if (ref_no.startsWith("GRP-")) {
      const q = await db.query(
        `SELECT * FROM groups WHERE ref_no=$1 AND is_deleted=false`,
        [ref_no]
      );
      if (!q.rows.length) return res.json({ success:false, error:"Groups not found" });

      const v = q.rows[0];
      (v.rows || []).forEach((r, i) => {
        const persons = Number(r.persons) || 1;
        const rate = Number(r.rate) || 0;
        const sar = Number(r.total) || (persons * rate);
        const perUnit = persons > 0 ? sar / persons : rate;
        const pkrRate = Number(v.pkr_rate) || 0;

        const itemName = r.type
          ? `Groups ${i + 1} - ${r.type} (${persons} Person${persons > 1 ? "s" : ""})`
          : `Groups (${persons} Person${persons > 1 ? "s" : ""})`;

        rows.push({
          item: itemName,
          unit_qty: persons,
          sale_per_unit: perUnit,
          sale_sar: sar,
          sale_rate: pkrRate,
          sale_pkr: sar * pkrRate
        });
      });
    }

    /* =========================
       TRANSPORT ONLY (TRN-)
    ========================= */
    else if (ref_no.startsWith("TRN-")) {
      const q = await db.query(
        `
        SELECT rows, pkr_rate
        FROM transport
        WHERE ref_no=$1 AND is_deleted=false
        `,
        [ref_no]
      );

      if (!q.rows.length)
        return res.json({ success: false, error: "Transport not found" });

      const r = q.rows[0];

      if (Array.isArray(r.rows)) {
        r.rows.forEach((t, i) => {
          const baseItem = `Transport ${i + 1}`;
          const label = t.description || t.text || t.route || "";
          const vehicle = t.vehicle ? ` [${t.vehicle}]` : "";
          const persons = Number(t.persons) || 1;
          const rateVal = Number(t.rate) || 0;
          const sar = Number(t.total) || Number(t.sar) || Number(t.amount) || (persons * rateVal);
          const perUnit = persons > 0 ? sar / persons : rateVal;
          const rate = Number(r.pkr_rate) || 0;
          
          const rawDate = t.date || t.travelDate || t.travel_date;
          let formattedDate = "";
          
          if (rawDate) {
            const d = new Date(rawDate);
            if (!isNaN(d.getTime())) {
              const day = String(d.getDate()).padStart(2, "0");
              const mon = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
              const year = d.getFullYear();
              formattedDate = ` (${day}/${mon}/${year})`;
            }
          }

          const descPart = label ? ` - ${label}` : "";
          const itemName = `${baseItem}${formattedDate}${descPart}${vehicle} (${persons} Person${persons > 1 ? "s" : ""})`;

          rows.push({
            item: itemName,
            unit_qty: persons,
            sale_per_unit: perUnit,
            sale_sar: sar,
            sale_rate: rate,
            sale_pkr: sar * rate,
          });
        });
      }
    }

    /* =========================
       ZIYARAT ONLY (ZIY-)
    ========================= */
    else if (ref_no.startsWith("ZIY-")) {
      const q = await db.query(
        `
        SELECT rows, pkr_rate
        FROM ziyarat
        WHERE ref_no=$1 AND is_deleted=false
        `,
        [ref_no]
      );

      if (!q.rows.length)
        return res.json({ success: false, error: "Ziyarat not found" });

      const r = q.rows[0];

      if (Array.isArray(r.rows)) {
        r.rows.forEach((t, i) => {
          const baseItem = `Ziyarat ${i + 1}`;
          const label = t.description || t.text || t.route || "";
          const vehicle = t.vehicle ? ` [${t.vehicle}]` : "";
          const persons = Number(t.persons) || 1;
          const rateVal = Number(t.rate) || 0;
          const sar = Number(t.total) || Number(t.sar) || Number(t.amount) || (persons * rateVal);
          const perUnit = persons > 0 ? sar / persons : rateVal;
          const rate = Number(r.pkr_rate) || 0;

          const rawDate = t.date || t.travelDate || t.travel_date;
          let formattedDate = "";
          
          if (rawDate) {
            const d = new Date(rawDate);
            if (!isNaN(d.getTime())) {
              const day = String(d.getDate()).padStart(2, "0");
              const mon = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
              const year = d.getFullYear();
              formattedDate = ` (${day}/${mon}/${year})`;
            }
        }

          const descPart = label ? ` - ${label}` : "";
          const itemName = `${baseItem}${formattedDate}${descPart}${vehicle} (${persons} Person${persons > 1 ? "s" : ""})`;

          rows.push({
            item: itemName,
            unit_qty: persons,
            sale_per_unit: perUnit,
            sale_sar: sar,
            sale_rate: rate,
            sale_pkr: sar * rate,
          });
      });
    }
  }

    /* =========================
       TICKETING ONLY (TIC-)
    ========================= */
    else if (ref_no.startsWith("TIC-")) {
      const q = await db.query(
        `
        SELECT adult_qty, adult_rate,
               child_qty, child_rate,
               infant_qty, infant_rate,
               pkr_rate,
               flight_from,
               flight_to,
               airline
        FROM ticketing
        WHERE ref_no=$1 AND is_deleted=false
        `,
        [ref_no]
      );

      if (!q.rows.length)
        return res.json({ success: false, error: "Ticket not found" });

      const r = q.rows[0];

      const from = Array.isArray(r.flight_from) ? r.flight_from.join(", ") : r.flight_from || "";
      const to = Array.isArray(r.flight_to) ? r.flight_to.join(", ") : r.flight_to || "";
      const airline = Array.isArray(r.airline) ? r.airline.join(", ") : r.airline || "";

      const routeText = from && to ? `${from} → ${to}` : "";
      const extraInfo = [airline, routeText].filter(Boolean).join(" | ");

      if (r.adult_qty > 0) {
        const qty = Number(r.adult_qty);
        const rate = Number(r.adult_rate);
        rows.push({
          item: `Ticket – Adult (${qty} Person${qty > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          unit_qty: qty,
          sale_per_unit: rate,
          sale_sar: qty * rate,
          sale_rate: r.pkr_rate,
          sale_pkr: qty * rate * r.pkr_rate,
        });
      }

      if (r.child_qty > 0) {
        const qty = Number(r.child_qty);
        const rate = Number(r.child_rate);
        rows.push({
          item: `Ticket – Child (${qty} Person${qty > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          unit_qty: qty,
          sale_per_unit: rate,
          sale_sar: qty * rate,
          sale_rate: r.pkr_rate,
          sale_pkr: qty * rate * r.pkr_rate,
        });
      }

      if (r.infant_qty > 0) {
        const qty = Number(r.infant_qty);
        const rate = Number(r.infant_rate);
        rows.push({
          item: `Ticket – Infant (${qty} Person${qty > 1 ? "s" : ""})${extraInfo ? " - " + extraInfo : ""}`,
          unit_qty: qty,
          sale_per_unit: rate,
          sale_sar: qty * rate,
          sale_rate: r.pkr_rate,
          sale_pkr: qty * rate * r.pkr_rate,
        });
      }

    } else {
      return res.json({ success: false, error: "Invalid Ref No" });
    }

  const p = await db.query(
    `SELECT * FROM purchase_entries WHERE ref_no=$1 AND is_deleted=false`,
    [ref_no]
  );

  // 🔹 UNIVERSAL SMART UPDATE: Har module/prefix ke liye agar item ki description/route change hui hai toh purane record ko UPDATE kar do
  for (const r of rows) {
    const basePrefix = r.item.split(" - ")[0].split(" (")[0]; // Jaise "Transport 2", "Hotel 1", "Ziyarat 1", "Visa 1", etc.
    
    const existingMatch = p.rows.find(oldP => oldP.item !== r.item && oldP.item.startsWith(basePrefix));
    
    if (existingMatch) {
      await db.query(
        `UPDATE purchase_entries SET item=$1 WHERE id=$2`,
        [r.item, existingMatch.id]
      );
      existingMatch.item = r.item;
    }
  }

  rows = rows.map(r => {
    const baseItem = r.item.split(" - ")[0].split(" (")[0];
    const x = p.rows.find(p => p.item === r.item || p.item.startsWith(baseItem));

    const sale_sar = Number(r.sale_sar) || 0;
    const sale_rate = Number(r.sale_rate) || 0;
    const sale_pkr = sale_sar * sale_rate;
    const unit_qty = Number(r.unit_qty) || 1;

    const raw_sar = r.purchase_sar !== undefined ? r.purchase_sar : x?.purchase_sar;
    const raw_rate = r.purchase_rate !== undefined ? r.purchase_rate : x?.purchase_rate;
    const raw_per_unit = x?.purchase_per_unit;

    const sarCleared = raw_sar === "" || raw_sar === null || Number(raw_sar) === 0;
    const rateCleared = raw_rate === "" || raw_rate === null || Number(raw_rate) === 0;

    let purchase_sar = "";
    let purchase_rate = "";
    let purchase_per_unit = "";
    let purchase_pkr = 0;
    let profit = 0;

    if (!sarCleared && !rateCleared) {
      purchase_sar = Number(raw_sar);
      purchase_rate = Number(raw_rate);
      purchase_per_unit = raw_per_unit ? Number(raw_per_unit) : (purchase_sar / unit_qty);
      purchase_pkr = purchase_sar * purchase_rate;
      profit = sale_pkr - purchase_pkr;
    }

    return {
      ...r,
      unit_qty,
      sale_per_unit: r.sale_per_unit || (sale_sar / unit_qty),
      sale_sar,
      sale_rate,
      sale_pkr,
      purchase_per_unit,
      purchase_sar,
      purchase_rate,
      purchase_pkr,
      profit,
      supplier_code: x?.supplier_code ?? "",
      supplier_name: x?.supplier_name ?? ""
    };
  });

let customer_name = "";
  let sub_customer_name = "";

  const cust = await db.query(`
    SELECT customer_name, sub_customer_name FROM bookings WHERE ref_no=$1 AND is_deleted=false
    UNION SELECT customer_name, sub_customer_name FROM hotels WHERE ref_no=$1 AND is_deleted=false
    UNION SELECT customer_name, sub_customer_name FROM visa WHERE ref_no=$1 AND is_deleted=false
    UNION SELECT customer_name, sub_customer_name FROM card WHERE ref_no=$1 AND is_deleted=false
    UNION SELECT customer_name, sub_customer_name FROM groups WHERE ref_no=$1 AND is_deleted=false
    UNION SELECT customer_name, sub_customer_name FROM ticketing WHERE ref_no=$1 AND is_deleted=false
    UNION SELECT customer_name, sub_customer_name FROM transport WHERE ref_no=$1 AND is_deleted=false
    UNION SELECT customer_name, sub_customer_name FROM ziyarat WHERE ref_no=$1 AND is_deleted=false
    LIMIT 1
  `, [ref_no]);

  if (cust.rows.length) {
    customer_name = cust.rows[0].customer_name || "";
    sub_customer_name = cust.rows[0].sub_customer_name || "";
  }

  return res.json({ success: true, is_edit: isEdit, customer_name, sub_customer_name, rows });
     
  } catch(err){
    console.error("PURCHASE LOAD ERROR:", err);
    return res.json({ success:false, error: err.message });
  }
});

/* =====================================================
   SAVE PURCHASE (UPSERT) + PURCHASE STATUS
===================================================== */
router.post("/save", async (req, res) => {
  try {
    const { ref_no, items } = req.body;

    if (!ref_no || !Array.isArray(items)) {
      return res.json({
        success: false,
        error: "Invalid payload"
      });
    }

    const unique = [];
    const seen = new Set();

    for (const r of items) {
      if (!r.item) continue;

      const key = r.item.trim();

      if (seen.has(key)) continue;

      seen.add(key);
      unique.push(r);
    }

    // ==========================
    // SAVE PURCHASE ENTRIES
    // ==========================
    for (const r of unique) {

      const sale_sar = Number(r.sale_sar) || 0;
      const sale_rate = Number(r.sale_rate) || 0;
      const sale_pkr = sale_sar * sale_rate;

      const purchase_sar = Number(r.purchase_sar) || 0;
      const purchase_rate = Number(r.purchase_rate) || 0;

      const purchase_pkr =
        purchase_sar > 0 && purchase_rate > 0
          ? purchase_sar * purchase_rate
          : 0;

      const purchaseComplete =
        purchase_sar > 0 &&
        purchase_rate > 0;

      const profit = purchaseComplete
        ? sale_pkr - purchase_pkr
        : 0;

      await db.query(
        `
        INSERT INTO purchase_entries (
          ref_no,
          item,
          sale_sar,
          sale_rate,
          sale_pkr,
          purchase_sar,
          purchase_rate,
          purchase_pkr,
          profit,
          supplier_code,
          supplier_name,
          is_deleted
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,
          $10,$11,false
        )

        ON CONFLICT (ref_no,item)
        DO UPDATE SET
          sale_sar      = EXCLUDED.sale_sar,
          sale_rate     = EXCLUDED.sale_rate,
          sale_pkr      = EXCLUDED.sale_pkr,
          purchase_sar  = EXCLUDED.purchase_sar,
          purchase_rate = EXCLUDED.purchase_rate,
          purchase_pkr  = EXCLUDED.purchase_pkr,
          profit        = EXCLUDED.profit,
          supplier_code = EXCLUDED.supplier_code,
          supplier_name = EXCLUDED.supplier_name,
          is_deleted    = false
        `,
        [
          ref_no,
          r.item,
          sale_sar,
          sale_rate,
          sale_pkr,
          purchase_sar,
          purchase_rate,
          purchase_pkr,
          profit,
          r.supplier_code || "",
          r.supplier_name || ""
        ]
      );
    }

    // ==========================
    // CALCULATE STATUS
    // ==========================
    const totalRows = unique.length;

    const completedRows = unique.filter(
      r =>
        Number(r.purchase_sar) > 0 &&
        Number(r.purchase_rate) > 0
    ).length;

    let purchaseStatus = "PENDING";

    if (completedRows === 0) {
      purchaseStatus = "PENDING";
    }
    else if (completedRows < totalRows) {
      purchaseStatus = "PARTIAL";
    }
    else {
      purchaseStatus = "COMPLETE";
    }

    // ==========================
    // UPDATE SALES TABLE STATUS
    // ==========================
    if (ref_no.startsWith("PKG-")) {

      await db.query(
        `UPDATE bookings
         SET purchase_status=$1
         WHERE ref_no=$2`,
        [purchaseStatus, ref_no]
      );

    } else if (ref_no.startsWith("HOT-")) {

      await db.query(
        `UPDATE hotels
         SET purchase_status=$1
         WHERE ref_no=$2`,
        [purchaseStatus, ref_no]
      );

    } else if (ref_no.startsWith("VISA-")) {

      await db.query(
        `UPDATE visa
         SET purchase_status=$1
         WHERE ref_no=$2`,
        [purchaseStatus, ref_no]
      );

    } else if (ref_no.startsWith("CARD-")) {

      await db.query(
        `UPDATE card
         SET purchase_status=$1
         WHERE ref_no=$2`,
        [purchaseStatus, ref_no]
      );

    } else if (ref_no.startsWith("GRP-")) {

      await db.query(
        `UPDATE groups
         SET purchase_status=$1
         WHERE ref_no=$2`,
        [purchaseStatus, ref_no]
      );


    } else if (ref_no.startsWith("TIC-")) {

      await db.query(
        `UPDATE ticketing
         SET purchase_status=$1
         WHERE ref_no=$2`,
        [purchaseStatus, ref_no]
      );

    } else if (ref_no.startsWith("TRN-")) {

      await db.query(
        `UPDATE transport
         SET purchase_status=$1
         WHERE ref_no=$2`,
        [purchaseStatus, ref_no]
      );

    } else if (ref_no.startsWith("ZIY-")) {

      await db.query(
        `UPDATE ziyarat
         SET purchase_status=$1
         WHERE ref_no=$2`,
        [purchaseStatus, ref_no]
      );
    }

    // ==========================
    // FINAL RESPONSE
    // ==========================
    res.json({
      success: true,
      purchase_status: purchaseStatus,
      message: "✅ Purchase saved / updated"
    });

  } catch (err) {

    console.error("PURCHASE UPSERT ERROR:", err);

    res.json({
      success: false,
      error: err.message
    });
  }
});

/* =====================================================
   PURCHASE LIST (WITH CUSTOMER NAME & CODE)
===================================================== */
router.get("/list", async (req, res) => {
  try {
    const { from, to, ref } = req.query;

    let where = `WHERE p.is_deleted = false`;
    let params = [];
    let i = 1;

    // DATE FILTER
    if (from && to) {
      where += ` AND DATE(p.created_at) BETWEEN $${i} AND $${i + 1}`;
      params.push(from, to);
      i += 2;
    }

    // PARTIAL SEARCH (REF NO OR CUSTOMER NAME)
    if (ref) {
      where += `
        AND (
          p.ref_no ILIKE $${i}
          OR s.customer_name ILIKE $${i}
          OR s.customer_code ILIKE $${i}
        )
      `;
      params.push(`%${ref}%`);
      i += 1;
    }

    const q = await db.query(
      `
      SELECT
        p.ref_no,
        MAX(s.customer_name) AS customer_name,
        MAX(s.customer_code) AS customer_code,
        SUM(p.sale_pkr)      AS sale_pkr,
        SUM(p.purchase_pkr)  AS purchase_pkr,
        SUM(p.profit)        AS profit,
        MIN(p.created_at)    AS created_at
      FROM purchase_entries p
      LEFT JOIN (
        SELECT ref_no, customer_name, customer_code FROM bookings
        UNION ALL
        SELECT ref_no, customer_name, customer_code FROM hotels
        UNION ALL
        SELECT ref_no, customer_name, customer_code FROM visa
        UNION ALL
        SELECT ref_no, customer_name, customer_code FROM card
        UNION ALL
        SELECT ref_no, customer_name, customer_code FROM groups
        UNION ALL
        SELECT ref_no, customer_name, customer_code FROM ticketing
        UNION ALL
        SELECT ref_no, customer_name, customer_code FROM transport
        UNION ALL
        SELECT ref_no, customer_name, customer_code FROM ziyarat
      ) s ON s.ref_no = p.ref_no
      ${where}
      GROUP BY p.ref_no
      ORDER BY created_at DESC
      `,
      params
    );

    res.json({ success: true, rows: q.rows });

  } catch (err) {
    console.error("PURCHASE LIST ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});


/* =====================================================
   ✅ PURCHASE SOFT DELETE WITH DYNAMIC PASSWORD LOOKUP
===================================================== */
router.delete("/delete/:ref_no", async (req, res) => {
  try {
    const { ref_no } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.json({ success: false, error: "Password required" });
    }

    // 🔍 DATABASE LOOKUP: Aapki system_passwords table se column 'password_val' ko lookup karega
    const passCheck = await db.query(
      "SELECT password_val FROM public.system_passwords WHERE key_name = 'delete_purchase_pass'"
    );
    
    if (passCheck.rows.length === 0) {
      return res.json({ 
        success: false, 
        error: "Delete purchase password configuration not found in DB!" 
      });
    }

    const currentDeletePass = passCheck.rows[0].password_val;

    // 🔒 PASSWORD COMPARISON VALIDATION
    if (password !== currentDeletePass) {
      return res.json({
        success: false,
        error: "Invalid password",
      });
    }

    // ===============================
    // SOFT DELETE PURCHASE ENTRIES
    // ===============================
    const q = await db.query(
      `
      UPDATE purchase_entries
      SET is_deleted = true
      WHERE ref_no = $1
      RETURNING ref_no
      `,
      [ref_no]
    );

    if (!q.rows.length) {
      return res.json({
        success: false,
        error: "Purchase not found",
      });
    }

    // ===============================
    // RESET PURCHASE STATUS
    // ===============================
    if (ref_no.startsWith("PKG-")) {
      await db.query(`UPDATE bookings SET purchase_status='PENDING' WHERE ref_no=$1`, [ref_no]);
    }
    else if (ref_no.startsWith("HOT-")) {
      await db.query(`UPDATE hotels SET purchase_status='PENDING' WHERE ref_no=$1`, [ref_no]);
    }
    else if (ref_no.startsWith("VISA-")) {
      await db.query(`UPDATE visa SET purchase_status='PENDING' WHERE ref_no=$1`, [ref_no]);
    }
    else if (ref_no.startsWith("CARD-")) {
      await db.query(`UPDATE card SET purchase_status='PENDING' WHERE ref_no=$1`, [ref_no]);
    }
    else if (ref_no.startsWith("GRP-")) {
      await db.query(`UPDATE groups SET purchase_status='PENDING' WHERE ref_no=$1`, [ref_no]);
    }
    else if (ref_no.startsWith("TIC-")) {
      await db.query(`UPDATE ticketing SET purchase_status='PENDING' WHERE ref_no=$1`, [ref_no]);
    }
    else if (ref_no.startsWith("TRN-")) {
      await db.query(`UPDATE transport SET purchase_status='PENDING' WHERE ref_no=$1`, [ref_no]);
    }
    else if (ref_no.startsWith("ZIY-")) {
      await db.query(`UPDATE ziyarat SET purchase_status='PENDING' WHERE ref_no=$1`, [ref_no]);
    }

    res.json({
      success: true,
      message: "✅ Purchase deleted successfully"
    });

  } catch (err) {
    console.error("PURCHASE DELETE ERROR:", err);
    res.json({
      success: false,
      error: err.message
    });
  }
});


/* =====================================================
   PURCHASE DETAIL ✅ DYNAMIC PER UNIT CALCULATION
===================================================== */
router.get("/detail/:ref_no", async (req, res) => {
  try {
    const { ref_no } = req.params;

    const q = await db.query(
      `
      SELECT
        p.ref_no,
        p.item,
        p.sale_sar,
        p.sale_rate,
        p.sale_pkr,
        p.purchase_sar,
        p.purchase_rate,
        p.purchase_pkr,
        p.profit,
        p.supplier_code,
        p.supplier_name,
        p.created_at,
        s.customer_name
      FROM purchase_entries p
      LEFT JOIN (
        SELECT ref_no, customer_name FROM bookings
        UNION ALL
        SELECT ref_no, customer_name FROM hotels
        UNION ALL
        SELECT ref_no, customer_name FROM visa
        UNION ALL
        SELECT ref_no, customer_name FROM card
        UNION ALL
        SELECT ref_no, customer_name FROM groups
        UNION ALL
        SELECT ref_no, customer_name FROM ticketing
        UNION ALL
        SELECT ref_no, customer_name FROM transport
        UNION ALL
        SELECT ref_no, customer_name FROM ziyarat
      ) s ON s.ref_no = p.ref_no
      WHERE p.ref_no=$1 AND p.is_deleted=false
      ORDER BY p.item
      `,
      [ref_no]
    );

    if (!q.rows.length) {
      return res.json({ success: false, error: "Purchase entry not found" });
    }

    const rows = q.rows.map(r => {
      const saleSar = Number(r.sale_sar) || 0;
      const purchSar = Number(r.purchase_sar) || 0;

      // Item text se quantity/unit factor extract karna (jaise: 2 Persons, Rooms, etc.)
      let qty = 1;
      const match = r.item.match(/\((\d+)\s*(?:Person|Room|Night)/i);
      if (match && match[1]) {
        qty = Number(match[1]) || 1;
      }

      return {
        ...r,
        sale_per_unit: qty > 0 ? saleSar / qty : saleSar,
        purchase_per_unit: qty > 0 && purchSar > 0 ? purchSar / qty : 0
      };
    });

    const totals = rows.reduce(
      (a, r) => {
        a.sale_pkr += Number(r.sale_pkr || 0);
        a.purchase_pkr += Number(r.purchase_pkr || 0);
        a.profit += Number(r.profit || 0);
        return a;
      },
      { sale_pkr: 0, purchase_pkr: 0, profit: 0 }
    );

    res.json({ success: true, rows, totals });

  } catch (err) {
    console.error("PURCHASE DETAIL ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

     


/* =====================================================
   PENDING + PARTIAL PURCHASE
===================================================== */
router.get("/pending", async (req, res) => {
  try {

    const result = await db.query(`
      SELECT *
      FROM (

        SELECT
          ref_no,
          customer_name,
          booking_date AS created_at,
          purchase_status
        FROM bookings
        WHERE is_deleted = false
          AND purchase_status IN ('PENDING','PARTIAL')

        UNION ALL

        SELECT
          ref_no,
          customer_name,
          booking_date AS created_at,
          purchase_status
        FROM hotels
        WHERE is_deleted = false
          AND purchase_status IN ('PENDING','PARTIAL')

        UNION ALL

        SELECT
          ref_no,
          customer_name,
          booking_date AS created_at,
          purchase_status
        FROM visa
        WHERE is_deleted = false
          AND purchase_status IN ('PENDING','PARTIAL')

        UNION ALL

        SELECT
          ref_no,
          customer_name,
          booking_date AS created_at,
          purchase_status
        FROM card
        WHERE is_deleted = false
          AND purchase_status IN ('PENDING','PARTIAL')

        UNION ALL

        SELECT
          ref_no,
          customer_name,
          booking_date AS created_at,
          purchase_status
        FROM groups
        WHERE is_deleted = false
          AND purchase_status IN ('PENDING','PARTIAL')

        UNION ALL

        SELECT
          ref_no,
          customer_name,
          booking_date AS created_at,
          purchase_status
        FROM ticketing
        WHERE is_deleted = false
          AND purchase_status IN ('PENDING','PARTIAL')

        UNION ALL

        SELECT
          ref_no,
          customer_name,
          booking_date AS created_at,
          purchase_status
        FROM transport
        WHERE is_deleted = false
          AND purchase_status IN ('PENDING','PARTIAL')

        UNION ALL

        SELECT
          ref_no,
          customer_name,
          booking_date AS created_at,
          purchase_status
        FROM ziyarat
        WHERE is_deleted = false
          AND purchase_status IN ('PENDING','PARTIAL')

      ) x
      ORDER BY created_at DESC
    `);

    res.json({
      success: true,
      rows: result.rows
    });

  } catch (err) {
    console.error("PENDING PURCHASE ERROR:", err);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/* =====================================================
   PURCHASE ROWS WHERE SUPPLIER IS MISSING (ROW LEVEL)
===================================================== */
router.get("/missing-supplier", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        p.id,
        p.ref_no,
        p.item,
        p.supplier_name,
        p.supplier_code,
        (p.purchase_sar * p.purchase_rate) AS row_amount
      FROM purchase_entries p
      WHERE p.is_deleted = false
        AND p.purchase_sar > 0
        AND p.purchase_rate > 0
        AND (
          p.supplier_name IS NULL OR p.supplier_name = ''
          OR
          p.supplier_code IS NULL OR p.supplier_code = ''
        )
      ORDER BY p.ref_no
    `);

    /* ================= CUSTOMER NAME ================= */
    const customers = await db.query(`
      SELECT ref_no, MAX(customer_name) AS customer_name
      FROM (
        SELECT ref_no, customer_name FROM bookings WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, customer_name FROM hotels WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, customer_name FROM visa WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, customer_name FROM card WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, customer_name FROM groups WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, customer_name FROM ticketing WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, customer_name FROM transport WHERE is_deleted=false
        UNION ALL
        SELECT ref_no, customer_name FROM ziyarat WHERE is_deleted=false
      ) x
      GROUP BY ref_no
    `);

    const customerMap = {};
    customers.rows.forEach(r => {
      customerMap[r.ref_no] = r.customer_name;
    });

    const rows = result.rows.map(r => ({
      id: r.id,
      ref_no: r.ref_no,
      item: r.item || "-",
      customer_name: customerMap[r.ref_no] || "",
      supplier_name: r.supplier_name,
      supplier_code: r.supplier_code,
      row_amount: r.row_amount || 0,
      status: "COMPLETE",
      note: "Supplier missing in this row"
    }));

    res.json({ success: true, rows });

  } catch (err) {
    console.error("MISSING SUPPLIER ROW ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// server/routes/purchase.js
router.get("/check/:ref_no", async (req, res) => {
  const { ref_no } = req.params;
  const q = await db.query(
    `SELECT COUNT(*) AS total
     FROM purchase_entries
     WHERE ref_no=$1 AND is_deleted=false`,
    [ref_no]
  );
  res.json({ total: Number(q.rows[0].total) });
});

// DELETED VIEW
router.get("/detail-deleted/:ref_no", async (req, res) => {
  try {
    const { ref_no } = req.params;

    const q = await db.query(
      `
      SELECT *
      FROM purchase_entries
      WHERE ref_no=$1 AND is_deleted=true
      ORDER BY item
      `,
      [ref_no]
    );

    if (!q.rows.length) {
      return res.json({ success: false, error: "No deleted purchase found" });
    }

    const totals = q.rows.reduce(
      (a, r) => {
        a.sale_pkr += Number(r.sale_pkr || 0);
        a.purchase_pkr += Number(r.purchase_pkr || 0);
        a.profit += Number(r.profit || 0);
        return a;
      },
      { sale_pkr: 0, purchase_pkr: 0, profit: 0 }
    );

    res.json({ success: true, rows: q.rows, totals });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});





module.exports = router;
