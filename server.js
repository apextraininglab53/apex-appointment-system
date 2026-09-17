const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_DIR = process.env.DB_DIR || "/data";
fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, "apex.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  service TEXT NOT NULL CHECK(service IN ('Personal Training','Mini Group')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(slot_id) REFERENCES slots(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_unique ON slots(date,time,service);
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function admin(req,res,next){
  const expected=process.env.ADMIN_PASSWORD || "CHANGE_ME";
  const supplied=req.get("x-admin-password");
  if(!supplied || supplied!==expected) return res.status(401).json({error:"Μη έγκυρος κωδικός διαχειριστή."});
  next();
}

app.get("/health",(req,res)=>res.json({ok:true}));

// Public endpoint intentionally returns no customer information.
app.get("/api/slots",(req,res)=>{
  const rows=db.prepare(`
    SELECT s.id,s.date,s.time,s.service
    FROM slots s
    LEFT JOIN bookings b ON b.slot_id=s.id
    WHERE b.id IS NULL
    ORDER BY s.date,s.time
  `).all();
  res.json(rows);
});

app.post("/api/book",(req,res)=>{
  const {slot_id,name,phone}=req.body||{};
  if(!slot_id || !String(name||"").trim() || !String(phone||"").trim())
    return res.status(400).json({error:"Συμπλήρωσε όλα τα πεδία."});
  const tx=db.transaction(()=>{
    const slot=db.prepare("SELECT id,date,time,service FROM slots WHERE id=?").get(slot_id);
    if(!slot) throw new Error("Η ώρα δεν υπάρχει.");
    const existing=db.prepare("SELECT id FROM bookings WHERE slot_id=?").get(slot_id);
    if(existing) throw new Error("Η συγκεκριμένη ώρα έχει ήδη κλειστεί.");
    const result=db.prepare("INSERT INTO bookings(slot_id,name,phone) VALUES(?,?,?)")
      .run(slot_id,String(name).trim(),String(phone).trim());
    return {booking_id:result.lastInsertRowid,slot};
  });
  try{
    const result=tx();
    res.json({ok:true,...result});
  }catch(e){
    res.status(409).json({error:e.message||"Δεν ήταν δυνατή η κράτηση."});
  }
});

app.get("/api/admin/slots",admin,(req,res)=>{
  const rows=db.prepare(`
    SELECT s.id,s.date,s.time,s.service,b.id AS booking_id,b.name,b.phone,b.created_at AS booked_at
    FROM slots s LEFT JOIN bookings b ON b.slot_id=s.id
    ORDER BY s.date,s.time
  `).all();
  res.json(rows);
});

app.post("/api/admin/slots",admin,(req,res)=>{
  const {date,time,service}=req.body||{};
  if(!date||!time||!["Personal Training","Mini Group"].includes(service))
    return res.status(400).json({error:"Συμπλήρωσε σωστά ημερομηνία, ώρα και υπηρεσία."});
  try{
    const result=db.prepare("INSERT INTO slots(date,time,service) VALUES(?,?,?)").run(date,time,service);
    res.json({ok:true,id:result.lastInsertRowid});
  }catch(e){
    res.status(409).json({error:"Υπάρχει ήδη αυτή η ώρα για τη συγκεκριμένη υπηρεσία."});
  }
});

app.delete("/api/admin/slots/:id",admin,(req,res)=>{
  const id=Number(req.params.id);
  const booking=db.prepare("SELECT id FROM bookings WHERE slot_id=?").get(id);
  if(booking) return res.status(409).json({error:"Η ώρα είναι ήδη κλεισμένη. Ακύρωσε πρώτα το ραντεβού."});
  db.prepare("DELETE FROM slots WHERE id=?").run(id);
  res.json({ok:true});
});

app.delete("/api/admin/bookings/:id",admin,(req,res)=>{
  db.prepare("DELETE FROM bookings WHERE id=?").run(Number(req.params.id));
  res.json({ok:true});
});

app.use((req,res)=>{
  if(req.method==="GET" && !req.path.startsWith("/api/") && req.path!=="/health")
    return res.sendFile(path.join(__dirname,"public","index.html"));
  res.status(404).json({error:"Not found"});
});

app.listen(PORT,()=>console.log(`APEX booking server running on port ${PORT}`));
