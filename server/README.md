# Soren Cloud Server

This folder is the VPS side of Soren FiveM v3.0.0.

It provides:

- Soren account key generation
- Discord OAuth account verification
- Discord-server membership checks
- Session/login handling
- Per-user VPS pack storage
- Owner-only user information API
- SQLite metadata database

Pack archives are stored as normal files under `STORAGE_DIR`; they are **not** stored as large blobs inside SQLite.

Use the root `SETUP_GUIDE.md` for the full installation steps.
