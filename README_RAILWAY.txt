APEX TRAINING LAB — COMPLETE GITHUB / RAILWAY PACKAGE

Πλήρες πακέτο:
- server.js
- package.json
- public/index.html
- public/admin.html
- public/assets/apex-logo.png
- public/assets/favicon.png
- .gitignore
- README_RAILWAY.txt

Λειτουργίες:
ΠΕΛΑΤΗΣ:
- Personal Training / Mini Group
- επιλογή διαθέσιμης ημερομηνίας/ώρας
- όνομα + τηλέφωνο
- σελίδα επιβεβαίωσης
- κανόνας 24 ωρών

ADMIN:
- δημιουργία ωρών
- Personal Training / Mini Group
- φίλτρα
- στατιστικά
- προβολή πελάτη/τηλεφώνου
- ακύρωση booking
- διαγραφή διαθέσιμης ώρας

RAILWAY:
1. Deploy από GitHub.
2. Environment Variable: ADMIN_PASSWORD = δικός σου ασφαλής κωδικός.
3. Volume με mount path: /data.
4. Το site είναι στο / και το admin στο /admin.html.

GITHUB:
Αποσυμπίεσε το ZIP και ανέβασε τα ΠΕΡΙΕΧΟΜΕΝΑ του φακέλου στο repository.


APEX PREMIUM INTEGRATION
- The Premium App now uses the SAME SQLite database: /data/apex.db.
- Existing bookings, booking_history and customers are preserved.
- Premium tables are additive (CREATE TABLE IF NOT EXISTS).
- Client app: /app/
- Premium admin: /admin-premium.html
- Existing booking admin: /admin.html

SESSION USAGE RULE
- Past active booking inside the subscription period = 1 used session.
- Cancellation 24+ hours before = 0 used sessions.
- Cancellation less than 24 hours before = 1 used session.
- A cancellation is evaluated using the cancellation history timestamp.
- The original booking row/history is never deleted by Premium.
- Workout completion in the app is a progress log and does not independently deduct a session.

RAILWAY VARIABLES
- ADMIN_PASSWORD = existing admin password
- SESSION_SECRET = a long random secret (required for production)
- NODE_ENV = production
- DB_DIR = /data (existing Persistent Volume)
