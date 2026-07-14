const express = require("express");
const router = express.Router();
const db = require("../db");


/* =====================================================
   GET SALE TOTAL BY REF NO
===================================================== */
async function getSaleAmount(ref_no) {

  const sale = await db.query(
    `
    SELECT COALESCE(SUM(amount),0) AS total_sale
    FROM (

      SELECT total_pkr AS amount
      FROM bookings
      WHERE ref_no=$1
      AND is_deleted=false

      UNION ALL

      SELECT total_pkr
      FROM hotels
      WHERE ref_no=$1
      AND is_deleted=false

      UNION ALL

      SELECT total_pkr
      FROM visa
      WHERE ref_no=$1
      AND is_deleted=false

      UNION ALL

      SELECT total_pkr
      FROM card
      WHERE ref_no=$1
      AND is_deleted=false

      UNION ALL

      SELECT total_pkr
      FROM groups
      WHERE ref_no=$1
      AND is_deleted=false

      UNION ALL

      SELECT total_pkr
      FROM ticketing
      WHERE ref_no=$1
      AND is_deleted=false

      UNION ALL

      SELECT total_pkr
      FROM transport
      WHERE ref_no=$1
      AND is_deleted=false

      UNION ALL

      SELECT total_pkr
      FROM ziyarat
      WHERE ref_no=$1
      AND is_deleted=false

    ) x
    `,
    [ref_no]
  );


  return Number(
    sale.rows[0]?.total_sale || 0
  );

}




/* =====================================================
   UPDATE PAYMENT STATUS
===================================================== */
async function updatePaymentStatus(ref_no) {


  const totalSale = await getSaleAmount(ref_no);


  const paid = await db.query(
    `
    SELECT COALESCE(SUM(amount),0) AS paid
    FROM customer_payments
    WHERE ref_no=$1
    AND LOWER(COALESCE(type,''))!='adjustment'
    `,
    [ref_no]
  );


  const totalPaid =
    Number(paid.rows[0]?.paid || 0);



  let status="PENDING";


  if(totalSale<=0){

    status="PENDING";

  }
  else if(totalPaid<=0){

    status="PENDING";

  }
  else if(totalPaid < totalSale){

    status="PARTIAL";

  }
  else{

    status="COMPLETE";

  }



  let table=null;


  if(ref_no.startsWith("PKG-"))
      table="bookings";

  else if(ref_no.startsWith("HOT-"))
      table="hotels";

  else if(ref_no.startsWith("VISA-"))
      table="visa";

  else if(ref_no.startsWith("CARD-"))
      table="card";

  else if(ref_no.startsWith("GRP-"))
      table="groups";

  else if(ref_no.startsWith("TIC-"))
      table="ticketing";

  else if(ref_no.startsWith("TRN-"))
      table="transport";

  else if(ref_no.startsWith("ZIY-"))
      table="ziyarat";



  if(table){

    await db.query(
      `
      UPDATE ${table}
      SET payment_status=$1
      WHERE ref_no=$2
      `,
      [
        status,
        ref_no
      ]
    );

  }


  return status;

}





/* =====================================================
   CUSTOMER LEDGER DETAIL
===================================================== */
router.get("/:ref_no", async(req,res)=>{


try{


const {ref_no}=req.params;


let rows=[];


let balance=0;


let customerName="Customer";


let baseDate=new Date();



/* ================= CUSTOMER INFO ================= */


const customer = await db.query(
`
SELECT customer_name,booking_date
FROM (

SELECT customer_name,booking_date
FROM bookings
WHERE ref_no=$1
AND is_deleted=false


UNION ALL


SELECT customer_name,booking_date
FROM hotels
WHERE ref_no=$1
AND is_deleted=false


UNION ALL


SELECT customer_name,booking_date
FROM visa
WHERE ref_no=$1
AND is_deleted=false


UNION ALL


SELECT customer_name,booking_date
FROM card
WHERE ref_no=$1
AND is_deleted=false

UNION ALL


SELECT customer_name,booking_date
FROM groups
WHERE ref_no=$1
AND is_deleted=false


UNION ALL


SELECT customer_name,booking_date
FROM ticketing
WHERE ref_no=$1
AND is_deleted=false


UNION ALL


SELECT customer_name,booking_date
FROM transport
WHERE ref_no=$1
AND is_deleted=false


UNION ALL


SELECT customer_name,booking_date
FROM ziyarat
WHERE ref_no=$1
AND is_deleted=false


)x
LIMIT 1
`,
[ref_no]
);



if(customer.rows.length){

customerName =
customer.rows[0].customer_name;

baseDate =
customer.rows[0].booking_date;

}



/* ================= HEADER ================= */


rows.push({

id:"CUSTOMER",

date:baseDate,

description:
`Customer: ${customerName}`,

debit:0,

credit:0,

balance:0

});





/* ================= SALE ================= */


const totalSale =
Math.round(
await getSaleAmount(ref_no)
);



if(totalSale>0){


balance += totalSale;


rows.push({

id:"SALE",

date:baseDate,

description:"Sale Invoice",

debit:0,

credit:totalSale,

balance

});


}




/* ================= PAYMENTS ================= */


const payments = await db.query(
`
SELECT
id,
payment_date,
amount,
type,
payment_method

FROM customer_payments

WHERE ref_no=$1

ORDER BY payment_date,id
`,
[ref_no]
);



payments.rows.forEach(p=>{


const amount =
Math.round(
Number(p.amount||0)
);



balance -= amount;



rows.push({

id:p.id,

date:p.payment_date,

description:
p.type==="adjustment"
?
"Adjustment"
:
`Payment Received (${p.payment_method || ""})`,


debit:amount,

credit:0,

balance


});


});



res.json({

success:true,

customer:customerName,

rows

});



}catch(err){


console.error(
"CUSTOMER LEDGER ERROR:",
err
);


res.json({

success:false,

error:err.message

});


}


});
/* =====================================================
   PAYMENT PENDING / PARTIAL LIST
===================================================== */

router.get("/pending/list", async(req,res)=>{

try{


const result = await db.query(
`
SELECT *
FROM
(

SELECT
ref_no,
customer_name,
payment_status

FROM bookings

WHERE is_deleted=false
AND payment_status IN ('PENDING','PARTIAL')



UNION ALL


SELECT
ref_no,
customer_name,
payment_status

FROM hotels

WHERE is_deleted=false
AND payment_status IN ('PENDING','PARTIAL')



UNION ALL


SELECT
ref_no,
customer_name,
payment_status

FROM visa

WHERE is_deleted=false
AND payment_status IN ('PENDING','PARTIAL')



UNION ALL


SELECT
ref_no,
customer_name,
payment_status

FROM card

WHERE is_deleted=false
AND payment_status IN ('PENDING','PARTIAL')


UNION ALL


SELECT
ref_no,
customer_name,
payment_status

FROM groups

WHERE is_deleted=false
AND payment_status IN ('PENDING','PARTIAL')



UNION ALL


SELECT
ref_no,
customer_name,
payment_status

FROM ticketing

WHERE is_deleted=false
AND payment_status IN ('PENDING','PARTIAL')



UNION ALL


SELECT
ref_no,
customer_name,
payment_status

FROM transport

WHERE is_deleted=false
AND payment_status IN ('PENDING','PARTIAL')



UNION ALL


SELECT
ref_no,
customer_name,
payment_status

FROM ziyarat

WHERE is_deleted=false
AND payment_status IN ('PENDING','PARTIAL')


)x

ORDER BY ref_no DESC

`
);



res.json({

success:true,

rows:result.rows

});



}
catch(err){


res.json({

success:false,

error:err.message

});


}


});







/* =====================================================
   SAVE CUSTOMER PAYMENT
===================================================== */

router.post("/payment", async(req,res)=>{


const client = await db.connect();


try{


const {
ref_no,
amount,
payment_method,
type,
payment_date
}=req.body;



if(!ref_no)
return res.json({
success:false,
error:"Ref No required"
});



if(!amount || Number(amount)<=0)
return res.json({
success:false,
error:"Invalid amount"
});



if(!payment_date)
return res.json({
success:false,
error:"Date required"
});



await client.query("BEGIN");



await client.query(
`
INSERT INTO customer_payments
(
ref_no,
amount,
payment_method,
type,
payment_date
)

VALUES
($1,$2,$3,$4,$5)

`,
[
ref_no,
amount,
payment_method || "cash",
type || "payment",
payment_date
]
);



await client.query("COMMIT");



await updatePaymentStatus(ref_no);



res.json({

success:true,

message:"Payment saved"

});



}
catch(err){


await client.query("ROLLBACK");


res.json({

success:false,

error:err.message

});


}
finally{


client.release();


}


});







/* =====================================================
   DELETE CUSTOMER PAYMENT
===================================================== */
router.delete("/delete/:id", async (req, res) => {
  try {
    const { password } = req.body;

    // Database se direct check bina kisi hardcoded default ke
    const passCheck = await db.query("SELECT password_val FROM system_passwords WHERE key_name = $1", ['delete_customer_payment']);
    
    if (passCheck.rows.length === 0) {
      return res.json({ success: false, error: "System password not configured in database!" });
    }

    const dbPassword = passCheck.rows[0].password_val;

    if (password !== dbPassword) {
      return res.json({ success: false, error: "Wrong password" });
    }

    // Aapka baki delete ka transaction logic yahan aayega...
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


module.exports = router;