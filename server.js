const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = process.env.PORT || 3000;
const DB_DIR = process.env.DB_DIR || "/data";

fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(
  path.join(DB_DIR, "apex.db")
);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

app.use(express.json());

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

app.listen(
  PORT,
  () => {

    console.log(
      `APEX Training Lab Booking running on port ${PORT}`
    );

  }
);
