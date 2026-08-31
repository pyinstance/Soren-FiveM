# Soren FiveM v1.8

Soren FiveM is a compact Electron + React desktop app for discovering, inspecting and installing FiveM/GTA packs from paired preview/download links.

## Catalogue format

Each `.txt` file is a category. Every two URLs form one pack, in order:

```txt
https://example.com/preview.mp4
https://example.com/pack.rar

https://example.com/preview2.png
https://example.com/pack2.zip
```

The parser also tolerates Discord URLs accidentally pasted together on one line.

## Soren FiveM v1.8

### v1.8 Windows distribution

- Keeps the compact 857×575 desktop window.
- Softer 7–10px corner radii without turning every control into a pill.
- Deep black and graphite surfaces with a restrained burgundy-red accent.
- Short 120–180ms page, modal, hover and press transitions.
- Pack previews remain the main visual cards; Settings, Installed and About stay mostly divider-based.
- Animations automatically collapse when Windows/browser reduced-motion is enabled.

- Default window now matches the supplied compact reference: **857×575**.
- Less boxed/card-heavy interface: flat navigation, simple category tabs, divider-based settings/history/about pages, and cleaner status icons.
- Pack previews remain the main visual tiles; only 12 packs are mounted per page and previews still lazy-load near the viewport.
- Working frameless Soren FiveM startup splash screen.
- New **About** tab with developer **@misty** and bug helpers **ChatGPT** and **e@sy**.
- About page includes version, platform/build type and release security information.
- Core release files are checked against an **Ed25519-signed SHA-256 integrity manifest** and shown with a build fingerprint.
- Windows publisher signature is reported separately when running a packaged Windows build. A valid Soren FiveM integrity manifest is not the same thing as a Windows code-signing certificate.

## Install routing

### Blood FX

- `.rpf` files → configured **FiveM mod folder**.
- Other blood-effect files → `<Citizen>/common/data/effects`.
- Relative effect structure is preserved.
- Soren FiveM calculates all destinations before copying anything. If files already exist, it shows a replacement confirmation. Choosing **No** cancels without modifying destination files; choosing **Yes** backs up and replaces them.

### Graphics Packs

- Soren FiveM locates the archive's `citizen` folder.
- Everything inside that folder is merged into the configured **Citizen folder**.

### Other categories

- Existing content-based routing remains in place for audio, mod and addon folders.

## Supported downloads

- ZIP
- RAR
- 7Z
- Direct RPF files

Downloaded archives are validated before inspection so expired or invalid CDN links produce a readable error instead of a raw archive failure.

## Run Soren FiveM

Double-click `INSTALL_AND_RUN.bat`, or run:

```bash
npm install
npm run dev
```

## Build the Windows installer

Double-click `BUILD_WINDOWS.bat`, or run:

```bash
npm install
npm run dist
```

The installer is created in `release/` and uses the Soren FiveM product name and icon.

## Release integrity

The included `security/integrity-manifest.json` contains SHA-256 hashes for Soren FiveM's bundled core files. It is signed with the v1.8 release key, and only the public verification key is included in this source ZIP. Soren FiveM verifies the signature and file hashes from the About tab.

If you change a signed core file yourself, the v1.8 check will correctly show the release as modified. Re-signing a custom build requires your own release-signing key.

## Discord CDN links

Some supplied Discord CDN URLs are signed and may expire. If Soren FiveM reports that a download is not a valid archive, replace that download URL in the catalogue text file with a fresh link and press Reload.


Minor theme retune: darker black-dominant backdrop with restrained burgundy accents.


## Building Windows EXE files

On a Windows PC with Node.js LTS installed, double-click `BUILD_EXE.bat`. It builds both:

- `release/Soren FiveM Setup 1.8.0.exe` — normal Windows installer (recommended for the website).
- `release/Soren FiveM 1.8.0.exe` — portable build that can run without installation.

You can also run `npm run dist:installer` or `npm run dist:portable` from a terminal.

The executable is not Microsoft code-signed unless you supply a Windows code-signing certificate. Windows SmartScreen may therefore show an Unknown Publisher warning even when Soren's internal release-integrity check passes.


## Live GitHub Discovery catalogue

Soren v1.8 checks the GitHub catalogue on launch, when Reload is pressed, and periodically while the app is open. The default source is configured in `catalog-source.json`:

- GitHub account: `pyinstance`
- Repository: `Soren-FiveM`
- Branch: `main`
- Folder: `catalog/`

The repository must be public for token-free catalogue syncing. If you use a different repository name, edit `catalog-source.json` before building/releasing the app.

Every `.txt` file in that folder becomes a Discovery category automatically. The first non-URL line is used as the category name; otherwise the filename is used. Entries remain pairs: preview/video URL first, download URL second.

Example `catalog/Weapon Animations.txt`:

```text
Weapon Animations

https://example.com/preview.mp4
https://example.com/pack.rar
```

Commit/push that file and users receive the category on their next refresh. No EXE rebuild is required for catalogue-only changes. Soren caches the last successful GitHub catalogue and falls back to the bundled local catalogue when offline.

## Windows symlink build error

`BUILD_EXE.bat` now requests Administrator permission automatically and clears Electron Builder's incomplete `winCodeSign` cache before packaging. This fixes the common `Cannot create symbolic link ... libcrypto.dylib / libssl.dylib` failure. If Windows still blocks symlinks, enable **Settings → System → For developers → Developer Mode** and rerun the builder.
