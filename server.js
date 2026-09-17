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
db.pragma("foreign_keys = ON");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));


/* =========================
   APEX SETTINGS
========================= */

const SERVICES = ["Personal Training", "Mini Group"];

/*
  ΠΡΩΤΟ ΡΑΝΤΕΒΟΥ: 10:00
  ΤΕΛΕΥΤΑΙΟ ΡΑΝΤΕΒΟΥ: 21:00
  Δηλαδή τελευταίο ραντεβού 21:00 - 22:00
*/
const START_HOUR = 10;
const END_HOUR = 21;

const DAYS_TO_GENERATE = 90;

/*
  Δευτέρα = 1
  Τετάρτη = 3
  Παρασκευή = 5

  16:00 έως 19:00 είναι κλειστά.
*/
const CLOSED_DAYS = [1, 3, 5];
const CLOSED_FROM = 16;
const CLOSED_TO = 19;


/* =========================
   DATABASE
========================= */

db.exec(`
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  service TEXT NOT NULL
    CHECK(service IN ('Personal Training','Mini Group')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_unique
ON slots(date, time, service);
`);


/*
  Η παλιά έκδοση είχε UNIQUE(slot_id),
  κάτι που δεν επιτρέπει 6 άτομα σε Mini Group.

  Ελέγχουμε αν υπάρχει παλιός πίνακας και
  δημιουργούμε σωστό πίνακα κρατήσεων.
*/

const bookingTable = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='bookings'"
  )
  .get();

if (!bookingTable) {

  db.exec(`
    CREATE TABLE bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(slot_id) REFERENCES slots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_slot
    ON bookings(slot_id);
  `);

} else {

  /*
    Ελέγχουμε αν ο παλιός πίνακας έχει UNIQUE(slot_id).
    Αν ναι, τον μετατρέπουμε.
  */

  const indexes = db
    .prepare("PRAGMA index_list(bookings)")
    .all();

  const hasUniqueSlotIndex = indexes.some(index => {

    if (!index.unique) return false;

    const columns = db
      .prepare(`PRAGMA index_info("${index.name}")`)
      .all();

    return (
      columns.length === 1 &&
      columns[0].name === "slot_id"
    );

  });

  if (hasUniqueSlotIndex) {

    db.exec(`
      ALTER TABLE bookings RENAME TO bookings_old;

      CREATE TABLE bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(slot_id) REFERENCES slots(id) ON DELETE CASCADE
      );

      INSERT INTO bookings
      (id, slot_id, name, phone, created_at)
      SELECT
        id,
        slot_id,
        name,
        phone,
        created_at
      FROM bookings_old;

      CREATE INDEX IF NOT EXISTS idx_bookings_slot
      ON bookings(slot_id);

      DROP TABLE bookings_old;
    `);

  } else {

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_bookings_slot
      ON bookings(slot_id);
    `);

  }

}


/* =========================
   AUTOMATIC SLOT CREATION
========================= */

function formatDate(date) {

  const year = date.getFullYear();

  const month = String(
    date.getMonth() + 1
  ).padStart(2, "0");

  const day = String(
    date.getDate()
  ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}


function formatTime(hour) {

  return `${String(hour).padStart(2, "0")}:00`;

}


/*
  ΕΛΕΓΧΟΣ ΚΛΕΙΣΤΩΝ ΩΡΩΝ

  Κυριακή:
  ΟΛΗ ΜΕΡΑ ΚΛΕΙΣΤΑ

  Σάββατο:
  ΜΟΝΟ 10:00, 11:00, 12:00, 13:00
  δηλαδή 10:00 - 14:00

  Δευτέρα / Τετάρτη / Παρασκευή:
  16:00, 17:00, 18:00, 19:00 ΚΛΕΙΣΤΑ
*/

function isClosed(date, hour) {

  const day = date.getDay();

  /*
    Κυριακή = 0
  */
  if (day === 0) {
    return true;
  }


  /*
    Σάββατο = 6

    Επιτρέπονται μόνο:
    10:00
    11:00
    12:00
    13:00
  */

  if (day === 6) {

    if (hour < 10 || hour > 13) {
      return true;
    }

  }


  /*
    Δευτέρα = 1
    Τετάρτη = 3
    Παρασκευή = 5

    Κλειστά 16:00 έως 19:00
  */

  if (
    CLOSED_DAYS.includes(day) &&
    hour >= CLOSED_FROM &&
    hour <= CLOSED_TO
  ) {

    return true;

  }


  return false;

}


function generateSlots(days = DAYS_TO_GENERATE) {

  const insert = db.prepare(`
    INSERT OR IGNORE INTO slots
    (date, time, service)
    VALUES (?, ?, ?)
  `);

  const transaction = db.transaction(() => {

    for (
      let dayOffset = 0;
      dayOffset < days;
      dayOffset++
    ) {

      const date = new Date();

      date.setHours(
        0,
        0,
        0,
        0
      );

      date.setDate(
        date.getDate() + dayOffset
      );

      const dateString =
        formatDate(date);


      /*
        Ώρες από 10:00 μέχρι 21:00
      */

      for (
        let hour = START_HOUR;
        hour <= END_HOUR;
        hour++
      ) {

        if (
          isClosed(date, hour)
        ) {
          continue;
        }

        const time =
          formatTime(hour);


        for (
          const service of SERVICES
        ) {

          insert.run(
            dateString,
            time,
            service
          );

        }

      }

    }

  });

  transaction();

}


/*
  Δημιουργούμε αυτόματα
  τις σωστές διαθέσιμες ώρες.
*/

generateSlots();


/*
  ΚΑΘΑΡΙΣΜΟΣ ΠΑΛΙΩΝ ΛΑΘΟΣ ΩΡΩΝ

  Διαγράφουμε μόνο ώρες που ΔΕΝ έχουν κράτηση.

  Διαγράφονται:

  - 08:00
  - 09:00
  - όλες οι Κυριακές
  - Σάββατο μετά τις 14:00
  - Δευτέρα/Τετάρτη/Παρασκευή
    16:00 έως 19:00

  Αν κάποια παλιά ώρα έχει ήδη κράτηση,
  ΔΕΝ διαγράφεται ώστε να μη χαθεί
  το υπάρχον ραντεβού.
*/

db.prepare(`
  DELETE FROM slots
  WHERE id NOT IN (
    SELECT slot_id
    FROM bookings
  )
  AND (
    time IN ('08:00', '09:00')

    OR strftime('%w', date) = '0'

    OR (
      strftime('%w', date) = '6'
      AND time NOT IN (
        '10:00',
        '11:00',
        '12:00',
        '13:00'
      )
    )

    OR (
      strftime('%w', date) IN ('1', '3', '5')
      AND time IN (
        '16:00',
        '17:00',
        '18:00',
        '19:00'
      )
    )
  )
`).run();


/* =========================
   ADMIN AUTHENTICATION
========================= */

function admin(req, res, next) {

  const expected =
    process.env.ADMIN_PASSWORD || "CHANGE_ME";

  const supplied =
    req.get("x-admin-password");

  if (
    !supplied ||
    supplied !== expected
  ) {

    return res.status(401).json({
      error:
        "Μη έγκυρος κωδικός διαχειριστή."
    });

  }

  next();

}


/* =========================
   HEALTH
========================= */

app.get("/health", (req, res) => {

  res.json({
    ok: true,
    service:
      "APEX Training Lab Booking"
  });

});


/* =========================
   PUBLIC SLOTS
========================= */

app.get("/api/slots", (req, res) => {

  const date =
    String(
      req.query.date || ""
    ).trim();

  const service =
    String(
      req.query.service || ""
    ).trim();


  if (
    !date ||
    !SERVICES.includes(service)
  ) {

    return res.json([]);

  }


  /*
    Για κάθε ώρα:

    Mini Group:
      εμφανίζεται μέχρι να φτάσει 6 άτομα.

    Personal:
      εμφανίζεται μόνο αν ΔΕΝ υπάρχει
      καμία κράτηση στην ίδια ώρα.
  */

  const rows = db
    .prepare(`
      SELECT
        s.id,
        s.date,
        s.time,
        s.service,
        COUNT(b.id) AS bookings
      FROM slots s
      LEFT JOIN bookings b
        ON b.slot_id = s.id
      WHERE s.date = ?
        AND s.service = ?
      GROUP BY s.id
      ORDER BY s.time
    `)
    .all(
      date,
      service
    );


  const available = [];


  for (const row of rows) {

    const totalBookingsSameTime =
      db
        .prepare(`
          SELECT COUNT(*) AS count
          FROM bookings b
          JOIN slots s
            ON s.id = b.slot_id
          WHERE s.date = ?
            AND s.time = ?
        `)
        .get(
          row.date,
          row.time
        ).count;


    /*
      PERSONAL TRAINING
    */

    if (
      service ===
      "Personal Training"
    ) {

      if (
        totalBookingsSameTime === 0
      ) {

        available.push({

          id: row.id,

          date: row.date,

          time: row.time,

          service:
            row.service,

          remaining: 1

        });

      }

    }


    /*
      MINI GROUP
    */

    if (
      service ===
      "Mini Group"
    ) {

      /*
        Αν υπάρχει Personal,
        η ώρα είναι κλειστή.

        Αν υπάρχουν 1-5 Mini Group,
        συνεχίζει να εμφανίζεται.
      */

      const personalBooking =
        db
          .prepare(`
            SELECT b.id
            FROM bookings b
            JOIN slots s
              ON s.id = b.slot_id
            WHERE s.date = ?
              AND s.time = ?
              AND s.service =
                'Personal Training'
            LIMIT 1
          `)
          .get(
            row.date,
            row.time
          );


      if (
        !personalBooking &&
        totalBookingsSameTime < 6
      ) {

        available.push({

          id: row.id,

          date: row.date,

          time: row.time,

          service:
            row.service,

          remaining:
            6 -
            totalBookingsSameTime

        });

      }

    }

  }


  res.json(available);

});


/* =========================
   CREATE BOOKING
========================= */

app.post("/api/book", (req, res) => {

  const slot_id =
    Number(
      req.body?.slot_id
    );

  const name =
    String(
      req.body?.name || ""
    ).trim();

  const phone =
    String(
      req.body?.phone || ""
    ).trim();


  if (
    !slot_id ||
    !name ||
    !phone
  ) {

    return res.status(400).json({
      error:
        "Συμπλήρωσε όλα τα πεδία."
    });

  }


  try {

    const transaction =
      db.transaction(() => {

        const slot =
          db
            .prepare(`
              SELECT
                id,
                date,
                time,
                service
              FROM slots
              WHERE id = ?
            `)
            .get(slot_id);


        if (!slot) {

          throw new Error(
            "Η ώρα δεν υπάρχει."
          );

        }


        const totalBookingsSameTime =
          db
            .prepare(`
              SELECT COUNT(*) AS count
              FROM bookings b
              JOIN slots s
                ON s.id = b.slot_id
              WHERE s.date = ?
                AND s.time = ?
            `)
            .get(
              slot.date,
              slot.time
            ).count;


        /* =========================
           PERSONAL TRAINING
        ========================= */

        if (
          slot.service ===
          "Personal Training"
        ) {

          if (
            totalBookingsSameTime > 0
          ) {

            throw new Error(
              "Η συγκεκριμένη ώρα έχει ήδη κλειστεί."
            );

          }

        }


        /* =========================
           MINI GROUP
        ========================= */

        if (
          slot.service ===
          "Mini Group"
        ) {

          const personalBooking =
            db
              .prepare(`
                SELECT b.id
                FROM bookings b
                JOIN slots s
                  ON s.id = b.slot_id
                WHERE s.date = ?
                  AND s.time = ?
                  AND s.service =
                    'Personal Training'
                LIMIT 1
              `)
              .get(
                slot.date,
                slot.time
              );


          if (personalBooking) {

            throw new Error(
              "Η συγκεκριμένη ώρα έχει κλειστεί για Personal Training."
            );

          }


          if (
            totalBookingsSameTime >= 6
          ) {

            throw new Error(
              "Το Mini Group έχει συμπληρώσει 6 άτομα."
            );

          }

        }


        const result =
          db
            .prepare(`
              INSERT INTO bookings
              (
                slot_id,
                name,
                phone
              )
              VALUES (?, ?, ?)
            `)
            .run(
              slot_id,
              name,
              phone
            );


        return {

          booking_id:
            result.lastInsertRowid,

          slot

        };

      });


    const result =
      transaction();


    res.json({

      ok: true,

      ...result

    });


  } catch (error) {

    res.status(409).json({

      error:
        error.message ||
        "Δεν ήταν δυνατή η κράτηση."

    });

  }

});


/* =========================
   ADMIN - ALL SLOTS
========================= */

app.get(
  "/api/admin/slots",
  admin,
  (req, res) => {

    const rows =
      db
        .prepare(`
          SELECT
            s.id,
            s.date,
            s.time,
            s.service,
            COUNT(b.id) AS booking_count
          FROM slots s
          LEFT JOIN bookings b
            ON b.slot_id = s.id
          GROUP BY s.id
          ORDER BY
            s.date,
            s.time,
            s.service
        `)
        .all();


    const result =
      rows.map(row => {

        const bookings =
          db
            .prepare(`
              SELECT
                b.id,
                b.name,
                b.phone,
                b.created_at
              FROM bookings b
              WHERE b.slot_id = ?
              ORDER BY b.created_at
            `)
            .all(row.id);


        const capacity =
          row.service ===
          "Mini Group"
            ? 6
            : 1;


        return {

          ...row,

          capacity,

          remaining:
            Math.max(
              capacity -
                bookings.length,
              0
            ),

          bookings

        };

      });


    res.json(result);

  }
);


/* =========================
   ADMIN - CREATE SLOT
========================= */

app.post(
  "/api/admin/slots",
  admin,
  (req, res) => {

    const date =
      String(
        req.body?.date || ""
      ).trim();

    const time =
      String(
        req.body?.time || ""
      ).trim();

    const service =
      String(
        req.body?.service || ""
      ).trim();


    if (
      !date ||
      !time ||
      !SERVICES.includes(service)
    ) {

      return res.status(400).json({

        error:
          "Συμπλήρωσε σωστά ημερομηνία, ώρα και υπηρεσία."

      });

    }


    try {

      const result =
        db
          .prepare(`
            INSERT INTO slots
            (
              date,
              time,
              service
            )
            VALUES (?, ?, ?)
          `)
          .run(
            date,
            time,
            service
          );


      res.json({

        ok: true,

        id:
          result.lastInsertRowid

      });


    } catch (error) {

      res.status(409).json({

        error:
          "Υπάρχει ήδη αυτή η ώρα για τη συγκεκριμένη υπηρεσία."

      });

    }

  }
);


/* =========================
   ADMIN - DELETE AVAILABLE SLOT
========================= */

app.delete(
  "/api/admin/slots/:id",
  admin,
  (req, res) => {

    const id =
      Number(req.params.id);


    const booking =
      db
        .prepare(`
          SELECT id
          FROM bookings
          WHERE slot_id = ?
          LIMIT 1
        `)
        .get(id);


    if (booking) {

      return res.status(409).json({

        error:
          "Η ώρα έχει ήδη κρατήσεις. Ακύρωσε πρώτα τα ραντεβού."

      });

    }


    db
      .prepare(`
        DELETE FROM slots
        WHERE id = ?
      `)
      .run(id);


    res.json({
      ok: true
    });

  }
);


/* =========================
   ADMIN - CANCEL BOOKING
========================= */

app.delete(
  "/api/admin/bookings/:id",
  admin,
  (req, res) => {

    const id =
      Number(req.params.id);


    db
      .prepare(`
        DELETE FROM bookings
        WHERE id = ?
      `)
      .run(id);


    res.json({
      ok: true
    });

  }
);


/* =========================
   FRONTEND
========================= */

app.use((req, res) => {

  if (
    req.method === "GET" &&
    !req.path.startsWith("/api/") &&
    req.path !== "/health"
  ) {

    return res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );

  }


  res.status(404).json({
    error: "Not found"
  });

});


/* =========================
   START SERVER
========================= */

app.listen(
  PORT,
  () => {

    console.log(
      `APEX Training Lab Booking running on port ${PORT}`
    );

  }
);
