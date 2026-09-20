# APEX Premium deployment

This version is based on the uploaded `apex-appointment-system-main` project.

It does NOT create a second database. It adds Premium tables to the existing `/data/apex.db` Persistent Volume.

Before deploying:
1. Keep the existing Railway volume mounted at `/data`.
2. Set `SESSION_SECRET` to a long random value.
3. Keep the existing `ADMIN_PASSWORD`.
4. Deploy the GitHub repository normally.
5. Open `/app/` for the client app.
6. Open `/admin-premium.html` for the Premium admin.

No destructive migration is included.
