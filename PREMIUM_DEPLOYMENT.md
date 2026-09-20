# APEX Premium deployment

This version is based on the uploaded `apex-appointment-system-main` project.

## Database safety
- Premium uses the SAME `/data/apex.db` Persistent Volume.
- Existing `bookings`, `booking_history`, and other booking tables are not deleted.
- Premium adds only `premium_*` tables.
- No DROP/TRUNCATE migration is included.

## URLs
- Client app: `/app/`
- Premium admin: `/admin-premium.html`
- Existing booking admin: `/admin.html`

## Premium Admin
Premium Admin now uses a server-side session after login.
The admin password is not sent on every subsequent request.
A compatibility header fallback remains for the existing booking admin.

## Session usage
- Completed/past active booking in the subscription period = 1 session.
- Cancellation 24+ hours before = 0 sessions.
- Cancellation less than 24 hours before = 1 session.
- Cancellation is evaluated from `booking_history.created_at`.
- The source booking rows are not modified by Premium.
- App workout completion is a progress log and does not independently deduct a subscription session.

## Railway variables
- `ADMIN_PASSWORD` = existing admin password
- `SESSION_SECRET` = long random secret
- `NODE_ENV` = `production`
- `DB_DIR` = `/data` (keep the existing Persistent Volume)
