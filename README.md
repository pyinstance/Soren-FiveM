# Soren FiveM v3.1.3

Minimal black-and-white FiveM pack management with optional Discord-linked Soren accounts and VPS cloud pack storage.

## Desktop features

- Local ZIP / RAR / 7Z pack library
- Drag & Drop
- Blood FX / Graphics / GTA Sounds routing
- Safe Soren-managed cleanup
- Vanilla restore + Backup Manager
- Install Queue + better progress
- Archive corruption + missing-file checks
- Launch FiveM + verify paths
- Soren account login using Discord ID + generated key
- Discord OAuth identity verification
- Discord membership requirement
- Discord profile avatar in Account
- VPS Cloud packs with Upload / Move to cloud / Install from cloud
- Owner-only Discord user list with click-to-open account details

## VPS

The `server/` folder contains the Node.js + SQLite API used by v3 accounts and cloud storage.

See `SETUP_GUIDE.md` for the complete setup.


## v3.1.1 — Server Quick Launch

- New Servers tab with Trap RP and TMFRZ.
- Live online/player counts with automatic 30-second refresh.
- Current player names are shown when the Cfx status source provides them.
- Join launches the selected Cfx server directly through FiveM.
- Soren-branded full-screen launch overlay with stage-based progress.
- General Launch FiveM also uses the Soren launch overlay.
- The overlay tracks launch stages that Soren can actually observe and hands off once FiveM starts; a server's own in-game loadscreen is controlled by that server and is not modified.


## v3.1.3 — Compact Launch Overlay
- Replaced the full-screen launch overlay with a small centered window.
- Center-aligned the logo, server name, status and progress.
- Removed extra launch labels and decorative text for a cleaner minimal look.
