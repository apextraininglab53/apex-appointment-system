const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const session = require("express-session");
const helmet = require("helmet");

const app = express();

// Railway terminates HTTPS before forwarding the request to Node.
// Trust the proxy so express-session can correctly set secure cookies.
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const DB_DIR = process.env.DB_DIR || "/data";

fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(
  path.join(DB_DIR, "apex.db")
);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

app.use(express.json({ limit: "1mb" }));

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(session({
  secret: process.env.SESSION_SECRET || "CHANGE_THIS_SESSION_SECRET_IN_RAILWAY",
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);


/* =========================================================
   APEX SETTINGS
========================================================= */

const SERVICES = [
  "Personal Training",
  "Mini Group"
];

const START_HOUR = 10;
const END_HOUR = 21;

const DAYS_TO_GENERATE = 90;

// Δευτέρα = 1
// Τετάρτη = 3
// Παρασκευή = 5
const CLOSED_DAYS = [1, 3, 5];

const CLOSED_FROM = 16;
const CLOSED_TO = 19;


/* =========================================================
   DATABASE HELPERS
========================================================= */

function tableExists(name) {

  return !!db
    .prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type='table'
      AND name=?
      `
    )
    .get(name);
}


/* =========================================================
   SLOTS TABLE
========================================================= */

db.exec(`
  CREATE TABLE IF NOT EXISTS slots (

    id INTEGER PRIMARY KEY AUTOINCREMENT,

    date TEXT NOT NULL,

    time TEXT NOT NULL,

    service TEXT NOT NULL
      CHECK(
        service IN (
          'Personal Training',
          'Mini Group'
        )
      ),

    created_at TEXT NOT NULL
      DEFAULT CURRENT_TIMESTAMP
  );

  CREATE UNIQUE INDEX IF NOT EXISTS
  idx_slots_unique
  ON slots(
    date,
    time,
    service
  );
`);


/* =========================================================
   BOOKINGS TABLE
========================================================= */

if (!tableExists("bookings")) {

  db.exec(`
    CREATE TABLE bookings (

      id INTEGER PRIMARY KEY AUTOINCREMENT,

      slot_id INTEGER NOT NULL,

      name TEXT NOT NULL,

      phone TEXT NOT NULL,

      created_at TEXT NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY(slot_id)
        REFERENCES slots(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS
    idx_bookings_slot
    ON bookings(slot_id);
  `);

} else {

  const indexes =
    db
      .prepare(
        "PRAGMA index_list(bookings)"
      )
      .all();

  const hasUniqueSlotIndex =
    indexes.some(index => {

      if (!index.unique) {
        return false;
      }

      const columns =
        db
          .prepare(
            `PRAGMA index_info("${index.name}")`
          )
          .all();

      return (
        columns.length === 1 &&
        columns[0].name === "slot_id"
      );

    });

  if (hasUniqueSlotIndex) {

    db.exec(`
      ALTER TABLE bookings
      RENAME TO bookings_old;

      CREATE TABLE bookings (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        slot_id INTEGER NOT NULL,

        name TEXT NOT NULL,

        phone TEXT NOT NULL,

        created_at TEXT NOT NULL
          DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY(slot_id)
          REFERENCES slots(id)
          ON DELETE CASCADE
      );

      INSERT INTO bookings
        (
          id,
          slot_id,
          name,
          phone,
          created_at
        )

      SELECT
        id,
        slot_id,
        name,
        phone,
        created_at

      FROM bookings_old;

      CREATE INDEX IF NOT EXISTS
      idx_bookings_slot
      ON bookings(slot_id);

      DROP TABLE bookings_old;
    `);

  } else {

    db.exec(`
      CREATE INDEX IF NOT EXISTS
      idx_bookings_slot
      ON bookings(slot_id);
    `);

  }

}


/* =========================================================
   PERMANENT BOOKING HISTORY
========================================================= */

/*
  Αυτός ο πίνακας ΔΕΝ διαγράφεται.

  Κρατάει:

  BOOKED
  CANCELLED

  για πάντα.

  Έτσι, όταν ακυρώνουμε ένα ραντεβού,
  αφαιρείται από τα ενεργά ραντεβού,
  αλλά η ιστορία του παραμένει.
*/

db.exec(`
  CREATE TABLE IF NOT EXISTS booking_history (

    id INTEGER PRIMARY KEY AUTOINCREMENT,

    booking_id INTEGER,

    name TEXT NOT NULL,

    phone TEXT NOT NULL,

    date TEXT NOT NULL,

    time TEXT NOT NULL,

    service TEXT NOT NULL,

    action TEXT NOT NULL
      CHECK(
        action IN (
          'BOOKED',
          'CANCELLED'
        )
      ),

    created_at TEXT NOT NULL
      DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS
  idx_history_customer
  ON booking_history(
    name,
    phone
  );

  CREATE INDEX IF NOT EXISTS
  idx_history_date
  ON booking_history(date);

  CREATE INDEX IF NOT EXISTS
  idx_history_booking
  ON booking_history(booking_id);
`);


/* =========================================================
   BACKFILL OLD BOOKINGS
========================================================= */

const backfill =
  db.prepare(`
    INSERT INTO booking_history
    (
      booking_id,
      name,
      phone,
      date,
      time,
      service,
      action,
      created_at
    )

    SELECT
      b.id,
      b.name,
      b.phone,
      s.date,
      s.time,
      s.service,
      'BOOKED',
      b.created_at

    FROM bookings b

    JOIN slots s
      ON s.id = b.slot_id

    WHERE NOT EXISTS (

      SELECT 1

      FROM booking_history h

      WHERE h.booking_id = b.id

      AND h.action = 'BOOKED'
    )
  `);

backfill.run();


/* =========================================================
   DATE / TIME
========================================================= */

function formatDate(date) {

  const year =
    date.getFullYear();

  const month =
    String(
      date.getMonth() + 1
    ).padStart(2, "0");

  const day =
    String(
      date.getDate()
    ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}


function formatTime(hour) {

  return `${String(hour).padStart(2, "0")}:00`;
}


/* =========================================================
   ATHENS REAL TIME
========================================================= */

function getAthensNowParts() {

  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          "Europe/Athens",

        year: "numeric",

        month: "2-digit",

        day: "2-digit",

        hour: "2-digit",

        minute: "2-digit",

        hour12: false
      }
    ).formatToParts(
      new Date()
    );

  const result = {};

  for (const part of parts) {

    if (
      part.type !==
      "literal"
    ) {

      result[part.type] =
        part.value;

    }

  }

  return result;
}


function isSlotInPast(
  date,
  time
) {

  const now =
    getAthensNowParts();

  const currentDate =
    `${now.year}-${now.month}-${now.day}`;

  const currentTime =
    `${now.hour}:${now.minute}`;

  return (
    date < currentDate ||

    (
      date === currentDate &&
      time <= currentTime
    )
  );
}


/* =========================================================
   CUSTOMER NORMALIZATION
========================================================= */

function normalizeName(value) {

  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("el-GR");
}


function normalizePhone(value) {

  let digits =
    String(value || "")
      .replace(/\D/g, "");

  if (
    digits.startsWith("0030")
  ) {

    digits =
      digits.slice(2);

  }

  if (
    digits.startsWith("69") &&
    digits.length === 10
  ) {

    digits =
      "30" + digits;

  }

  return digits;
}


function sameCustomer(
  name1,
  phone1,
  name2,
  phone2
) {

  return (
    normalizeName(name1) ===
      normalizeName(name2)

    &&

    normalizePhone(phone1) ===
      normalizePhone(phone2)
  );
}


/* =========================================================
   OPENING HOURS
========================================================= */

function isClosed(
  date,
  hour
) {

  const day =
    date.getDay();

  // Κυριακή
  if (day === 0) {

    return true;

  }

  // Σάββατο
  // 10:00 - 14:00
  if (day === 6) {

    return (
      hour < 10 ||
      hour > 13
    );

  }

  // Δευτέρα / Τετάρτη / Παρασκευή
  // 16:00 - 20:00 κλειστά
  if (
    CLOSED_DAYS.includes(day)

    &&

    hour >= CLOSED_FROM

    &&

    hour <= CLOSED_TO
  ) {

    return true;

  }

  return false;
}


/* =========================================================
   AUTOMATIC SLOT GENERATION
========================================================= */

function generateSlots(
  days = DAYS_TO_GENERATE
) {

  const insert =
    db.prepare(`
      INSERT OR IGNORE INTO slots
      (
        date,
        time,
        service
      )
      VALUES (?, ?, ?)
    `);

  const transaction =
    db.transaction(() => {

      for (
        let offset = 0;
        offset < days;
        offset++
      ) {

        const date =
          new Date();

        date.setHours(
          0,
          0,
          0,
          0
        );

        date.setDate(
          date.getDate() +
          offset
        );

        const dateString =
          formatDate(date);

        for (
          let hour = START_HOUR;
          hour <= END_HOUR;
          hour++
        ) {

          if (
            isClosed(
              date,
              hour
            )
          ) {

            continue;

          }

          const time =
            formatTime(hour);

          for (
            const service
            of SERVICES
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

generateSlots();


/* =========================================================
   REMOVE WRONG OLD SLOTS
========================================================= */

db.prepare(`
  DELETE FROM slots

  WHERE id NOT IN (
    SELECT slot_id
    FROM bookings
  )

  AND (

    time IN (
      '08:00',
      '09:00'
    )

    OR

    strftime('%w', date) = '0'

    OR

    (
      strftime('%w', date) = '6'

      AND

      time NOT IN (
        '10:00',
        '11:00',
        '12:00',
        '13:00'
      )
    )

    OR

    (
      strftime('%w', date)
      IN ('1','3','5')

      AND

      time IN (
        '16:00',
        '17:00',
        '18:00',
        '19:00'
      )
    )

  )
`).run();


/* =========================================================
   ADMIN AUTH
========================================================= */

function admin(
  req,
  res,
  next
) {

  const expected =
    process.env.ADMIN_PASSWORD ||
    "CHANGE_ME";

  const supplied =
    req.get(
      "x-admin-password"
    );

  if (
    !supplied ||
    supplied !== expected
  ) {

    return res
      .status(401)
      .json({
        error:
          "Μη έγκυρος κωδικός διαχειριστή."
      });

  }

  next();
}


/* =========================================================
   COMMON BOOKING HELPERS
========================================================= */

function sameTimeCount(
  date,
  time
) {

  return db
    .prepare(`
      SELECT COUNT(*) AS count

      FROM bookings b

      JOIN slots s
        ON s.id = b.slot_id

      WHERE s.date = ?
      AND s.time = ?
    `)
    .get(
      date,
      time
    ).count;
}


function hasPersonalTraining(
  date,
  time
) {

  return !!db
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
      date,
      time
    );
}


function hasExistingCustomerBooking(
  name,
  phone
) {

  const wantedName =
    normalizeName(name);

  const wantedPhone =
    normalizePhone(phone);

  const rows =
    db
      .prepare(`
        SELECT
          name,
          phone

        FROM bookings
      `)
      .all();

  return rows.some(row =>

    normalizeName(row.name) ===
      wantedName

    &&

    normalizePhone(row.phone) ===
      wantedPhone

  );
}


/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  (req, res) => {

    res.json({
      ok: true,
      service:
        "APEX Training Lab Booking"
    });

  }
);


/* =========================================================
   PUBLIC AVAILABLE SLOTS
========================================================= */

app.get(
  "/api/slots",
  (req, res) => {

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
      !SERVICES.includes(
        service
      )
    ) {

      return res.json([]);

    }

    const rows =
      db
        .prepare(`
          SELECT

            s.id,

            s.date,

            s.time,

            s.service,

            COUNT(b.id)
              AS bookings

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

      if (
        isSlotInPast(
          row.date,
          row.time
        )
      ) {

        continue;

      }


      const count =
        sameTimeCount(
          row.date,
          row.time
        );


      /* PERSONAL TRAINING */

      if (
        service ===
        "Personal Training"
      ) {

        if (
          count === 0
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


      /* MINI GROUP */

      if (
        service ===
        "Mini Group"
      ) {

        const personal =
          hasPersonalTraining(
            row.date,
            row.time
          );

        if (
          !personal &&
          count < 6
        ) {

          available.push({

            id: row.id,

            date: row.date,

            time: row.time,

            service:
              row.service,

            remaining:
              6 - count

          });

        }

      }

    }


    res.json(
      available
    );

  }
);


/* =========================================================
   CREATE BOOKING
========================================================= */

app.post(
  "/api/book",
  (req, res) => {

    const slotId =
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
      !slotId ||
      !name ||
      !phone
    ) {

      return res
        .status(400)
        .json({
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
              .get(slotId);


          if (!slot) {

            throw new Error(
              "Η ώρα δεν υπάρχει."
            );

          }


          if (
            isSlotInPast(
              slot.date,
              slot.time
            )
          ) {

            throw new Error(
              "Η συγκεκριμένη ώρα έχει ήδη περάσει."
            );

          }


          /*
            Ο ίδιος πελάτης δεν μπορεί
            να έχει δεύτερο ενεργό ραντεβού.
          */

          if (
            hasExistingCustomerBooking(
              name,
              phone
            )
          ) {

            throw new Error(
              "Υπάρχει ήδη ενεργό ραντεβού με τα ίδια στοιχεία ονοματεπωνύμου και τηλεφώνου."
            );

          }


          const count =
            sameTimeCount(
              slot.date,
              slot.time
            );


          /* PERSONAL */

          if (
            slot.service ===
            "Personal Training"
          ) {

            if (
              count > 0
            ) {

              throw new Error(
                "Η συγκεκριμένη ώρα έχει ήδη κλειστεί."
              );

            }

          }


          /* MINI GROUP */

          if (
            slot.service ===
            "Mini Group"
          ) {

            if (
              hasPersonalTraining(
                slot.date,
                slot.time
              )
            ) {

              throw new Error(
                "Η συγκεκριμένη ώρα έχει κλειστεί για Personal Training."
              );

            }


            if (
              count >= 6
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
                slotId,
                name,
                phone
              );


          /*
            Αποθήκευση μόνιμου ιστορικού
            κράτησης.
          */

          db
            .prepare(`
              INSERT INTO booking_history
              (
                booking_id,
                name,
                phone,
                date,
                time,
                service,
                action
              )

              VALUES (
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                'BOOKED'
              )
            `)
            .run(
              result.lastInsertRowid,
              name,
              phone,
              slot.date,
              slot.time,
              slot.service
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

      res
        .status(409)
        .json({

          error:
            error.message ||
            "Δεν ήταν δυνατή η κράτηση."

        });

    }

  }
);


/* =========================================================
   ADMIN - UPCOMING SLOTS
========================================================= */

app.get(
  "/api/admin/slots",
  admin,
  (req, res) => {

    const now =
      getAthensNowParts();

    const currentDate =
      `${now.year}-${now.month}-${now.day}`;

    const currentTime =
      `${now.hour}:${now.minute}`;


    const rows =
      db
        .prepare(`
          SELECT

            s.id,

            s.date,

            s.time,

            s.service,

            COUNT(b.id)
              AS booking_count

          FROM slots s

          LEFT JOIN bookings b
            ON b.slot_id = s.id

          WHERE NOT (

            s.date < ?

            OR

            (
              s.date = ?

              AND

              s.time <= ?
            )

          )

          GROUP BY s.id

          ORDER BY
            s.date,
            s.time,
            s.service
        `)
        .all(
          currentDate,
          currentDate,
          currentTime
        );


    const result =
      rows.map(row => {

        const bookings =
          db
            .prepare(`
              SELECT

                id,

                name,

                phone,

                created_at

              FROM bookings

              WHERE slot_id = ?

              ORDER BY created_at
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


    res.json(
      result
    );

  }
);


/* =========================================================
   ADMIN - CREATE SLOT
   Compatibility endpoint
========================================================= */

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
      !SERVICES.includes(
        service
      )
    ) {

      return res
        .status(400)
        .json({

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

      res
        .status(409)
        .json({

          error:
            "Υπάρχει ήδη αυτή η ώρα για τη συγκεκριμένη υπηρεσία."

        });

    }

  }
);


/* =========================================================
   ADMIN - DELETE AVAILABLE SLOT
========================================================= */

app.delete(
  "/api/admin/slots/:id",
  admin,
  (req, res) => {

    const id =
      Number(
        req.params.id
      );


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

      return res
        .status(409)
        .json({

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


/* =========================================================
   ADMIN - CANCEL BOOKING
========================================================= */

app.delete(
  "/api/admin/bookings/:id",
  admin,
  (req, res) => {

    const id =
      Number(
        req.params.id
      );


    /*
      Πρώτα βρίσκουμε
      τα στοιχεία της κράτησης.
    */

    const booking =
      db
        .prepare(`
          SELECT

            b.id,

            b.name,

            b.phone,

            s.date,

            s.time,

            s.service

          FROM bookings b

          JOIN slots s
            ON s.id = b.slot_id

          WHERE b.id = ?
        `)
        .get(id);


    if (!booking) {

      return res
        .status(404)
        .json({

          error:
            "Η κράτηση δεν βρέθηκε."

        });

    }


    /*
      ΣΗΜΑΝΤΙΚΟ:

      Δεν χάνουμε το ιστορικό.

      Πρώτα γράφουμε CANCELLED
      και μετά αφαιρούμε την ενεργή
      κράτηση.
    */

    const transaction =
      db.transaction(() => {

        db
          .prepare(`
            INSERT INTO booking_history
            (
              booking_id,
              name,
              phone,
              date,
              time,
              service,
              action
            )

            VALUES (
              ?,
              ?,
              ?,
              ?,
              ?,
              ?,
              'CANCELLED'
            )
          `)
          .run(
            booking.id,
            booking.name,
            booking.phone,
            booking.date,
            booking.time,
            booking.service
          );


        db
          .prepare(`
            DELETE FROM bookings

            WHERE id = ?
          `)
          .run(id);

      });


    transaction();


    res.json({

      ok: true,

      message:
        "Η κράτηση ακυρώθηκε και αποθηκεύτηκε στο ιστορικό."

    });

  }
);


/* =========================================================
   ADMIN - FULL HISTORY
========================================================= */

app.get(
  "/api/admin/history",
  admin,
  (req, res) => {

    const rows =
      db
        .prepare(`
          SELECT

            id,

            booking_id,

            name,

            phone,

            date,

            time,

            service,

            action,

            created_at

          FROM booking_history

          ORDER BY
            date DESC,
            time DESC,
            created_at DESC,
            id DESC
        `)
        .all();


    res.json(rows);

  }
);


/* =========================================================
   ADMIN - SUMMARY
========================================================= */

app.get(
  "/api/admin/summary",
  admin,
  (req, res) => {

    const now =
      getAthensNowParts();

    const today =
      `${now.year}-${now.month}-${now.day}`;


    const count =
      (sql, ...params) =>

        db
          .prepare(sql)
          .get(...params)
          .count;


    const todayBookings =
      count(
        `
        SELECT COUNT(*) count

        FROM bookings b

        JOIN slots s
          ON s.id = b.slot_id

        WHERE s.date = ?
        `,
        today
      );


    const todayMiniPeople =
      count(
        `
        SELECT COUNT(*) count

        FROM bookings b

        JOIN slots s
          ON s.id = b.slot_id

        WHERE s.date = ?

        AND s.service =
          'Mini Group'
        `,
        today
      );


    const todayPT =
      count(
        `
        SELECT COUNT(*) count

        FROM bookings b

        JOIN slots s
          ON s.id = b.slot_id

        WHERE s.date = ?

        AND s.service =
          'Personal Training'
        `,
        today
      );


    const totalBookings =
      count(`
        SELECT COUNT(*) count
        FROM bookings
      `);


    const totalMiniPeople =
      count(`
        SELECT COUNT(*) count

        FROM bookings b

        JOIN slots s
          ON s.id = b.slot_id

        WHERE s.service =
          'Mini Group'
      `);


    const totalCancellations =
      count(`
        SELECT COUNT(*) count

        FROM booking_history

        WHERE action =
          'CANCELLED'
      `);


    const uniqueCustomers =
      new Set(

        db
          .prepare(`
            SELECT
              name,
              phone

            FROM booking_history
          `)
          .all()

          .map(row =>
            normalizeName(
              row.name
            )

            +

            "|"

            +

            normalizePhone(
              row.phone
            )
          )

      ).size;


    const totalHistory =
      count(`
        SELECT COUNT(*) count
        FROM booking_history
      `);


    res.json({

      today,

      todayBookings,

      todayMiniPeople,

      todayPT,

      totalBookings,

      totalMiniPeople,

      uniqueCustomers,

      totalHistory,

      totalCancellations

    });

  }
);


/* =========================================================
   ADMIN - CUSTOMER PROFILE
========================================================= */

/*
  Επιστρέφει ΟΛΑ τα στοιχεία
  συγκεκριμένου πελάτη.

  Χρησιμοποιούμε όνομα + τηλέφωνο
  για να μην μπερδεύονται δύο άτομα
  με ίδιο όνομα.
*/

app.get(
  "/api/admin/customer",
  admin,
  (req, res) => {

    const name =
      String(
        req.query.name || ""
      ).trim();

    const phone =
      String(
        req.query.phone || ""
      ).trim();


    if (
      !name ||
      !phone
    ) {

      return res
        .status(400)
        .json({

          error:
            "Λείπουν στοιχεία πελάτη."

        });

    }


    const allHistory =
      db
        .prepare(`
          SELECT

            id,

            booking_id,

            name,

            phone,

            date,

            time,

            service,

            action,

            created_at

          FROM booking_history

          ORDER BY
            date DESC,
            time DESC,
            created_at DESC,
            id DESC
        `)
        .all()
        .filter(row =>
          sameCustomer(
            row.name,
            row.phone,
            name,
            phone
          )
        );


    const active =
      db
        .prepare(`
          SELECT

            b.id,

            b.name,

            b.phone,

            s.date,

            s.time,

            s.service,

            b.created_at

          FROM bookings b

          JOIN slots s
            ON s.id = b.slot_id

          ORDER BY
            s.date,
            s.time
        `)
        .all()
        .filter(row =>
          sameCustomer(
            row.name,
            row.phone,
            name,
            phone
          )
        );


    const customerName =
      allHistory.length
        ? allHistory[0].name
        : name;


    const customerPhone =
      allHistory.length
        ? allHistory[0].phone
        : phone;


    res.json({

      customer: {

        name:
          customerName,

        phone:
          customerPhone

      },

      active,

      history:
        allHistory

    });

  }
);



/* =========================================================
   APEX PREMIUM TRAINING APP
   Uses the SAME /data/apex.db Persistent Volume.
   Existing booking rows are NEVER deleted or modified here.
========================================================= */

db.exec(`
  CREATE TABLE IF NOT EXISTS premium_clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_customer_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    password_hash TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS premium_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES premium_clients(id),
    package_sessions INTEGER NOT NULL CHECK(package_sessions IN (8,12)),
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    sessions_used_override INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS premium_subscription_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER NOT NULL REFERENCES premium_subscriptions(id),
    event_type TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS premium_programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    days_per_week INTEGER NOT NULL CHECK(days_per_week IN (2,3)),
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS premium_program_exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    program_id INTEGER NOT NULL REFERENCES premium_programs(id),
    day_no INTEGER NOT NULL,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    sets TEXT,
    reps TEXT,
    target_weight TEXT,
    rest TEXT,
    tempo TEXT,
    notes TEXT,
    video_url TEXT,
    image_url TEXT
  );

  CREATE TABLE IF NOT EXISTS premium_client_programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES premium_clients(id),
    program_id INTEGER NOT NULL REFERENCES premium_programs(id),
    assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS premium_workouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES premium_clients(id),
    program_id INTEGER,
    day_no INTEGER,
    workout_date TEXT NOT NULL,
    booking_source_id INTEGER,
    completed INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS premium_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Safe schema migrations for existing /data/apex.db.
// These additions do NOT delete or overwrite existing bookings/customers.
function premiumEnsureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

premiumEnsureColumn("premium_clients", "booking_name", "TEXT");
premiumEnsureColumn("premium_clients", "deleted", "INTEGER NOT NULL DEFAULT 0");
premiumEnsureColumn("premium_clients", "manual_name", "INTEGER NOT NULL DEFAULT 0");

db.prepare("UPDATE premium_clients SET booking_name=name WHERE booking_name IS NULL OR booking_name='' ").run();

function premiumCustomerKey(name, phone) {
  return normalizeName(name) + "|" + normalizePhone(phone);
}

function premiumHashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function premiumVerifyPassword(password, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const parts = stored.split("$");
  if (parts.length !== 3) return false;
  const derived = crypto.scryptSync(String(password), parts[1], 64);
  const expected = Buffer.from(parts[2], "hex");
  return expected.length === derived.length && crypto.timingSafeEqual(derived, expected);
}

function premiumAthensLocalToMs(date, time) {
  const guess = Date.parse(`${date}T${time}:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Athens",
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit"
  });
  const parts = fmt.formatToParts(new Date(guess));
  const tz = parts.find(p => p.type === "timeZoneName")?.value || "GMT+2";
  const m = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  const offsetMinutes = m
    ? (Number(m[2]) * 60 + Number(m[3] || 0)) * (m[1] === "-" ? -1 : 1)
    : 120;
  return guess - offsetMinutes * 60000;
}

function premiumUtcSqlToMs(value) {
  if (!value) return NaN;
  const s = String(value);
  return Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)
      ? s.replace(" ", "T") + "Z"
      : s
  );
}

function premiumNowMs() {
  return Date.now();
}

/*
  Subscription usage rules:
  1) Active booking in the subscription period counts once its appointment has passed.
  2) A cancelled booking counts ONLY when cancellation happened less than 24 hours
     before the appointment.
  3) Cancellation 24+ hours before does not count.
  4) The original BOOKED history row is not counted separately from CANCELLED.
*/
function premiumBookingUsage(client, subscription) {
  if (!client || !subscription) return [];

  const key = client.booking_customer_key;
  const now = premiumNowMs();
  const start = subscription.start_date;
  const end = subscription.end_date;

  const active = db.prepare(`
    SELECT
      b.id AS booking_id,
      b.name,
      b.phone,
      s.date,
      s.time,
      s.service,
      b.created_at
    FROM bookings b
    JOIN slots s ON s.id = b.slot_id
    WHERE s.date BETWEEN ? AND ?
      AND lower(trim(b.name)) = lower(trim(?))
      AND b.phone = ?
    ORDER BY s.date, s.time
  `).all(start, end, client.name, client.phone);

  const cancelled = db.prepare(`
    SELECT
      booking_id,
      name,
      phone,
      date,
      time,
      service,
      created_at AS cancelled_at
    FROM booking_history
    WHERE action = 'CANCELLED'
      AND date BETWEEN ? AND ?
      AND lower(trim(name)) = lower(trim(?))
      AND phone = ?
    ORDER BY date, time
  `).all(start, end, client.name, client.phone);

  const result = [];

  for (const b of active) {
    const appointmentMs = premiumAthensLocalToMs(b.date, b.time);
    if (appointmentMs <= now) {
      result.push({
        source: "BOOKING",
        booking_id: b.booking_id,
        date: b.date,
        time: b.time,
        service: b.service,
        status: "COMPLETED_BOOKING",
        counted: true,
        reason: "Το ραντεβού πέρασε και δεν ακυρώθηκε."
      });
    }
  }

  for (const c of cancelled) {
    const appointmentMs = premiumAthensLocalToMs(c.date, c.time);
    const cancelledMs = premiumUtcSqlToMs(c.cancelled_at);
    const hoursBefore = (appointmentMs - cancelledMs) / 3600000;
    const counted = Number.isFinite(hoursBefore) && hoursBefore < 24;
    result.push({
      source: "BOOKING_HISTORY",
      booking_id: c.booking_id,
      date: c.date,
      time: c.time,
      service: c.service,
      status: "CANCELLED",
      counted,
      cancellation_hours_before: Number.isFinite(hoursBefore) ? Number(hoursBefore.toFixed(2)) : null,
      reason: counted
        ? "Ακύρωση λιγότερο από 24 ώρες πριν — χρεώνεται."
        : "Ακύρωση 24+ ώρες πριν — δεν χρεώνεται."
    });
  }

  return result.sort((a,b) => (`${b.date} ${b.time}`).localeCompare(`${a.date} ${a.time}`));
}

function premiumSubscription(clientId) {
  return db.prepare(`
    SELECT * FROM premium_subscriptions
    WHERE client_id = ? AND active = 1
    ORDER BY id DESC LIMIT 1
  `).get(clientId);
}

function premiumUsage(clientId) {
  const client = db.prepare("SELECT * FROM premium_clients WHERE id=?").get(clientId);
  const sub = premiumSubscription(clientId);
  if (!client || !sub) return { used: 0, remaining: 0, rows: [] };

  if (sub.sessions_used_override !== null && sub.sessions_used_override !== undefined) {
    const used = Math.max(0, Number(sub.sessions_used_override));
    return {
      used,
      remaining: Math.max(0, sub.package_sessions - used),
      rows: premiumBookingUsage(client, sub),
      overridden: true
    };
  }

  const rows = premiumBookingUsage(client, sub);
  const used = rows.filter(r => r.counted).length;
  return {
    used,
    remaining: Math.max(0, sub.package_sessions - used),
    rows,
    overridden: false
  };
}

function premiumState(clientId) {
  const client = db.prepare("SELECT * FROM premium_clients WHERE id=?").get(clientId);
  const sub = premiumSubscription(clientId);
  if (!client || client.deleted) return { active: false, reason: client?.deleted ? "DELETED" : "NO_CLIENT" };
  if (!sub) return { active: false, reason: "NO_SUBSCRIPTION" };
  const usage = premiumUsage(clientId);
  const today = getAthensNowParts();
  const todayString = `${today.year}-${today.month}-${today.day}`;

  if (!client.active) return { active: false, reason: "DISABLED", remaining: usage.remaining, subscription: sub };
  if (todayString < sub.start_date) return { active: false, reason: "NOT_STARTED", remaining: usage.remaining, subscription: sub };
  if (todayString > sub.end_date) return { active: false, reason: "EXPIRED", remaining: usage.remaining, subscription: sub };
  if (usage.remaining <= 0) return { active: false, reason: "SESSIONS_EXHAUSTED", remaining: 0, subscription: sub };

  return { active: true, reason: "ACTIVE", remaining: usage.remaining, subscription: sub };
}

function premiumAdmin(req, res, next) {
  const expected = process.env.ADMIN_PASSWORD || "CHANGE_ME";
  const headerPassword = req.get("x-admin-password");

  // Premium Admin uses a server-side session after login.
  // Header fallback keeps compatibility with the existing booking admin.
  if (req.session?.premiumAdmin === true) return next();
  if (headerPassword && headerPassword === expected) return next();

  return res.status(401).json({
    error: "Μη έγκυρος κωδικός διαχειριστή."
  });
}

app.post("/api/premium/admin/login", (req, res) => {
  const expected = process.env.ADMIN_PASSWORD || "CHANGE_ME";
  const supplied = String(req.body?.password || "");

  if (!supplied || supplied !== expected) {
    return res.status(401).json({
      error: "Μη έγκυρος κωδικός διαχειριστή."
    });
  }

  req.session.premiumAdmin = true;
  req.session.premiumRole = "admin";
  res.json({ ok: true });
});

app.post("/api/premium/admin/logout", (req, res) => {
  delete req.session.premiumAdmin;
  delete req.session.premiumRole;
  res.json({ ok: true });
});

function premiumClientAuth(req, res, next) {
  if (!req.session?.premiumClientId) {
    return res.status(401).json({ error: "Login required" });
  }

  const client = db.prepare(
    "SELECT * FROM premium_clients WHERE id=? AND deleted=0"
  ).get(Number(req.session.premiumClientId));

  if (!client) {
    delete req.session.premiumClientId;
    delete req.session.premiumRole;
    return res.status(401).json({ error: "Ο λογαριασμός δεν είναι διαθέσιμος." });
  }

  req.premiumClient = client;
  req.premiumState = premiumState(client.id);
  next();
}

function premiumActiveClientAuth(req, res, next) {
  premiumClientAuth(req, res, () => {
    if (!req.premiumState?.active) {
      return res.status(403).json({
        error: "Η συνδρομή δεν είναι ενεργή.",
        reason: req.premiumState?.reason || "INACTIVE"
      });
    }
    next();
  });
}

function premiumSyncCustomers() {
  const rows = db.prepare(`
    SELECT name, phone FROM booking_history
    UNION
    SELECT b.name, b.phone FROM bookings b
  `).all();

  const findExact = db.prepare(`
    SELECT id FROM premium_clients WHERE booking_customer_key=? LIMIT 1
  `);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO premium_clients
    (booking_customer_key, booking_name, name, phone)
    VALUES (?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r.name || !r.phone) continue;
      const name = r.name.trim();
      const phone = r.phone.trim();
      const key = premiumCustomerKey(name, phone);

      // A manually renamed client keeps the original booking_customer_key,
      // so this does not create a second client on every sync.
      if (findExact.get(key)) continue;

      insert.run(key, name, name, phone);
    }
  });
  tx();
}

function premiumPublicClient(client) {
  return {
    id: client.id,
    name: client.name,
    phone: client.phone,
    email: client.email || null
  };
}

premiumSyncCustomers();

/* ----- Premium auth ----- */

app.post("/api/premium/auth/login", (req, res) => {
  const key = String(req.body?.phone || "").trim();
  const password = String(req.body?.password || "");
  if (!key || !password) return res.status(400).json({ error: "Συμπλήρωσε τηλέφωνο και κωδικό." });

  premiumSyncCustomers();

  const client = db.prepare(`
    SELECT * FROM premium_clients
    WHERE deleted=0 AND phone = ?
    LIMIT 1
  `).get(key);

  if (!client || !premiumVerifyPassword(password, client.password_hash)) {
    return res.status(401).json({ error: "Λάθος στοιχεία σύνδεσης." });
  }

  const state = premiumState(client.id);

  // Login is allowed even when the subscription is expired, exhausted,
  // not started, disabled, or missing. The client must be able to see
  // their own account and the exact reason the subscription is inactive.
  req.session.premiumClientId = client.id;
  req.session.premiumRole = "client";
  res.json({
    ok: true,
    client: { id: client.id, name: client.name, phone: client.phone, email: client.email },
    subscription: state
  });
});

app.post("/api/premium/auth/logout", (req, res) => {
  delete req.session.premiumClientId;
  delete req.session.premiumRole;
  res.json({ ok: true });
});

app.get("/api/premium/me", premiumClientAuth, (req, res) => {
  const client = db.prepare(
    "SELECT id,name,phone,email FROM premium_clients WHERE id=? AND deleted=0"
  ).get(req.premiumClient.id);
  if (!client) return res.status(404).json({ error: "Πελάτης δεν βρέθηκε." });

  const sub = premiumSubscription(client.id);
  const usage = sub ? premiumUsage(client.id) : { used:0, remaining:0, rows:[] };
  const state = premiumState(client.id);

  // Programs/workouts remain in the database for compatibility, but the
  // current client page may ignore them until APEX activates that feature.
  const assigned = db.prepare(`
    SELECT p.* FROM premium_client_programs cp
    JOIN premium_programs p ON p.id = cp.program_id
    WHERE cp.client_id=? AND cp.active=1
    ORDER BY cp.id DESC LIMIT 1
  `).get(client.id);

  const workouts = db.prepare(`
    SELECT * FROM premium_workouts
    WHERE client_id=? ORDER BY workout_date DESC LIMIT 50
  `).all(client.id);

  res.json({
    client,
    state,
    subscription: sub ? {...sub, used:usage.used, remaining:usage.remaining} : null,
    program: assigned || null,
    workouts
  });
});

app.get("/api/premium/my-bookings", premiumClientAuth, (req, res) => {
  const client = db.prepare("SELECT * FROM premium_clients WHERE id=?").get(req.session.premiumClientId);
  const sub = premiumSubscription(client.id);
  res.json(premiumBookingUsage(client, sub));
});

app.post("/api/premium/workouts/complete", premiumActiveClientAuth, (req, res) => {
  const { program_id, day_no, workout_date, booking_source_id } = req.body || {};
  const info = db.prepare(`
    INSERT INTO premium_workouts
    (client_id, program_id, day_no, workout_date, booking_source_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.session.premiumClientId, program_id || null, day_no || null, workout_date || `${getAthensNowParts().year}-${getAthensNowParts().month}-${getAthensNowParts().day}`, booking_source_id || null);

  // IMPORTANT: subscription usage is NOT deducted here.
  // Booking attendance/cancellation rules are authoritative and prevent double counting.
  res.json({ ok: true, workout_id: info.lastInsertRowid });
});

/* ----- Premium admin ----- */

app.get("/api/premium/admin/dashboard", premiumAdmin, (req, res) => {
  premiumSyncCustomers();
  const clients = db.prepare("SELECT id FROM premium_clients WHERE active=1 AND deleted=0").all();

  let exact2 = 0, gt2 = 0, zero = 0, expired = 0, active = 0;
  for (const c of clients) {
    const state = premiumState(c.id);
    const sub = premiumSubscription(c.id);
    const rem = sub ? premiumUsage(c.id).remaining : 0;
    if (state.active) active++;
    if (rem === 2) exact2++;
    if (rem > 2) gt2++;
    if (rem === 0) zero++;
    if (state.reason === "EXPIRED") expired++;
  }

  res.json({ totalClients: clients.length, active, exact2, gt2, zero, expired });
});

app.get("/api/premium/admin/clients", premiumAdmin, (req, res) => {
  premiumSyncCustomers();
  const q = String(req.query.q || "").trim();
  const rows = q
    ? db.prepare(`
        SELECT * FROM premium_clients
        WHERE deleted=0 AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)
        ORDER BY name
      `).all(`%${q}%`, `%${q}%`, `%${q}%`)
    : db.prepare("SELECT * FROM premium_clients WHERE deleted=0 ORDER BY name").all();

  const duplicateCounts = new Map();
  for (const c of rows) {
    const key = normalizeName(c.name) + "|" + normalizePhone(c.phone);
    duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1);
  }

  res.json(rows.map(c => {
    const sub = premiumSubscription(c.id);
    const usage = sub ? premiumUsage(c.id) : {used:0,remaining:0};
    const state = premiumState(c.id);
    return {
      id:c.id,name:c.name,phone:c.phone,email:c.email,active:c.active,
      duplicate: (duplicateCounts.get(normalizeName(c.name) + "|" + normalizePhone(c.phone)) || 0) > 1,
      subscription: sub ? {...sub,used:usage.used,remaining:usage.remaining} : null,
      state
    };
  }));
});

app.get("/api/premium/admin/clients/:id", premiumAdmin, (req, res) => {
  const id = Number(req.params.id);
  const client = db.prepare("SELECT * FROM premium_clients WHERE id=? AND deleted=0").get(id);
  if (!client) return res.status(404).json({error:"Πελάτης δεν βρέθηκε."});

  const sub = premiumSubscription(id);
  const usage = sub ? premiumUsage(id) : {used:0,remaining:0,rows:[]};
  const history = db.prepare("SELECT * FROM premium_subscriptions WHERE client_id=? ORDER BY id DESC").all(id);
  const program = db.prepare(`
    SELECT p.* FROM premium_client_programs cp
    JOIN premium_programs p ON p.id=cp.program_id
    WHERE cp.client_id=? AND cp.active=1
    ORDER BY cp.id DESC LIMIT 1
  `).get(id);

  const workouts = db.prepare("SELECT * FROM premium_workouts WHERE client_id=? ORDER BY workout_date DESC").all(id);

  res.json({
    client: {...client, password_hash: undefined},
    subscription: sub ? {...sub, used:usage.used, remaining:usage.remaining} : null,
    subscription_history: history,
    booking_history: usage.rows,
    program: program || null,
    workouts
  });
});

app.post("/api/premium/admin/clients", premiumAdmin, (req, res) => {
  const {name, phone, email, password} = req.body || {};
  if (!name || !phone) return res.status(400).json({error:"Όνομα και τηλέφωνο είναι υποχρεωτικά."});

  const key = premiumCustomerKey(name, phone);
  const existing = db.prepare("SELECT id FROM premium_clients WHERE booking_customer_key=? AND deleted=0").get(key);

  if (existing) {
    const hash = password ? premiumHashPassword(password) : undefined;
    if (hash) db.prepare("UPDATE premium_clients SET password_hash=?,email=COALESCE(?,email),active=1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(hash,email||null,existing.id);
    return res.json({ok:true,id:existing.id,existing:true});
  }

  const hash = password ? premiumHashPassword(password) : null;
  const info = db.prepare(`
    INSERT INTO premium_clients
    (booking_customer_key,booking_name,name,phone,email,password_hash)
    VALUES (?,?,?,?,?,?)
  `).run(key,name.trim(),name.trim(),phone.trim(),email||null,hash);

  db.prepare(`
    INSERT INTO premium_audit(admin_action,target_type,target_id,details)
    VALUES (?,?,?,?)
  `).run("CREATE_CLIENT","client",String(info.lastInsertRowid),JSON.stringify({name,phone}));

  res.json({ok:true,id:info.lastInsertRowid});
});

app.post("/api/premium/admin/clients/:id/password", premiumAdmin, (req,res) => {
  const id = Number(req.params.id);
  const password = String(req.body?.password || "");
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({error:"Μη έγκυρος πελάτης."});
  if (password.length < 6) return res.status(400).json({error:"Ο κωδικός πρέπει να έχει τουλάχιστον 6 χαρακτήρες."});

  const client = db.prepare("SELECT id,name FROM premium_clients WHERE id=? AND deleted=0").get(id);
  if (!client) return res.status(404).json({error:"Πελάτης δεν βρέθηκε."});

  db.prepare("UPDATE premium_clients SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(premiumHashPassword(password), id);

  const message = `Ο κωδικός του πελάτη ${client.name} άλλαξε επιτυχώς.`;
  db.prepare("INSERT INTO premium_audit(admin_action,target_type,target_id,details) VALUES(?,?,?,?)")
    .run("CHANGE_PASSWORD","client",String(id),JSON.stringify({message}));

  res.json({ok:true,message});
});

app.post("/api/premium/admin/clients/:id/rename", premiumAdmin, (req,res) => {
  const id = Number(req.params.id);
  const name = String(req.body?.name || "").trim().replace(/\s+/g, " ");
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({error:"Μη έγκυρος πελάτης."});
  if (name.length < 2) return res.status(400).json({error:"Βάλε σωστό ονοματεπώνυμο."});

  const client = db.prepare("SELECT id,name,phone,booking_name FROM premium_clients WHERE id=? AND deleted=0").get(id);
  if (!client) return res.status(404).json({error:"Πελάτης δεν βρέθηκε."});

  const duplicate = db.prepare(`
    SELECT id,name FROM premium_clients
    WHERE id<>? AND deleted=0 AND lower(trim(name))=lower(trim(?)) AND phone=?
    LIMIT 1
  `).get(id,name,client.phone);
  if (duplicate) {
    return res.status(409).json({
      error:`Υπάρχει ήδη πελάτης με το ίδιο όνομα και τηλέφωνο (ID ${duplicate.id}).`,
      duplicate_id:duplicate.id
    });
  }

  db.prepare("UPDATE premium_clients SET name=?,manual_name=1,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(name,id);

  db.prepare("INSERT INTO premium_audit(admin_action,target_type,target_id,details) VALUES(?,?,?,?)")
    .run("RENAME_CLIENT","client",String(id),JSON.stringify({from:client.name,to:name}));

  res.json({ok:true,message:`Το όνομα άλλαξε από «${client.name}» σε «${name}».`});
});

app.post("/api/premium/admin/clients/:id/delete", premiumAdmin, (req,res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({error:"Μη έγκυρος πελάτης."});

  const client = db.prepare("SELECT id,name,phone FROM premium_clients WHERE id=? AND deleted=0").get(id);
  if (!client) return res.status(404).json({error:"Πελάτης δεν βρέθηκε ή έχει ήδη διαγραφεί."});

  // Soft delete: bookings/history are preserved and the customer cannot be recreated by sync.
  db.prepare("UPDATE premium_clients SET deleted=1,active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
  db.prepare("INSERT INTO premium_audit(admin_action,target_type,target_id,details) VALUES(?,?,?,?)")
    .run("DELETE_CLIENT","client",String(id),JSON.stringify({name:client.name,phone:client.phone,soft_delete:true}));

  res.json({ok:true,message:`Ο πελάτης ${client.name} αφαιρέθηκε από τη λίστα.`});
});

app.post("/api/premium/admin/clients/:id/subscription", premiumAdmin, (req,res) => {
  const id = Number(req.params.id);
  const sessions = Number(req.body?.package_sessions);
  const start = String(req.body?.start_date || "");
  const end = String(req.body?.end_date || "");
  if (![8,12].includes(sessions) || !start || !end) return res.status(400).json({error:"Βάλε 8 ή 12 συνεδρίες και ημερομηνίες."});
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    return res.status(400).json({error:"Οι ημερομηνίες δεν είναι σωστές."});
  }
  const exists = db.prepare("SELECT id FROM premium_clients WHERE id=? AND deleted=0").get(id);
  if (!exists) return res.status(404).json({error:"Πελάτης δεν βρέθηκε."});

  db.prepare("UPDATE premium_subscriptions SET active=0 WHERE client_id=?").run(id);
  const info = db.prepare(`
    INSERT INTO premium_subscriptions(client_id,package_sessions,start_date,end_date)
    VALUES(?,?,?,?)
  `).run(id,sessions,start,end);

  db.prepare("INSERT INTO premium_subscription_events(subscription_id,event_type,details) VALUES(?,?,?)")
    .run(info.lastInsertRowid,"RENEWAL",JSON.stringify({sessions,start,end}));

  db.prepare("UPDATE premium_clients SET active=1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);

  db.prepare("INSERT INTO premium_audit(admin_action,target_type,target_id,details) VALUES(?,?,?,?)")
    .run("RENEW_SUBSCRIPTION","client",String(id),JSON.stringify({sessions,start,end}));

  res.json({ok:true});
});

app.post("/api/premium/admin/clients/:id/correct", premiumAdmin, (req,res) => {
  const id = Number(req.params.id);
  const sub = premiumSubscription(id);
  if (!sub) return res.status(404).json({error:"Δεν υπάρχει ενεργή συνδρομή."});

  const used = req.body?.sessions_used_override;
  const start = req.body?.start_date || null;
  const end = req.body?.end_date || null;
  if (used !== "" && used !== null && used !== undefined && (!Number.isFinite(Number(used)) || Number(used) < 0)) {
    return res.status(400).json({error:"Η χρήση συνεδριών δεν είναι σωστή."});
  }
  if (start && !/^\d{4}-\d{2}-\d{2}$/.test(String(start))) return res.status(400).json({error:"Λάθος ημερομηνία έναρξης."});
  if (end && !/^\d{4}-\d{2}-\d{2}$/.test(String(end))) return res.status(400).json({error:"Λάθος ημερομηνία λήξης."});
  if (start && end && String(start) > String(end)) return res.status(400).json({error:"Η έναρξη δεν μπορεί να είναι μετά τη λήξη."});

  db.prepare(`
    UPDATE premium_subscriptions
    SET sessions_used_override=?, start_date=COALESCE(?,start_date), end_date=COALESCE(?,end_date)
    WHERE id=?
  `).run(used === "" || used === null || used === undefined ? null : Number(used), start, end, sub.id);

  db.prepare("INSERT INTO premium_audit(admin_action,target_type,target_id,details) VALUES(?,?,?,?)")
    .run("CORRECT_SUBSCRIPTION","subscription",String(sub.id),JSON.stringify(req.body || {}));

  res.json({ok:true});
});

app.post("/api/premium/admin/clients/:id/disable", premiumAdmin, (req,res) => {
  db.prepare("UPDATE premium_clients SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(Number(req.params.id));
  db.prepare("INSERT INTO premium_audit(admin_action,target_type,target_id,details) VALUES(?,?,?,?)")
    .run("DISABLE_CLIENT","client",req.params.id,"Client disabled");
  res.json({ok:true});
});

app.post("/api/premium/admin/clients/:id/enable", premiumAdmin, (req,res) => {
  db.prepare("UPDATE premium_clients SET active=1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(Number(req.params.id));
  db.prepare("INSERT INTO premium_audit(admin_action,target_type,target_id,details) VALUES(?,?,?,?)")
    .run("ENABLE_CLIENT","client",req.params.id,"Client enabled");
  res.json({ok:true});
});

app.post("/api/premium/admin/clients/:id/reconcile", premiumAdmin, (req,res) => {
  const id = Number(req.params.id);
  const sub = premiumSubscription(id);
  if (!sub) return res.status(404).json({error:"Δεν υπάρχει ενεργή συνδρομή."});
  db.prepare("UPDATE premium_subscriptions SET sessions_used_override=NULL WHERE id=?").run(sub.id);
  const usage = premiumUsage(id);
  db.prepare("INSERT INTO premium_audit(admin_action,target_type,target_id,details) VALUES(?,?,?,?)")
    .run("RECONCILE_BOOKING_USAGE","client",String(id),JSON.stringify({used:usage.used,remaining:usage.remaining}));
  res.json({ok:true,used:usage.used,remaining:usage.remaining});
});

app.get("/api/premium/admin/audit", premiumAdmin, (req,res) => {
  res.json(db.prepare("SELECT * FROM premium_audit ORDER BY id DESC LIMIT 300").all());
});

/* ----- Program builder ----- */

app.get("/api/premium/admin/programs", premiumAdmin, (req,res) => {
  res.json(db.prepare("SELECT * FROM premium_programs WHERE active=1 ORDER BY name").all());
});

app.post("/api/premium/admin/programs", premiumAdmin, (req,res) => {
  const {name,days_per_week,description} = req.body || {};
  if (!name || ![2,3].includes(Number(days_per_week))) return res.status(400).json({error:"Όνομα και 2/3 ημέρες απαιτούνται."});
  const info = db.prepare("INSERT INTO premium_programs(name,days_per_week,description) VALUES(?,?,?)").run(name,Number(days_per_week),description||null);
  res.json({ok:true,id:info.lastInsertRowid});
});

app.post("/api/premium/admin/programs/:id/exercises", premiumAdmin, (req,res) => {
  const p = Number(req.params.id);
  const x = req.body || {};
  if (!x.name) return res.status(400).json({error:"Βάλε όνομα άσκησης."});
  const max = db.prepare("SELECT COALESCE(MAX(position),0) n FROM premium_program_exercises WHERE program_id=? AND day_no=?").get(p,Number(x.day_no||1)).n;
  const info = db.prepare(`
    INSERT INTO premium_program_exercises
    (program_id,day_no,position,name,sets,reps,target_weight,rest,tempo,notes,video_url,image_url)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(p,Number(x.day_no||1),max+1,x.name,x.sets||null,x.reps||null,x.target_weight||null,x.rest||null,x.tempo||null,x.notes||null,x.video_url||null,x.image_url||null);
  res.json({ok:true,id:info.lastInsertRowid});
});

app.get("/api/premium/admin/programs/:id", premiumAdmin, (req,res) => {
  const id=Number(req.params.id);
  const program=db.prepare("SELECT * FROM premium_programs WHERE id=?").get(id);
  if(!program) return res.status(404).json({error:"Πρόγραμμα δεν βρέθηκε."});
  const exercises=db.prepare("SELECT * FROM premium_program_exercises WHERE program_id=? ORDER BY day_no,position").all(id);
  res.json({program,exercises});
});

app.post("/api/premium/admin/clients/:id/program", premiumAdmin, (req,res) => {
  const clientId=Number(req.params.id), programId=Number(req.body?.program_id);
  if(!programId) return res.status(400).json({error:"Διάλεξε πρόγραμμα."});
  db.prepare("UPDATE premium_client_programs SET active=0 WHERE client_id=?").run(clientId);
  db.prepare("INSERT INTO premium_client_programs(client_id,program_id) VALUES(?,?)").run(clientId,programId);
  db.prepare("INSERT INTO premium_audit(admin_action,target_type,target_id,details) VALUES(?,?,?,?)")
    .run("ASSIGN_PROGRAM","client",String(clientId),JSON.stringify({programId}));
  res.json({ok:true});
});

/* ----- Premium pages ----- */

app.get("/admin-premium.html", (req,res) => {
  res.sendFile(path.join(__dirname,"public","admin-premium.html"));
});

app.get("/app", (req,res) => {
  res.sendFile(path.join(__dirname,"public","app","index.html"));
});

app.get("/app/", (req,res) => {
  res.sendFile(path.join(__dirname,"public","app","index.html"));
});


/* =========================================================
   FRONTEND
========================================================= */

app.use(
  (req, res) => {

    if (
      req.method === "GET"

      &&

      !req.path.startsWith(
        "/api/"
      )

      &&

      req.path !==
        "/health"
    ) {

      return res.sendFile(
        path.join(
          __dirname,
          "public",
          "index.html"
        )
      );

    }


    res
      .status(404)
      .json({
        error:
          "Not found"
      });

  }
);


/* =========================================================
   START
========================================================= */

process.on("uncaughtException", err => {
  console.error("APEX uncaughtException:", err);
});

process.on("unhandledRejection", err => {
  console.error("APEX unhandledRejection:", err);
});

app.listen(
  PORT,
  () => {

    console.log(
      `APEX Training Lab Booking running on port ${PORT}`
    );

  }
);
