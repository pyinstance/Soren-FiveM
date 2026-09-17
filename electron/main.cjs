const { app, BrowserWindow, ipcMain, dialog, shell, net, screen } = require('electron')
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { Worker } = require('worker_threads')
const { createAccountCloudService } = require('./account-cloud.cjs')

app.setName('Soren FiveM')

let mainWindow
let splashWindow
let serverLaunchWindow
let packsWatcher
let packsWatchTimer
let splashShownAt = 0
const preparedJobs = new Map()
let accountCloud

const routeLabels = {
  gtaAudio: 'GTA sound / audio',
  citizen: 'Citizen',
  fivemMod: 'FiveM mod',
  fivemAddon: 'FiveM addon'
}

const FEATURED_SERVERS = [
  { code: '4k644o', name: 'Trap RP', joinUrl: 'https://cfx.re/join/4k644o' },
  { code: 'pggaejy', name: 'TMFRZ', joinUrl: 'https://cfx.re/join/pggaejy' }
]
const serverStatusCache = new Map()


function applicationRoot() {
  return app.isPackaged ? app.getAppPath() : path.join(__dirname, '..')
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function getWindowsSignatureStatus() {
  if (process.platform !== 'win32' || !app.isPackaged) return app.isPackaged ? 'Not available' : 'Development run'
  return new Promise((resolve) => {
    const safePath = process.execPath.replace(/'/g, "''")
    const command = `(Get-AuthenticodeSignature -LiteralPath '${safePath}').Status.ToString()`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true })
    let output = ''
    child.stdout.on('data', (d) => { output += d.toString() })
    child.on('error', () => resolve('Unable to check'))
    child.on('close', () => resolve(output.trim() || 'Unknown'))
  })
}

async function verifyIntegrity() {
  const root = applicationRoot()
  const securityDir = path.join(root, 'security')
  const manifestPath = path.join(securityDir, 'integrity-manifest.json')
  const signaturePath = path.join(securityDir, 'integrity-manifest.sig')
  const publicKeyPath = path.join(securityDir, 'release-public-key.pem')

  try {
    const [manifestRaw, signature, publicKey] = await Promise.all([
      fsp.readFile(manifestPath),
      fsp.readFile(signaturePath),
      fsp.readFile(publicKeyPath, 'utf8')
    ])
    const signatureValid = crypto.verify(null, manifestRaw, publicKey, signature)
    const manifest = JSON.parse(manifestRaw.toString('utf8'))
    const modifiedFiles = []
    let checkedFiles = 0

    for (const entry of manifest.files || []) {
      const relative = String(entry.path || '').replace(/\\/g, '/')
      const target = path.resolve(root, relative)
      if (!target.startsWith(path.resolve(root) + path.sep)) {
        modifiedFiles.push(relative || '(invalid path)')
        continue
      }
      checkedFiles += 1
      try {
        const digest = await sha256File(target)
        if (digest.toLowerCase() !== String(entry.sha256 || '').toLowerCase()) modifiedFiles.push(relative)
      } catch {
        modifiedFiles.push(relative)
      }
    }

    const filesValid = modifiedFiles.length === 0
    const fingerprintRaw = crypto.createHash('sha256').update(signature).digest('hex').toUpperCase().slice(0, 24)
    const fingerprint = `SOR-${fingerprintRaw.match(/.{1,4}/g).join('-')}`
    const windowsSignature = await getWindowsSignatureStatus()
    let executableSha256 = null
    if (app.isPackaged) {
      try { executableSha256 = await sha256File(process.execPath) } catch {}
    }
    return {
      status: signatureValid && filesValid ? 'verified' : 'modified',
      signatureValid,
      filesValid,
      checkedFiles,
      modifiedFiles: modifiedFiles.slice(0, 20),
      fingerprint,
      manifestVersion: manifest.version || app.getVersion(),
      checkedAt: new Date().toISOString(),
      windowsSignature,
      executableSha256
    }
  } catch (error) {
    return {
      status: 'unavailable',
      signatureValid: false,
      filesValid: false,
      checkedFiles: 0,
      modifiedFiles: [],
      message: error.message,
      windowsSignature: await getWindowsSignatureStatus()
    }
  }
}

function getAppInfo() {
  const platformNames = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
  return {
    name: app.getName(),
    version: app.getVersion(),
    platform: platformNames[process.platform] || process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    executablePath: process.execPath,
    userDataPath: app.getPath('userData')
  }
}

function createSplashWindow() {
  splashShownAt = Date.now()
  splashWindow = new BrowserWindow({
    width: 316,
    height: 186,
    frame: false,
    resizable: false,
    movable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: true,
    center: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#050505',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  splashWindow.loadFile(path.join(__dirname, 'splash.html'))
  splashWindow.on('closed', () => { splashWindow = null })
}

function revealMainWindow() {
  const delay = Math.max(0, 900 - (Date.now() - splashShownAt))
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.center()
      mainWindow.show()
      mainWindow.focus()
    }
  }, delay)
}

function userDataFile(name) {
  return path.join(app.getPath('userData'), name)
}

function packsDir() {
  return path.join(app.getPath('documents'), 'Soren FiveM', 'Packs')
}

async function ensurePacksDir() {
  const dir = packsDir()
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

// Soren tracks which destination files it installed for certain pack "slots"
// (Blood FX, GTA Sounds, ...) so that installing a new pack of the same kind
// can remove the previous pack's files from the real FiveM/GTA folders first,
// instead of leaving old RPFs behind or blindly wiping everything in `mods`.
function installedManifestFile() {
  return path.join(app.getPath('documents'), 'Soren FiveM', 'Data', 'installed.json')
}

async function readInstalledManifest() {
  const manifest = await readJson(installedManifestFile(), { slots: {} })
  manifest.slots ||= {}
  return manifest
}

async function writeInstalledManifest(manifest) {
  await writeJson(installedManifestFile(), manifest)
}


function activeSetupFile() {
  return path.join(app.getPath('documents'), 'Soren FiveM', 'Data', 'active-setup.json')
}

function activeSlotForCategory(category) {
  const c = String(category || '').toLowerCase()
  if (c.includes('graphic')) return 'graphics'
  if (c.includes('blood')) return 'bloodfx'
  if (c.includes('gta sound') || c === 'sound fx') return 'gtasounds'
  return null
}

async function getActiveSetup() {
  const file = activeSetupFile()
  const hasSavedState = await exists(file)
  const saved = await readJson(file, { slots: {} })
  saved.slots ||= {}

  // Once Active Setup has been written, it is authoritative. This matters
  // after Restore Vanilla: an intentionally empty setup must not be rebuilt
  // from old install history.
  if (hasSavedState) return saved

  // Backfill older Soren installs once so the page is useful immediately
  // after updating from a pre-Active-Setup release.
  const manifest = await readInstalledManifest()
  for (const slot of ['bloodfx', 'gtasounds']) {
    const existing = manifest.slots?.[slot]
    if (!saved.slots[slot] && existing?.itemTitle) {
      saved.slots[slot] = {
        itemId: existing.itemId || null,
        title: existing.itemTitle,
        category: slot === 'bloodfx' ? 'Blood FX' : 'GTA Sounds',
        installedAt: existing.installedAt || null,
        routes: slot === 'bloodfx' ? ['fivemMod', 'citizen'] : ['gtaAudio']
      }
    }
  }
  if (!saved.slots.graphics) {
    const history = await readJson(userDataFile('history.json'), [])
    const graphics = history.find((entry) => String(entry.category || '').toLowerCase().includes('graphic'))
    if (graphics) {
      saved.slots.graphics = {
        itemId: graphics.itemId || null,
        title: graphics.title,
        category: graphics.category,
        installedAt: graphics.installedAt || null,
        routes: graphics.routes || ['citizen']
      }
    }
  }
  saved.updatedAt = Object.values(saved.slots).map((x) => x?.installedAt).filter(Boolean).sort().at(-1) || null
  await writeJson(file, saved)
  return saved
}

async function updateActiveSetup(item, routes, installedAt) {
  const slot = activeSlotForCategory(item?.category)
  if (!slot) return getActiveSetup()
  const state = await getActiveSetup()
  state.slots[slot] = {
    itemId: item.id || null,
    title: item.title || item.fileName || 'Pack',
    category: item.category || 'Pack',
    installedAt,
    routes: routes || []
  }
  state.updatedAt = installedAt
  await writeJson(activeSetupFile(), state)
  return state
}

function queueFile() {
  return userDataFile('install-queue.json')
}

async function getInstallQueue() {
  const queue = await readJson(queueFile(), [])
  const root = path.resolve(await ensurePacksDir()) + path.sep
  const valid = queue.filter((item) => {
    try {
      const source = path.resolve(String(item.localPath || ''))
      return source.startsWith(root) && fs.existsSync(source)
    } catch { return false }
  })
  if (valid.length !== queue.length) await writeJson(queueFile(), valid)
  return valid
}

async function addInstallQueueItem(item) {
  if (!item?.localPath) throw new Error('Only local Soren Packs can be added to the install queue.')
  const source = path.resolve(String(item.localPath))
  const root = path.resolve(await ensurePacksDir()) + path.sep
  if (!source.startsWith(root) || !await exists(source)) throw new Error('This pack is no longer in the Soren Packs folder.')
  const queue = await getInstallQueue()
  if (!queue.some((entry) => entry.id === item.id)) {
    queue.push({
      id: item.id,
      title: item.title,
      category: item.category,
      fileName: item.fileName,
      localPath: source,
      size: Number(item.size || 0),
      missingFiles: Array.isArray(item.missingFiles) ? item.missingFiles : [],
      scanError: item.scanError || null,
      addedAt: new Date().toISOString()
    })
    await writeJson(queueFile(), queue)
  }
  return queue
}

async function removeInstallQueueItem(itemId) {
  const queue = (await getInstallQueue()).filter((entry) => entry.id !== itemId)
  await writeJson(queueFile(), queue)
  return queue
}

async function clearInstallQueue() {
  await writeJson(queueFile(), [])
  return []
}

function normalizeTrackedPath(p) {
  const resolved = path.resolve(String(p))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function localPackId(filePath) {
  const stat = fs.statSync(filePath)
  return crypto.createHash('sha1').update(`${filePath}|${stat.size}|${stat.mtimeMs}`).digest('hex').slice(0, 14)
}

function archiveEntriesForDetection(files) {
  const actual = files.filter((f) => !f.folder)
  const hasCitizen = files.some((f) => f.folder && String(f.path).split('/').filter(Boolean).some((p) => p.toLowerCase() === 'citizen'))
    || actual.some((f) => String(f.path).split('/').filter(Boolean).some((p) => p.toLowerCase() === 'citizen'))
  const lowerNames = new Set(actual.map((f) => path.basename(String(f.path)).toLowerCase()))
  const hasResident = lowerNames.has('resident.rpf')
  const hasWeapons = lowerNames.has('weapons_player.rpf')
  const hasBloodFx = lowerNames.has('bloodfx.dat')
  const hasRpf = actual.some((f) => path.extname(String(f.path)).toLowerCase() === '.rpf')
  return { hasCitizen, hasResident, hasWeapons, hasBloodFx, hasRpf }
}


function missingRequiredFiles(files, category = '') {
  const detected = archiveEntriesForDetection(files)
  const c = String(category || '').toLowerCase()
  const missing = []
  const looksLikeGtaSounds = c.includes('gta sound') || detected.hasResident || detected.hasWeapons
  if (looksLikeGtaSounds) {
    if (!detected.hasResident) missing.push('RESIDENT.rpf')
    if (!detected.hasWeapons) missing.push('WEAPONS_PLAYER.rpf')
  }
  const looksLikeBloodFx = c.includes('blood') || detected.hasBloodFx
  if (looksLikeBloodFx) {
    if (!detected.hasBloodFx) missing.push('bloodfx.dat')
    if (!detected.hasRpf) missing.push('Blood FX .rpf file')
  }
  if (c.includes('graphic') && !detected.hasCitizen) missing.push('citizen folder')
  return [...new Set(missing)]
}

function startPacksWatcher() {
  if (packsWatcher) return
  const dir = packsDir()
  try {
    packsWatcher = fs.watch(dir, { persistent: false }, () => {
      clearTimeout(packsWatchTimer)
      packsWatchTimer = setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        mainWindow.webContents.send('packs:changed')
      }, 450)
  })
  } catch (error) {
    console.warn('Could not watch Soren Packs folder:', error.message)
  }
}

async function scanLocalPacks() {
  const dir = await ensurePacksDir()
  const names = (await fsp.readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && ['.zip', '.rar', '.7z'].includes(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))

  const items = []
  const errors = []
  for (const name of names) {
    const full = path.join(dir, name)
    try {
      const stat = await fsp.stat(full)
      const ext = path.extname(name).toLowerCase()
      let files
      if (ext === '.rar') {
        // Use the dedicated RAR reader for local RAR archives. This supports
        // inspecting the archive without extracting it first.
        try {
          const result = await runArchiveWorker('list', { archivePath: full })
          files = result.files || []
        } catch (rarError) {
          // Fall back to 7-Zip for RAR variants that node-unrar-js cannot read.
          const listing = await run7zip(['l', '-slt', full])
          files = parse7ZipList(listing, full)
          if (!files.length) throw rarError
        }
      } else {
        const listing = await run7zip(['l', '-slt', full])
        files = parse7ZipList(listing, full)
      }
      assertSafeArchiveEntries(files)
      const detected = archiveEntriesForDetection(files)
      let category = 'Other'
      let logic = 'No automatic pack type was detected. You can choose the install destination.'
      let suggested = null
      if (detected.hasBloodFx) {
        category = 'Blood FX'
        suggested = null
        logic = detected.hasRpf
          ? 'Detected bloodfx.dat + RPF → blood effects go to Citizen/common/data/effects and RPF files go to FiveM mods.'
          : 'Blood FX structure detected, but a required RPF file is missing.'
      } else if (detected.hasCitizen) {
        category = 'Graphics packs'
        suggested = 'citizen'
        logic = 'Detected a citizen folder → the existing Citizen folder is backed up, then replaced with the pack Citizen folder.'
      } else if (detected.hasResident || detected.hasWeapons) {
        category = 'GTA Sounds'
        suggested = 'gtaAudio'
        logic = detected.hasResident && detected.hasWeapons
          ? 'Detected RESIDENT.rpf + WEAPONS_PLAYER.rpf → installed into the detected GTA sound / audio folder.'
          : 'GTA Sounds structure detected, but one required RPF file is missing.'
      }
      const missingFiles = missingRequiredFiles(files, category)
      items.push({
        id: localPackId(full), title: name.replace(/\.(zip|rar|7z)$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || name,
        category, fileName: name, size: stat.size, localPath: full,
        previewType: 'none', routingHint: { detected, suggested, logic }, entryCount: files.filter((f) => !f.folder).length,
        missingFiles
      })
    } catch (error) {
      errors.push(`${name}: ${error.message}`)
      const stat = await fsp.stat(full).catch(() => ({ size: 0 }))
      items.push({ id: localPackId(full), title: name.replace(/\.(zip|rar|7z)$/i, ''), category: 'Other', fileName: name, size: stat.size, localPath: full, previewType: 'none', scanError: `Could not inspect this archive: ${error.message}` })
    }
  }
  const categories = ['Graphics packs', 'GTA Sounds', 'Blood FX', 'Other'].filter((c) => items.some((i) => i.category === c))
  return { categories, items, packsDir: dir, scannedAt: new Date().toISOString(), scanErrors: errors }
}

async function migrateLegacyUserData() {
  const current = app.getPath('userData')
  const appData = app.getPath('appData')
  const candidates = [
    path.join(appData, 'Etherium'),
    path.join(appData, 'FiveM Discovery'),
    path.join(appData, 'fivem-discovery'),
    path.join(appData, 'fivem-discovery-electron')
  ].filter((dir) => path.resolve(dir) !== path.resolve(current))

  const hasCurrentData = await exists(path.join(current, 'settings.json')) || await exists(path.join(current, 'catalog'))
  if (hasCurrentData) return

  for (const legacy of candidates) {
    if (!await exists(legacy)) continue
    await fsp.mkdir(current, { recursive: true })
    for (const name of ['settings.json', 'history.json']) {
      const source = path.join(legacy, name)
      const target = path.join(current, name)
      if (await exists(source) && !await exists(target)) await fsp.copyFile(source, target)
    }
    const sourceCatalog = path.join(legacy, 'catalog')
    const targetCatalog = path.join(current, 'catalog')
    if (await exists(sourceCatalog) && !await exists(targetCatalog)) {
      await fsp.cp(sourceCatalog, targetCatalog, { recursive: true })
    }
    break
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch { return fallback }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
}

function bundledCatalogDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'catalog') : path.join(__dirname, '..', 'catalog')
}

function userCatalogDir() {
  return path.join(app.getPath('userData'), 'catalog')
}

async function ensureCatalog() {
  const dst = userCatalogDir()
  await fsp.mkdir(dst, { recursive: true })
  const existing = await fsp.readdir(dst).catch(() => [])
  if (existing.some((n) => n.toLowerCase().endsWith('.txt'))) return
  const src = bundledCatalogDir()
  const files = await fsp.readdir(src).catch(() => [])
  for (const name of files.filter((n) => n.toLowerCase().endsWith('.txt'))) {
    await fsp.copyFile(path.join(src, name), path.join(dst, name))
  }
}

function urlsFromText(text) {
  const exploded = text.replace(/(?=https?:\/\/)/gi, '\n')
  return exploded
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/&+$/, ''))
    .filter((line) => /^https?:\/\//i.test(line))
}

function filenameFromUrl(value) {
  try {
    const u = new URL(value)
    const raw = decodeURIComponent(path.basename(u.pathname))
    return raw || 'download'
  } catch {
    return 'download'
  }
}

function titleFromUrl(value) {
  const file = filenameFromUrl(value)
  const withoutExt = file.replace(/\.(zip|rar|7z|rpf)$/i, '')
  const clean = withoutExt.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return clean || file
}

function mediaType(url) {
  const file = filenameFromUrl(url).toLowerCase()
  if (/\.(png|jpe?g|webp|gif)$/.test(file)) return 'image'
  if (/\.(mp4|webm|mov|m4v)$/.test(file)) return 'video'
  return 'other'
}

function idFor(category, downloadUrl, index) {
  return crypto.createHash('sha1').update(`${category}|${downloadUrl}|${index}`).digest('hex').slice(0, 14)
}

function parseCatalogFiles(files, metadata = {}) {
  const categories = []
  const items = []

  for (const file of files) {
    const fileName = file.name
    const text = file.text || ''
    const urls = urlsFromText(text)
    const heading = text.split(/\r?\n/).map((x) => x.trim()).find((x) => x && !/^https?:\/\//i.test(x))
    const category = (heading || path.basename(fileName, '.txt')).trim()
    categories.push(category)

    for (let i = 0; i + 1 < urls.length; i += 2) {
      const previewUrl = urls[i]
      const downloadUrl = urls[i + 1]
      items.push({
        id: idFor(category, downloadUrl, i / 2),
        category,
        previewUrl,
        previewType: mediaType(previewUrl),
        downloadUrl,
        fileName: filenameFromUrl(downloadUrl),
        title: titleFromUrl(downloadUrl)
      })
    }
  }

  return {
    categories: [...new Set(categories)],
    items,
    catalogDir: userCatalogDir(),
    ...metadata
  }
}

async function getLocalCatalog() {
  await ensureCatalog()
  const dir = userCatalogDir()
  const names = (await fsp.readdir(dir))
    .filter((n) => n.toLowerCase().endsWith('.txt'))
    .sort((a, b) => a.localeCompare(b))
  const files = await Promise.all(names.map(async (name) => ({ name, text: await fsp.readFile(path.join(dir, name), 'utf8') })))
  return parseCatalogFiles(files, {
    source: 'local',
    sourceLabel: 'Bundled / local fallback catalogue',
    refreshedAt: new Date().toISOString()
  })
}

async function getCatalogSourceConfig() {
  const configPath = path.join(applicationRoot(), 'catalog-source.json')
  const fallback = { provider: 'github', owner: 'pyinstance', repo: 'Soren-FiveM', branch: 'main', path: 'catalog', refreshMinutes: 10 }
  return readJson(configPath, fallback)
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await net.fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function getRemoteCatalog() {
  const config = await getCatalogSourceConfig()
  if (config.provider !== 'github') throw new Error('Unsupported remote catalogue provider')
  const owner = String(config.owner || '').trim()
  const repo = String(config.repo || '').trim()
  const branch = String(config.branch || 'main').trim()
  const catalogPath = String(config.path || 'catalog').replace(/^\/+|\/+$/g, '')
  if (!owner || !repo) throw new Error('GitHub catalogue owner/repository is not configured')

  const apiPath = catalogPath.split('/').map(encodeURIComponent).join('/')
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${apiPath}?ref=${encodeURIComponent(branch)}`
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': `Soren-FiveM/${app.getVersion()}`,
    'X-GitHub-Api-Version': '2022-11-28'
  }
  const response = await fetchWithTimeout(apiUrl, { headers })
  if (!response.ok) throw new Error(`GitHub catalogue returned HTTP ${response.status}`)
  const listing = await response.json()
  if (!Array.isArray(listing)) throw new Error('GitHub catalogue path is not a folder')

  const txtEntries = listing
    .filter((entry) => entry?.type === 'file' && String(entry.name || '').toLowerCase().endsWith('.txt') && entry.download_url)
    .sort((a, b) => a.name.localeCompare(b.name))
  if (!txtEntries.length) throw new Error('No .txt catalogue files were found on GitHub')

  const files = await Promise.all(txtEntries.map(async (entry) => {
    const fileResponse = await fetchWithTimeout(entry.download_url, { headers: { 'User-Agent': `Soren-FiveM/${app.getVersion()}` } })
    if (!fileResponse.ok) throw new Error(`Could not download ${entry.name} (HTTP ${fileResponse.status})`)
    return { name: entry.name, text: await fileResponse.text() }
  }))

  return parseCatalogFiles(files, {
    source: 'github',
    sourceLabel: `GitHub · ${owner}/${repo}/${catalogPath}`,
    repository: `${owner}/${repo}`,
    branch,
    remotePath: catalogPath,
    remoteUrl: `https://github.com/${owner}/${repo}/tree/${branch}/${catalogPath}`,
    refreshedAt: new Date().toISOString(),
    refreshMinutes: Number(config.refreshMinutes || 10)
  })
}

async function getHubCatalog() {
  const config = await getCreatorSourceConfig()
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Soren catalogue API URL is not configured')
  const response = await fetchWithTimeout(`${baseUrl}/catalog`, {
    headers: { 'Accept': 'application/json', 'User-Agent': `Soren-FiveM/${app.getVersion()}` }
  }, 9000)
  if (!response.ok) throw new Error(`Soren catalogue API returned HTTP ${response.status}`)
  const payload = await response.json()
  if (!Array.isArray(payload.categories) || !Array.isArray(payload.items)) throw new Error('Soren catalogue API returned invalid data')
  return { ...payload, source: 'soren-api', sourceLabel: payload.sourceLabel || 'Soren owner catalogue', refreshMinutes: Number(payload.refreshMinutes || config.refreshMinutes || 10) }
}

async function getCatalog() {
  let hubError = null
  try {
    const remote = await getHubCatalog()
    await writeJson(userDataFile('catalog-cache.json'), remote)
    return remote
  } catch (error) { hubError = error }

  // Compatibility fallback: older deployments can still use the GitHub catalogue.
  try {
    const github = await getRemoteCatalog()
    await writeJson(userDataFile('catalog-cache.json'), github)
    return { ...github, sourceLabel: `${github.sourceLabel} · fallback`, remoteError: hubError?.message }
  } catch (githubError) {
    const cached = await readJson(userDataFile('catalog-cache.json'), null)
    if (cached?.items?.length) {
      return { ...cached, source: 'cache', sourceLabel: `${cached.sourceLabel || 'Soren catalogue'} · cached`, remoteError: hubError?.message || githubError.message }
    }
    const local = await getLocalCatalog()
    return { ...local, remoteError: hubError?.message || githubError.message }
  }
}


async function getCreatorSourceConfig() {
  const configPath = path.join(applicationRoot(), 'creator-source.json')
  const fallback = { baseUrl: 'https://sorenm.xyz/api', refreshMinutes: 10 }
  return readJson(configPath, fallback)
}

async function creatorApiRequest(route) {
  const config = await getCreatorSourceConfig()
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Creator Hub URL is not configured')
  const response = await fetchWithTimeout(`${baseUrl}${route.startsWith('/') ? route : `/${route}`}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': `Soren-FiveM/${app.getVersion()}` }
  }, 9000)
  if (!response.ok) {
    let message = `Creator Hub returned HTTP ${response.status}`
    try { message = (await response.json())?.error || message } catch {}
    throw new Error(message)
  }
  return response.json()
}

async function getCreators() {
  try {
    const payload = await creatorApiRequest('/creators')
    const result = {
      creators: Array.isArray(payload.creators) ? payload.creators : [],
      categories: Array.isArray(payload.categories) ? payload.categories : [],
      updatedAt: payload.updatedAt || new Date().toISOString(),
      source: 'remote'
    }
    const cache = await readJson(userDataFile('creator-cache.json'), { profiles: {} })
    cache.creators = result
    cache.profiles ||= {}
    await writeJson(userDataFile('creator-cache.json'), cache)
    return result
  } catch (error) {
    const cache = await readJson(userDataFile('creator-cache.json'), null)
    if (cache?.creators?.creators) return { ...cache.creators, source: 'cache', error: error.message }
    throw error
  }
}

async function getCreatorProfile(slug) {
  const safeSlug = encodeURIComponent(String(slug || '').trim())
  if (!safeSlug) throw new Error('Creator profile is missing')
  try {
    const payload = await creatorApiRequest(`/creators/${safeSlug}`)
    const result = { creator: payload.creator, categories: payload.categories || [], source: 'remote' }
    const cache = await readJson(userDataFile('creator-cache.json'), { profiles: {} })
    cache.profiles ||= {}
    cache.profiles[String(slug)] = result
    await writeJson(userDataFile('creator-cache.json'), cache)
    return result
  } catch (error) {
    const cache = await readJson(userDataFile('creator-cache.json'), null)
    const saved = cache?.profiles?.[String(slug)]
    if (saved?.creator) return { ...saved, source: 'cache', error: error.message }
    throw error
  }
}

function autoDetectInstallPaths() {
  if (process.platform !== 'win32') return { gtaAudio: '', citizen: '', fivemMod: '', fivemAddon: '' }
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const fivemRoot = path.join(local, 'FiveM', 'FiveM.app')
  const citizen = path.join(fivemRoot, 'citizen')
  const fivemMod = path.join(fivemRoot, 'mods')
  const gtaAudioCandidates = [
    path.join(programFiles, 'Rockstar Games', 'Grand Theft Auto V Legacy', 'x64', 'audio', 'sfx'),
    path.join(programFilesX86, 'Rockstar Games', 'Grand Theft Auto V Legacy', 'x64', 'audio', 'sfx'),
    path.join(programFiles, 'Epic Games', 'GTAV', 'x64', 'audio', 'sfx'),
    path.join(programFilesX86, 'Epic Games', 'GTAV', 'x64', 'audio', 'sfx')
  ]
  const gtaAudio = gtaAudioCandidates.find((p) => fs.existsSync(p)) || gtaAudioCandidates[0]
  return { gtaAudio, citizen, fivemMod, fivemAddon: '' }
}

async function prepareReshadeFolders() {
  if (process.platform !== 'win32') throw new Error('ReShade folder setup is available on Windows only.')
  const settings = await getSettings()
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const configuredCitizen = settings.citizen && path.basename(settings.citizen).toLowerCase() === 'citizen'
    ? path.dirname(settings.citizen) : ''
  const fiveMRoot = configuredCitizen && fs.existsSync(path.join(configuredCitizen, 'CitizenFX.ini'))
    ? configuredCitizen : path.join(local, 'FiveM', 'FiveM.app')
  if (!fs.existsSync(fiveMRoot)) {
    return { plugins: { status: 'missing', path: path.join(fiveMRoot, 'plugins') }, gta: { status: 'missing', path: '' } }
  }

  const pluginsPath = path.join(fiveMRoot, 'plugins')
  const pluginsExisted = fs.existsSync(pluginsPath)
  if (pluginsExisted && !(await fsp.stat(pluginsPath)).isDirectory()) throw new Error(`FiveM plugins path is not a folder: ${pluginsPath}`)
  if (!pluginsExisted) await fsp.mkdir(pluginsPath)
  const markerName = 'Soren Config folder Created.txt'
  if (!pluginsExisted) await fsp.writeFile(path.join(pluginsPath, markerName), 'Soren Config folder Created\r\n', { flag: 'wx' })

  let gtaPath = ''
  try {
    const ini = await fsp.readFile(path.join(fiveMRoot, 'CitizenFX.ini'), 'utf8')
    const match = ini.match(/^\s*IVPath\s*=\s*(.+?)\s*$/im)
    if (match) gtaPath = match[1].trim().replace(/^"|"$/g, '')
  } catch { /* Report the GTA path as missing below. */ }
  const gtaFound = Boolean(gtaPath && fs.existsSync(path.join(gtaPath, 'GTA5.exe')))
  if (gtaFound) {
    try { await fsp.writeFile(path.join(gtaPath, markerName), 'Soren Config folder Created\r\n', { flag: 'wx' }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  return {
    plugins: { status: pluginsExisted ? 'found' : 'created', path: pluginsPath },
    gta: { status: gtaFound ? 'found' : 'missing', path: gtaPath }
  }
}

async function launchReshadeSetup() {
  const folders = await prepareReshadeFolders()
  if (folders.gta.status !== 'found') throw new Error('GTA V was not found. Check the IVPath in FiveM CitizenFX.ini.')
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the official ReShade setup',
    properties: ['openFile'],
    filters: [{ name: 'ReShade setup', extensions: ['exe'] }]
  })
  if (result.canceled || !result.filePaths[0]) return { launched: false }
  const setupPath = result.filePaths[0]
  if (!/^ReShade_Setup(?:_[\d.]+)?\.exe$/i.test(path.basename(setupPath))) {
    throw new Error('Choose the official ReShade_Setup executable downloaded from reshade.me.')
  }
  const gtaExe = path.join(folders.gta.path, 'GTA5.exe')
  const gtaDll = path.join(folders.gta.path, 'dxgi.dll')
  if (!await exists(gtaDll)) {
    await new Promise((resolve, reject) => {
      const child = spawn(setupPath, [gtaExe, '--api', 'dxgi', '--headless'], { windowsHide: true })
      let output = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('ReShade setup timed out after five minutes.')) }, 300000)
      child.stdout?.on('data', (data) => { output = (output + data.toString()).slice(-4000) })
      child.stderr?.on('data', (data) => { output = (output + data.toString()).slice(-4000) })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`ReShade setup failed (${code}). ${output.trim()}`))
      })
    })
  }
  if (!await exists(gtaDll)) throw new Error('ReShade setup finished without creating GTA V dxgi.dll.')

  const shaderRoot = path.join(folders.gta.path, 'reshade-shaders')
  const shaderDirs = ['Shaders', 'Textures']
  if (shaderDirs.some((name) => !fs.existsSync(path.join(shaderRoot, name)))) {
    await fsp.mkdir(shaderRoot, { recursive: true })
    const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'soren-reshade-'))
    try {
      const archive = path.join(temp, 'reshade-shaders.zip')
      await downloadTo('https://github.com/crosire/reshade-shaders/archive/refs/heads/slim.zip', archive, 'reshade-shaders')
      await testArchiveIntegrity(archive, path.basename(archive), 'archive')
      const extracted = path.join(temp, 'extracted')
      await run7zip(['x', '-y', `-o${extracted}`, archive])
      const source = path.join(extracted, 'reshade-shaders-slim')
      for (const name of shaderDirs) {
        const target = path.join(shaderRoot, name)
        if (!await exists(path.join(source, name))) throw new Error(`Official ReShade ${name} folder was missing from the download.`)
        if (!await exists(target)) await fsp.cp(path.join(source, name), target, { recursive: true })
      }
    } finally { await fsp.rm(temp, { recursive: true, force: true }).catch(() => {}) }
  }
  const finished = await finishReshadeInstall()
  return { launched: true, installed: true, ...finished }
}

function setReshadeSearchPaths(ini, gtaPath) {
  const lines = String(ini || '').split(/\r?\n/)
  const ending = String(ini || '').includes('\r\n') ? '\r\n' : '\n'
  const settings = {
    EffectSearchPaths: path.join(gtaPath, 'reshade-shaders', 'Shaders') + '\\**',
    TextureSearchPaths: path.join(gtaPath, 'reshade-shaders', 'Textures') + '\\**'
  }
  let generalStart = lines.findIndex((line) => /^\s*\[GENERAL\]\s*$/i.test(line))
  if (generalStart < 0) { lines.push('[GENERAL]'); generalStart = lines.length - 1 }
  let generalEnd = lines.findIndex((line, i) => i > generalStart && /^\s*\[[^\]]+\]\s*$/.test(line))
  if (generalEnd < 0) generalEnd = lines.length
  for (let i = generalEnd - 1; i > generalStart; i--) {
    if (/^\s*(EffectSearchPaths|TextureSearchPaths)\s*=/i.test(lines[i])) lines.splice(i, 1)
  }
  lines.splice(generalStart + 1, 0, ...Object.entries(settings).map(([key, value]) => `${key}=${value}`))
  return lines.join(ending).replace(/(?:\r?\n)*$/, ending)
}

async function finishReshadeInstall() {
  const folders = await prepareReshadeFolders()
  if (folders.gta.status !== 'found' || folders.plugins.status === 'missing') throw new Error('FiveM plugins or GTA V folder is missing.')
  const gta = folders.gta.path
  const plugins = folders.plugins.path
  const shaders = path.join(gta, 'reshade-shaders')
  const sourceDll = path.join(gta, 'dxgi.dll')
  if (!await exists(sourceDll)) throw new Error('ReShade dxgi.dll was not found in GTA V. Complete the official ReShade setup for GTA V first.')
  if (!await exists(path.join(shaders, 'Shaders')) || !await exists(path.join(shaders, 'Textures'))) {
    throw new Error('ReShade shader folders were not found in GTA V. Install effects in the official ReShade setup first.')
  }
  const dllHeader = Buffer.alloc(2)
  const handle = await fsp.open(sourceDll, 'r')
  try { await handle.read(dllHeader, 0, 2, 0) } finally { await handle.close() }
  if (dllHeader.toString('ascii') !== 'MZ') throw new Error('The GTA V dxgi.dll is not a valid Windows DLL.')

  const sourceIni = path.join(gta, 'ReShade.ini')
  const destDll = path.join(plugins, 'dxgi.dll')
  const destIni = path.join(plugins, 'ReShade.ini')
  const iniBase = await fsp.readFile(destIni, 'utf8').catch(async (error) => {
    if (error.code !== 'ENOENT') throw error
    return fsp.readFile(sourceIni, 'utf8').catch((e) => { if (e.code === 'ENOENT') return '[GENERAL]\n'; throw e })
  })
  const changed = [destDll, destIni]
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupRoot = path.join(backupsRoot(), `${stamp}-reshade`)
  await fsp.mkdir(backupRoot, { recursive: true })
  const index = {
    version: 1, id: path.basename(backupRoot), title: 'ReShade for FiveM', category: 'ReShade',
    createdAt: new Date().toISOString(), entries: [], installedTargets: []
  }
  for (const [i, target] of changed.entries()) {
    if (await exists(target)) {
      const backupRelative = path.join('reshade', `${i}-${path.basename(target)}`)
      const backupTarget = safeTarget(backupRoot, backupRelative)
      await fsp.mkdir(path.dirname(backupTarget), { recursive: true })
      await fsp.copyFile(target, backupTarget)
      index.entries.push({ originalPath: target, backupRelative, kind: 'file', reason: 'replaced' })
    }
  }
  try {
    await fsp.copyFile(sourceDll, destDll)
    await fsp.writeFile(destIni, setReshadeSearchPaths(iniBase, gta), 'utf8')
    if (await sha256File(sourceDll) !== await sha256File(destDll)) throw new Error('FiveM ReShade DLL did not match the GTA V source after copying.')
    const writtenIni = await fsp.readFile(destIni, 'utf8')
    if (!writtenIni.includes(`EffectSearchPaths=${path.join(gta, 'reshade-shaders', 'Shaders')}\\**`) ||
        !writtenIni.includes(`TextureSearchPaths=${path.join(gta, 'reshade-shaders', 'Textures')}\\**`)) {
      throw new Error('FiveM ReShade shader paths could not be verified.')
    }
    index.installedTargets = changed.map((target) => ({ path: target, kind: 'file' }))
    index.size = await directorySize(backupRoot)
    await writeJson(path.join(backupRoot, '_soren-backup.json'), index)
    await addHistory({ id: index.id, title: index.title, category: index.category, installedAt: index.createdAt, routes: ['FiveM plugins'], backupPath: backupRoot })
  } catch (error) {
    for (const target of changed) await fsp.rm(target, { force: true }).catch(() => {})
    for (const entry of index.entries) await fsp.copyFile(safeTarget(backupRoot, entry.backupRelative), entry.originalPath).catch(() => {})
    throw error
  }
  return { ok: true, plugins, gta, gtaDll: sourceDll, pluginDll: destDll, shaderRoot: shaders, backupId: index.id }
}

async function reshadeFiveMStatus() {
  const folders = await prepareReshadeFolders()
  if (folders.plugins.status === 'missing') return { state: 'missing', message: 'FiveM was not found.' }
  const root = path.dirname(folders.plugins.path)
  const iniPath = path.join(root, 'CitizenFX.ini')
  const ini = await fsp.readFile(iniPath, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error })
  const logDir = path.join(root, 'logs')
  const logs = (await fsp.readdir(logDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && /^CitizenFX_log_.*\.log$/i.test(entry.name))
    .map((entry) => entry.name).sort().reverse()
  for (const name of logs.slice(0, 12)) {
    const log = await fsp.readFile(path.join(logDir, name), 'utf8')
    const required = log.match(/ReShade5=ID:[0-9a-f]{8} acknowledged that ReShade 5\.x has a bug that will lead to game crashes/i)?.[0]
    if (!required) continue
    if (ini.split(/\r?\n/).some((line) => line.trim().toLowerCase() === required.toLowerCase())) {
      return { state: 'acknowledged', line: required, iniPath }
    }
    return { state: 'blocked', line: required, iniPath, logPath: path.join(logDir, name) }
  }
  return { state: 'unknown', message: 'Launch FiveM once, close it, then check again. Soren needs the acknowledgement line from its log.' }
}

async function acknowledgeReshadeForFiveM() {
  const status = await reshadeFiveMStatus()
  if (status.state === 'acknowledged') return status
  if (status.state !== 'blocked') throw new Error(status.message || 'FiveM did not provide a ReShade acknowledgement line.')
  const current = await fsp.readFile(status.iniPath, 'utf8')
  const ending = current.includes('\r\n') ? '\r\n' : '\n'
  const lines = current.split(/\r?\n/)
  const section = lines.findIndex((line) => /^\s*\[Addons\]\s*$/i.test(line))
  if (section < 0) lines.push('', '[Addons]', status.line)
  else {
    let end = lines.findIndex((line, i) => i > section && /^\s*\[[^\]]+\]\s*$/.test(line))
    if (end < 0) end = lines.length
    for (let i = end - 1; i > section; i--) {
      if (/^\s*ReShade5\s*=/i.test(lines[i])) lines.splice(i, 1)
    }
    lines.splice(section + 1, 0, status.line)
  }
  const backup = path.join(path.dirname(status.iniPath), 'CitizenFX.ini.soren-backup')
  try { await fsp.copyFile(status.iniPath, backup, fs.constants.COPYFILE_EXCL) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  await fsp.writeFile(status.iniPath, lines.join(ending), 'utf8')
  return { state: 'acknowledged', line: status.line, iniPath: status.iniPath, backup }
}

async function getSettings() {
  const saved = await readJson(userDataFile('settings.json'), {})
  const detected = autoDetectInstallPaths()
  const settings = { ...detected, ...saved }
  // Empty/invalid saved locations fall back to automatic detection.
  for (const key of Object.keys(detected)) {
    if (!settings[key] || (key !== 'fivemAddon' && !fs.existsSync(settings[key]))) settings[key] = detected[key]
  }
  await writeJson(userDataFile('settings.json'), settings)
  return settings
}

async function saveSettings(settings) {
  await writeJson(userDataFile('settings.json'), settings)
  return settings
}

function get7ZipPath() {
  if (app.isPackaged) {
    const exe = process.platform === 'win32' ? '7za.exe' : '7za'
    const platformDir = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
    const archDir = process.platform === 'win32' ? 'x64' : process.arch
    const candidates = [
      path.join(process.resourcesPath, '7zip-bin', platformDir, archDir, exe),
      path.join(process.resourcesPath, '7zip-bin', platformDir, exe)
    ]
    const found = candidates.find((p) => fs.existsSync(p))
    if (found) return found
  }
  return require('7zip-bin').path7za
}

function run7zip(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(get7ZipPath(), args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr || stdout || `7-Zip exited with ${code}`))
    })
  })
}

function runArchiveWorker(op, payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'archive-worker.cjs'), {
      workerData: { op, ...payload }
    })
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    worker.once('message', (message) => {
      if (message?.ok) finish(resolve, message.result)
      else finish(reject, new Error(message?.error || 'RAR worker failed'))
    })
    worker.once('error', (error) => finish(reject, error))
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(reject, new Error(`RAR worker exited with code ${code}`))
    })
  })
}

function parse7ZipList(output, archivePath) {
  const records = output.split(/\r?\n\r?\n/)
  const files = []
  for (const block of records) {
    const rec = {}
    for (const line of block.split(/\r?\n/)) {
      const idx = line.indexOf(' = ')
      if (idx > 0) rec[line.slice(0, idx)] = line.slice(idx + 3)
    }
    if (!rec.Path || rec.Path === archivePath) continue
    if (rec.Type || rec['Physical Size']) continue
    files.push({
      path: rec.Path.replace(/\\/g, '/'),
      folder: rec.Folder === '+',
      size: Number(rec.Size || 0)
    })
  }
  return files
}

function routeInfoForPath(filePath, category) {
  const originalParts = String(filePath || '').replace(/\\/g, '/').split('/').filter(Boolean)
  const parts = originalParts.map((p) => p.toLowerCase())
  const markerMap = {
    citizen: 'citizen',
    audio: 'gtaAudio',
    sfx: 'gtaAudio',
    mods: 'fivemMod',
    mod: 'fivemMod',
    addons: 'fivemAddon',
    addon: 'fivemAddon'
  }
  for (let i = 0; i < Math.max(0, parts.length - 1); i++) {
    const route = markerMap[parts[i]]
    if (route) {
      const remainder = originalParts.slice(i + 1)
      return { route, relative: remainder.length ? path.join(...remainder) : path.basename(String(filePath || 'file')) }
    }
  }
  const ext = path.extname(String(filePath || '')).toLowerCase()
  if (ext === '.rpf') return { route: 'fivemMod', relative: path.basename(String(filePath)) }
  const fallback = categoryFallback(category)
  if (fallback) return { route: fallback, relative: originalParts.length ? path.join(...originalParts) : path.basename(String(filePath || 'file')) }
  return null
}

function segmentRoute(filePath) {
  return routeInfoForPath(filePath, '')?.route || null
}

function categoryFallback(category) {
  const c = String(category || '').toLowerCase()
  if (c.includes('sound') || c.includes('audio') || c === 'pvp gs') return 'gtaAudio'
  if (c.includes('graphic') || c === 'pvp gp') return 'citizen'
  if (c.includes('tracer') || c.includes('blood') || c.includes('weapon skin')) return 'fivemMod'
  return null
}

function isCreatorBundle(item) {
  return String(item?.source || '').toLowerCase() === 'creator' || Boolean(item?.creator)
}

function assertSafeArchiveEntries(files) {
  let total = 0
  if (files.length > 20000) throw new Error('This archive contains too many entries to inspect safely.')
  for (const entry of files) {
    const name = String(entry.path || '').replace(/\\/g, '/')
    const parts = name.split('/').filter(Boolean)
    if (!name || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || parts.includes('..')) {
      throw new Error(`Unsafe archive path detected: ${name || '(empty)'}`)
    }
    if (!entry.folder) total += Number(entry.size || 0)
  }
  if (total > 8 * 1024 * 1024 * 1024) throw new Error('This archive expands beyond Soren’s safety limit.')
}

function isBloodFxCategory(category) {
  return String(category || '').toLowerCase().includes('blood')
}

function isGraphicsCategory(category) {
  const c = String(category || '').trim().toLowerCase()
  return c.includes('graphic') || c === 'pvp gp'
}

function isPvpGsCategory(category) {
  return String(category || '').trim().toLowerCase() === 'pvp gs'
}

function isGtaSoundCategory(category) {
  const c = String(category || '').trim().toLowerCase()
  return c === 'gta sounds' || c === 'sound fx' || c.includes('gta sound')
}

function detectRoutes(files, category, item = null) {
  if (isBloodFxCategory(category)) {
    const actualFiles = files.filter((f) => !f.folder)
    const hasRpf = actualFiles.some((f) => path.extname(f.path).toLowerCase() === '.rpf')
    const hasEffects = actualFiles.some((f) => path.extname(f.path).toLowerCase() !== '.rpf')
    const detected = []
    if (hasRpf) detected.push('fivemMod')
    if (hasEffects) detected.push('citizen')
    return {
      detected,
      suggested: detected.length === 1 ? detected[0] : null,
      confidence: 'category-logic',
      needsManual: false,
      logic: 'Blood FX: .rpf files → FiveM mods; effect files → Citizen/common/data/effects'
    }
  }

  if (isGtaSoundCategory(category)) {
    return {
      detected: ['gtaAudio'],
      suggested: 'gtaAudio',
      confidence: 'category-logic',
      needsManual: false,
      logic: 'GTA Sounds: RESIDENT.rpf + WEAPONS_PLAYER.rpf → configured GTA sound / audio folder'
    }
  }

  if (isGraphicsCategory(category)) {
    return {
      detected: ['citizen'],
      suggested: 'citizen',
      confidence: 'category-logic',
      needsManual: false,
      logic: 'Graphics: contents inside the archive citizen folder → configured Citizen folder'
    }
  }

  if (isCreatorBundle(item)) {
    const actualFiles = files.filter((f) => !f.folder)
    const infos = actualFiles.map((f) => routeInfoForPath(f.path, category))
    const detected = [...new Set(infos.filter(Boolean).map((x) => x.route))]
    const unknownCount = infos.filter((x) => !x).length
    const needsManual = unknownCount > 0 && detected.length !== 1
    return {
      detected,
      suggested: !needsManual && detected.length === 1 ? detected[0] : null,
      confidence: detected.length ? 'smart-content' : categoryFallback(category) ? 'category' : 'manual',
      needsManual,
      unknownCount,
      logic: unknownCount
        ? `${actualFiles.length - unknownCount} files mapped automatically; ${unknownCount} need a fallback destination.`
        : `All ${actualFiles.length} files mapped from folder names, file types and bundle category.`
    }
  }

  const detected = [...new Set(files.map((f) => segmentRoute(f.path)).filter(Boolean))]
  if (detected.length) return { detected, suggested: detected.length === 1 ? detected[0] : null, confidence: 'content', needsManual: false }
  const fallback = categoryFallback(category)
  return { detected: [], suggested: fallback, confidence: fallback ? 'category' : 'manual', needsManual: !fallback }
}

async function downloadTo(url, target, jobId) {
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const response = await net.fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed (${response.status} ${response.statusText})`)
  const total = Number(response.headers.get('content-length') || 0)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Download stream unavailable')
  const file = fs.createWriteStream(target)
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (!file.write(Buffer.from(value))) await new Promise((r) => file.once('drain', r))
      mainWindow?.webContents.send('download:progress', {
        jobId,
        received,
        total,
        percent: total ? Math.round((received / total) * 100) : null
      })
    }
  } finally {
    await new Promise((resolve, reject) => file.end((err) => err ? reject(err) : resolve()))
  }
  return { total, received, contentType: response.headers.get('content-type') || '' }
}

function archiveKind(fileName) {
  const ext = path.extname(fileName).toLowerCase()
  if (ext === '.rar') return 'rar'
  if (['.zip', '.7z'].includes(ext)) return 'archive'
  if (ext === '.rpf') return 'rpf'
  return 'file'
}

async function readHeader(filePath, length = 512) {
  const handle = await fsp.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function hasSignature(buffer, signature) {
  if (buffer.length < signature.length) return false
  return signature.every((byte, index) => buffer[index] === byte)
}

async function validateDownloadedFile(filePath, fileName, contentType = '') {
  const stat = await fsp.stat(filePath)
  if (!stat.size) throw new Error(`The download for ${fileName} was empty.`)

  const ext = path.extname(fileName).toLowerCase()
  if (!['.zip', '.rar', '.7z'].includes(ext)) return

  const header = await readHeader(filePath)
  const valid = ext === '.rar'
    ? hasSignature(header, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])
    : ext === '.7z'
      ? hasSignature(header, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
      : hasSignature(header, [0x50, 0x4b])

  if (valid) return

  const bodyStart = header.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 120)
  const looksLikeWebError = /html|xml|json|access denied|expired|not found|unauthorized/i.test(`${contentType} ${bodyStart}`)
  if (looksLikeWebError) {
    throw new Error(`The download link did not return a valid ${ext.slice(1).toUpperCase()} file. The Discord/CDN link may have expired or become private.`)
  }
  throw new Error(`${fileName} downloaded, but its file data is not a valid ${ext.slice(1).toUpperCase()} archive.`)
}


async function testArchiveIntegrity(archivePath, fileName, kind) {
  if (!['archive', 'rar'].includes(kind)) return { ok: true, method: 'not-required' }
  try {
    await run7zip(['t', '-bd', '-y', archivePath])
    return { ok: true, method: '7zip-test' }
  } catch (error) {
    // Some RAR variants can be read by the dedicated RAR worker even when the
    // bundled 7-Zip build cannot test them. Do not reject those as corrupt.
    if (kind === 'rar') {
      try {
        const result = await runArchiveWorker('list', { archivePath })
        if ((result.files || []).length) return { ok: true, method: 'rar-reader' }
      } catch {}
    }
    const detail = String(error?.message || 'Archive test failed').replace(/\s+/g, ' ').trim().slice(0, 220)
    throw new Error(`This archive appears to be corrupt or incomplete. ${detail}`)
  }
}

async function prepareInstall(item) {
  const jobId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'soren-fivem-'))
  try {
    const fileName = item.fileName || filenameFromUrl(item.downloadUrl)
    const archivePath = path.join(tempDir, fileName.replace(/[<>:"/\\|?*]/g, '_'))
    let downloadInfo = { contentType: 'application/zip', total: 0, received: 0 }
    if (item.cloudFileId) {
      if (!accountCloud) throw new Error('Soren Cloud is not ready yet.')
      downloadInfo = await accountCloud.downloadCloudFile(item.cloudFileId, archivePath, jobId)
    } else if (item.localPath) {
      const source = path.resolve(String(item.localPath))
      const root = path.resolve(await ensurePacksDir()) + path.sep
      if (!source.startsWith(root)) throw new Error('This pack is outside the Soren Packs folder.')
      await fsp.copyFile(source, archivePath)
      const stat = await fsp.stat(archivePath)
      downloadInfo.total = stat.size
      downloadInfo.received = stat.size
      mainWindow?.webContents.send('download:progress', { jobId, received: stat.size, total: stat.size, percent: 100 })
    } else {
      downloadInfo = await downloadTo(item.downloadUrl, archivePath, jobId)
    }
    await validateDownloadedFile(archivePath, fileName, downloadInfo?.contentType)

    const kind = archiveKind(fileName)
    const integrity = await testArchiveIntegrity(archivePath, fileName, kind)
    let files = []
    if (kind === 'rar') {
      const result = await runArchiveWorker('list', { archivePath })
      files = result.files || []
    } else if (kind === 'archive') {
      const listing = await run7zip(['l', '-slt', archivePath])
      files = parse7ZipList(listing, archivePath)
    } else {
      const stat = await fsp.stat(archivePath)
      files = [{ path: fileName, folder: false, size: stat.size }]
    }

    assertSafeArchiveEntries(files)
    const routing = detectRoutes(files, item.category, item)
    const missingFiles = missingRequiredFiles(files, item.category)
    preparedJobs.set(jobId, { jobId, tempDir, archivePath, fileName, kind, item, files, routing, integrity, missingFiles })
    return {
      jobId,
      fileName,
      kind,
      fileCount: files.filter((f) => !f.folder).length,
      totalSize: files.reduce((n, f) => n + (f.folder ? 0 : f.size), 0),
      files: files.slice(0, 250),
      routing,
      integrity,
      missingFiles,
      routeLabels
    }
  } catch (error) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function exists(p) {
  try { await fsp.access(p); return true } catch { return false }
}

async function findMarkerDirs(root) {
  const results = []
  const markerMap = {
    citizen: 'citizen',
    audio: 'gtaAudio',
    sfx: 'gtaAudio',
    mods: 'fivemMod',
    mod: 'fivemMod',
    addons: 'fivemAddon',
    addon: 'fivemAddon'
  }
  async function walk(dir, depth = 0) {
    if (depth > 8) return
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const full = path.join(dir, ent.name)
      const route = markerMap[ent.name.toLowerCase()]
      if (route) results.push({ route, dir: full, marker: ent.name })
      else await walk(full, depth + 1)
    }
  }
  await walk(root)
  return results
}

async function findNamedDirs(root, wantedName) {
  const matches = []
  const wanted = wantedName.toLowerCase()
  async function walk(dir, depth = 0) {
    if (depth > 8) return
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const full = path.join(dir, ent.name)
      if (ent.name.toLowerCase() === wanted) matches.push({ dir: full, depth })
      else await walk(full, depth + 1)
    }
  }
  await walk(root)
  return matches.sort((a, b) => a.depth - b.depth)
}

async function unwrapSingleFolder(root) {
  let current = root
  for (let i = 0; i < 4; i++) {
    const entries = await fsp.readdir(current, { withFileTypes: true })
    if (entries.length !== 1 || !entries[0].isDirectory()) break
    current = path.join(current, entries[0].name)
  }
  return current
}

function safeTarget(base, relativePath) {
  const target = path.resolve(base, relativePath)
  const baseResolved = path.resolve(base)
  const rel = path.relative(baseResolved, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Unsafe archive path: ${relativePath}`)
  return target
}

async function collectFiles(root) {
  const out = []
  async function walk(dir) {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) await walk(full)
      else if (ent.isFile()) out.push(full)
    }
  }
  await walk(root)
  return out
}

async function ensureExtracted(job) {
  if (!['archive', 'rar'].includes(job.kind)) return null
  if (job.extractedPath && await exists(job.extractedPath)) return job.extractedPath
  const extracted = path.join(job.tempDir, 'extracted')
  await fsp.rm(extracted, { recursive: true, force: true }).catch(() => {})
  await fsp.mkdir(extracted, { recursive: true })
  if (job.kind === 'rar') await runArchiveWorker('extract', { archivePath: job.archivePath, targetPath: extracted })
  else await run7zip(['x', '-y', `-o${extracted}`, job.archivePath])
  job.extractedPath = extracted
  return extracted
}

function relativeBloodEffectPath(payloadRoot, src) {
  const rel = path.relative(payloadRoot, src)
  const parts = rel.split(path.sep).filter(Boolean)
  const lower = parts.map((p) => p.toLowerCase())
  const effectsIndex = lower.lastIndexOf('effects')
  if (effectsIndex >= 0 && effectsIndex < parts.length - 1) return path.join(...parts.slice(effectsIndex + 1))
  if (effectsIndex === parts.length - 1) return path.basename(src)
  return rel
}

async function addTreeToPlan(plan, srcRoot, destRoot, route, backupPrefix = '') {
  for (const src of await collectFiles(srcRoot)) {
    const rel = path.relative(srcRoot, src)
    plan.push({
      src,
      dst: safeTarget(destRoot, rel),
      route,
      backupRelative: path.join(backupPrefix || route, rel)
    })
  }
}

async function buildBloodFxPlan(job, settings) {
  const plan = []
  const modDest = settings.fivemMod
  const citizenDest = settings.citizen
  if (!modDest || !fs.existsSync(modDest)) throw new Error(`${routeLabels.fivemMod} folder could not be detected: ${modDest || '(missing)'}`)
  if (!citizenDest || !fs.existsSync(citizenDest)) throw new Error(`${routeLabels.citizen} folder could not be detected: ${citizenDest || '(missing)'}`)
  const effectsDest = path.join(citizenDest, 'common', 'data', 'effects')

  if (['archive', 'rar'].includes(job.kind)) {
    const extracted = await ensureExtracted(job)
    const payloadRoot = await unwrapSingleFolder(extracted)
    for (const src of await collectFiles(payloadRoot)) {
      const ext = path.extname(src).toLowerCase()
      if (ext === '.rpf') {
        plan.push({ src, dst: safeTarget(modDest, path.basename(src)), route: 'fivemMod', backupRelative: path.join('fivemMod', path.basename(src)), slot: 'bloodfx' })
      } else {
        const rel = relativeBloodEffectPath(payloadRoot, src)
        plan.push({ src, dst: safeTarget(effectsDest, rel), route: 'citizen', backupRelative: path.join('citizen', 'common', 'data', 'effects', rel), slot: 'bloodfx' })
      }
    }
  } else if (path.extname(job.fileName).toLowerCase() === '.rpf') {
    plan.push({ src: job.archivePath, dst: safeTarget(modDest, job.fileName), route: 'fivemMod', backupRelative: path.join('fivemMod', job.fileName), slot: 'bloodfx' })
  } else {
    plan.push({ src: job.archivePath, dst: safeTarget(effectsDest, job.fileName), route: 'citizen', backupRelative: path.join('citizen', 'common', 'data', 'effects', job.fileName), slot: 'bloodfx' })
  }
  return plan
}

async function buildGraphicsPlan(job, settings) {
  const citizenDest = settings.citizen
  if (!citizenDest) throw new Error(`${routeLabels.citizen} folder could not be detected.`)
  if (!fs.existsSync(citizenDest)) throw new Error(`${routeLabels.citizen} folder does not exist: ${citizenDest}`)
  if (!['archive', 'rar'].includes(job.kind)) throw new Error('Graphics packs must be ZIP/RAR archives containing a citizen folder.')

  const extracted = await ensureExtracted(job)
  const citizenDirs = await findNamedDirs(extracted, 'citizen')
  if (!citizenDirs.length) throw new Error('This Graphics Pack does not contain a citizen folder.')

  const citizenDir = citizenDirs[0].dir
  const plan = [{
    operation: 'replace-directory',
    src: citizenDir,
    dst: citizenDest,
    route: 'citizen',
    backupRelative: 'citizen'
  }]

  // Some graphics packs ship one or more .rpf files beside the citizen
  // folder. Those RPFs belong in FiveM's mods folder, not inside Citizen.
  const modDest = settings.fivemMod
  const extractedFiles = await collectFiles(extracted)
  const citizenRoot = path.resolve(citizenDir) + path.sep
  const externalRpfs = extractedFiles.filter((src) => {
    if (path.extname(src).toLowerCase() !== '.rpf') return false
    const resolved = path.resolve(src)
    return !resolved.startsWith(citizenRoot)
  })

  if (externalRpfs.length) {
    if (!modDest || !fs.existsSync(modDest)) {
      throw new Error(`${routeLabels.fivemMod} folder could not be detected: ${modDest || '(missing)'}`)
    }
    for (const src of externalRpfs) {
      const fileName = path.basename(src)
      plan.push({
        src,
        dst: safeTarget(modDest, fileName),
        route: 'fivemMod',
        backupRelative: path.join('fivemMod', fileName)
      })
    }
  }

  return plan
}

async function buildGtaSoundPlan(job, settings) {
  const dest = settings.gtaAudio
  if (!dest) throw new Error(`${routeLabels.gtaAudio} folder is not configured in Settings.`)
  if (!fs.existsSync(dest)) throw new Error(`${routeLabels.gtaAudio} folder does not exist: ${dest}`)
  if (!['archive', 'rar'].includes(job.kind)) return [{ src: job.archivePath, dst: safeTarget(dest, job.fileName), route: 'gtaAudio', backupRelative: path.join('gtaAudio', job.fileName), slot: 'gtasounds' }]
  const extracted = await ensureExtracted(job)
  const wanted = []
  async function walk(dir) {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) await walk(full)
      else if (ent.isFile() && /^(resident|weapons_player)\.rpf$/i.test(ent.name)) wanted.push(full)
    }
  }
  await walk(extracted)
  const names = new Set(wanted.map((p) => path.basename(p).toLowerCase()))
  if (!names.has('resident.rpf') || !names.has('weapons_player.rpf')) throw new Error('This pack is not a GTA Sounds pack. Both RESIDENT.rpf and WEAPONS_PLAYER.rpf are required.')
  return wanted.map((src) => ({ src, dst: safeTarget(dest, path.basename(src)), route: 'gtaAudio', backupRelative: path.join('gtaAudio', path.basename(src)), slot: 'gtasounds' }))
}

async function creatorPayloadRoot(root) {
  let current = root
  const routeMarkers = new Set(['citizen', 'audio', 'sfx', 'mods', 'mod', 'addons', 'addon'])
  for (let i = 0; i < 4; i++) {
    const entries = await fsp.readdir(current, { withFileTypes: true })
    if (entries.length !== 1 || !entries[0].isDirectory()) break
    if (routeMarkers.has(entries[0].name.toLowerCase())) break
    current = path.join(current, entries[0].name)
  }
  return current
}

async function buildCreatorBundlePlan(job, settings, selectedRoute) {
  const plan = []
  const ensureRoute = (route) => {
    const dest = settings[route]
    if (!dest) throw new Error(`${routeLabels[route]} folder is not configured in Settings.`)
    if (!fs.existsSync(dest)) throw new Error(`${routeLabels[route]} folder does not exist: ${dest}`)
    return dest
  }

  if (!['archive', 'rar'].includes(job.kind)) {
    const info = routeInfoForPath(job.fileName, job.item.category)
    const route = info?.route || selectedRoute || job.routing.suggested
    if (!route) throw new Error('Choose a fallback install destination before installing this creator bundle.')
    const dest = ensureRoute(route)
    plan.push({ src: job.archivePath, dst: safeTarget(dest, info?.relative || job.fileName), route, backupRelative: path.join(route, info?.relative || job.fileName) })
    return plan
  }

  const extracted = await ensureExtracted(job)
  const payloadRoot = await creatorPayloadRoot(extracted)
  const sources = await collectFiles(payloadRoot)
  const mapped = sources.map((src) => {
    const rel = path.relative(payloadRoot, src)
    return { src, rel, info: routeInfoForPath(rel, job.item.category) }
  })
  const knownRoutes = [...new Set(mapped.filter((x) => x.info).map((x) => x.info.route))]
  const unknown = mapped.filter((x) => !x.info)
  const fallbackRoute = selectedRoute || (unknown.length && knownRoutes.length === 1 ? knownRoutes[0] : null)
  if (unknown.length && !fallbackRoute) {
    throw new Error(`${unknown.length} file${unknown.length === 1 ? '' : 's'} could not be routed automatically. Choose a fallback install destination.`)
  }

  for (const entry of mapped) {
    const route = entry.info?.route || fallbackRoute
    const relative = entry.info?.relative || entry.rel
    const dest = ensureRoute(route)
    plan.push({
      src: entry.src,
      dst: safeTarget(dest, relative),
      route,
      backupRelative: path.join(route, relative)
    })
  }
  return plan
}

async function buildGeneralPlan(job, settings, selectedRoute) {
  const plan = []
  const ensureRoute = (route) => {
    const dest = settings[route]
    if (!dest) throw new Error(`${routeLabels[route]} folder is not configured in Settings.`)
    if (!fs.existsSync(dest)) throw new Error(`${routeLabels[route]} folder does not exist: ${dest}`)
    return dest
  }

  if (['archive', 'rar'].includes(job.kind)) {
    const extracted = await ensureExtracted(job)
    const markerDirs = await findMarkerDirs(extracted)
    const detectedTypes = [...new Set(markerDirs.map((x) => x.route))]
    if (markerDirs.length && detectedTypes.length) {
      for (const entry of markerDirs) {
        const dest = ensureRoute(entry.route)
        await addTreeToPlan(plan, entry.dir, dest, entry.route, entry.route)
      }
    } else {
      const route = selectedRoute || job.routing.suggested
      if (!route) throw new Error('Choose an install destination before installing this pack.')
      const dest = ensureRoute(route)
      const payloadRoot = await unwrapSingleFolder(extracted)
      await addTreeToPlan(plan, payloadRoot, dest, route, route)
    }
  } else {
    const route = selectedRoute || job.routing.suggested
    if (!route) throw new Error('Choose an install destination before installing this file.')
    const dest = ensureRoute(route)
    plan.push({ src: job.archivePath, dst: safeTarget(dest, job.fileName), route, backupRelative: path.join(route, job.fileName) })
  }
  return plan
}

async function buildInstallPlan(job, settings, selectedRoute) {
  if (isBloodFxCategory(job.item.category)) return buildBloodFxPlan(job, settings)
  if (isGraphicsCategory(job.item.category)) return buildGraphicsPlan(job, settings)
  if (isGtaSoundCategory(job.item.category)) return buildGtaSoundPlan(job, settings)
  if (isPvpGsCategory(job.item.category)) return buildGeneralPlan(job, settings, selectedRoute)
  if (isCreatorBundle(job.item)) return buildCreatorBundlePlan(job, settings, selectedRoute)
  return buildGeneralPlan(job, settings, selectedRoute)
}

async function addHistory(entry) {
  const file = userDataFile('history.json')
  const history = await readJson(file, [])
  history.unshift(entry)
  await writeJson(file, history.slice(0, 100))
}


function backupsRoot() {
  return path.join(app.getPath('userData'), 'backups')
}

async function directorySize(target) {
  if (!target || !await exists(target)) return 0
  const stat = await fsp.stat(target)
  if (stat.isFile()) return stat.size
  let total = 0
  const stack = [target]
  while (stack.length) {
    const dir = stack.pop()
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) stack.push(full)
      else if (ent.isFile()) total += (await fsp.stat(full).catch(() => ({ size: 0 }))).size || 0
    }
  }
  return total
}

async function nearestExistingPath(target) {
  let current = path.resolve(String(target || path.parse(process.cwd()).root))
  while (!await exists(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return current
}

async function freeSpaceFor(target) {
  try {
    const existing = await nearestExistingPath(target)
    const stats = await fsp.statfs(existing)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

async function collectManagedStaleWork(plan, manifest) {
  const touchedSlots = [...new Set(plan.map((entry) => entry.slot).filter(Boolean))]
  const staleWork = []
  if (!touchedSlots.length) return { touchedSlots, staleWork }

  const newDstsBySlot = new Map()
  for (const entry of plan) {
    if (!entry.slot) continue
    if (!newDstsBySlot.has(entry.slot)) newDstsBySlot.set(entry.slot, new Set())
    newDstsBySlot.get(entry.slot).add(normalizeTrackedPath(entry.dst))
  }
  for (const slot of touchedSlots) {
    const previous = manifest.slots?.[slot]
    if (!previous?.files?.length) continue
    const keep = newDstsBySlot.get(slot) || new Set()
    for (const oldFile of previous.files) {
      if (keep.has(normalizeTrackedPath(oldFile)) || !await exists(oldFile)) continue
      staleWork.push({ slot, oldFile })
    }
  }
  return { touchedSlots, staleWork }
}

async function diskSpaceForPlan(plan, staleWork = []) {
  const requiredByRoot = new Map()
  const addRequired = (target, bytes) => {
    if (!target || !bytes) return
    const root = path.parse(target).root || path.dirname(target)
    requiredByRoot.set(root, (requiredByRoot.get(root) || 0) + bytes)
  }

  // New pack data needs room on each destination drive. Safety backups are
  // stored under Soren's user-data backup folder, which may be a different
  // drive, so account for that volume separately.
  for (const entry of plan) {
    addRequired(entry.dst, await directorySize(entry.src))
    if (await exists(entry.dst)) addRequired(backupsRoot(), await directorySize(entry.dst))
  }
  for (const stale of staleWork) {
    if (await exists(stale.oldFile)) addRequired(backupsRoot(), await directorySize(stale.oldFile))
  }

  const volumes = []
  let warning = false
  let insufficient = false
  for (const [root, rawRequired] of requiredByRoot) {
    const required = Math.ceil(rawRequired * 1.1)
    const free = await freeSpaceFor(root)
    const reserve = 512 * 1024 * 1024
    if (free != null) {
      if (free < required) insufficient = true
      if (free < required + reserve) warning = true
    }
    volumes.push({ root, required, free })
  }
  return { warning, insufficient, volumes }
}

function emitInstallProgress(jobId, stage, percent, current = '', completed = 0, total = 0) {
  mainWindow?.webContents.send('install:progress', { jobId, stage, percent, current, completed, total })
}

async function folderWritable(target) {
  if (!target || !await exists(target)) return false
  const probe = path.join(target, `.soren-write-${process.pid}-${Date.now()}.tmp`)
  try {
    await fsp.writeFile(probe, 'soren')
    await fsp.rm(probe, { force: true })
    return true
  } catch {
    await fsp.rm(probe, { force: true }).catch(() => {})
    return false
  }
}

async function verifyInstallPaths() {
  const settings = await getSettings()
  const packs = await ensurePacksDir()
  const backups = backupsRoot()
  await fsp.mkdir(backups, { recursive: true })
  const specs = [
    ['citizen', 'Citizen', settings.citizen],
    ['fivemMod', 'FiveM mods', settings.fivemMod],
    ['gtaAudio', 'GTA audio', settings.gtaAudio],
    ['packs', 'Soren Packs', packs],
    ['backups', 'Backups', backups]
  ]
  const paths = []
  for (const [key, label, target] of specs) {
    const existsNow = Boolean(target) && await exists(target)
    const writable = existsNow ? await folderWritable(target) : false
    let status = 'ok'
    let message = 'Ready'
    if (!existsNow) { status = 'missing'; message = 'Folder not found' }
    else if (!writable) {
      status = key === 'gtaAudio' ? 'admin' : 'locked'
      message = key === 'gtaAudio' ? 'Run Soren as Administrator to write here' : 'Windows blocked write access'
    }
    paths.push({ key, label, path: target || '', exists: existsNow, writable, status, message })
  }
  return { ok: paths.every((x) => x.status === 'ok'), checkedAt: new Date().toISOString(), paths }
}

function fiveMExecutableCandidates(settings = {}) {
  if (process.platform !== 'win32') return []
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const candidates = [
    path.join(local, 'FiveM', 'FiveM.exe'),
    path.join(local, 'FiveM', 'FiveM.app', 'FiveM.exe')
  ]
  if (settings.citizen) {
    const appRoot = path.dirname(settings.citizen)
    candidates.push(path.join(appRoot, 'FiveM.exe'), path.join(path.dirname(appRoot), 'FiveM.exe'))
  }
  return [...new Set(candidates.map((x) => path.resolve(x)))]
}

function launchThroughWindowsDesktopShell(target) {
  return new Promise((resolve, reject) => {
    const windowsDir = process.env.WINDIR || 'C:\\Windows'
    const explorer = path.join(windowsDir, 'explorer.exe')
    if (!fs.existsSync(explorer)) {
      reject(new Error('Windows Explorer could not be found.'))
      return
    }

    // Soren may be running as Administrator so it can replace protected GTA
    // audio files. FiveM intentionally refuses to run elevated. Passing the
    // launch request to the user's desktop Explorer shell avoids inheriting
    // Soren's elevated token.
    const child = spawn(explorer, [target], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sanitizeServerCode(code) {
  const value = String(code || '').trim().toLowerCase()
  if (!/^[a-z0-9]{4,16}$/.test(value)) throw new Error('Invalid FiveM server code.')
  return value
}

async function fetchText(url, timeoutMs = 7000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SorenFiveM/3.1.3',
        'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8'
      }
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { text, contentType: response.headers.get('content-type') || '', finalUrl: response.url }
  } finally {
    clearTimeout(timer)
  }
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripFiveMFormatting(value) {
  return stripHtml(value)
    .replace(/\^[0-9]/g, '')
    .replace(/\^#[0-9a-f]{3,8}/gi, '')
    .replace(/\^\*/g, '')
    .replace(/\^_/g, '')
    .replace(/\^~/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeServerApiData(server, raw) {
  const data = raw?.Data || raw?.data || raw || {}
  const players = Array.isArray(data.players)
    ? data.players.map((p) => ({ id: p?.id ?? p?.source ?? null, name: String(p?.name || '').trim(), ping: Number.isFinite(Number(p?.ping)) ? Number(p.ping) : null })).filter((p) => p.name)
    : []
  const clientsRaw = data.clients ?? data.players?.length ?? raw?.clients
  const maxRaw = data.svMaxclients ?? data.sv_maxclients ?? data.maxClients ?? data.maxclients ?? data?.vars?.sv_maxClients ?? data?.vars?.sv_maxclients ?? raw?.svMaxclients ?? raw?.sv_maxclients
  const clients = Number.isFinite(Number(clientsRaw)) ? Number(clientsRaw) : (players.length || null)
  const maxClients = Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : null
  const projectName = stripFiveMFormatting(data?.vars?.sv_projectName || '')
  const hostname = stripFiveMFormatting(data.hostname || '')
  const title = projectName || hostname || server.name
  const iconVersionRaw = data.iconVersion ?? data.icon_version ?? raw?.iconVersion ?? raw?.icon_version
  const iconVersion = Number.isFinite(Number(iconVersionRaw)) ? Number(iconVersionRaw) : 0
  const endpoint = String(raw?.EndPoint || raw?.endPoint || server.code || '').trim()
  const iconUrl = iconVersion > 0 && endpoint
    ? `https://frontend.cfx-services.net/api/servers/icon/${encodeURIComponent(endpoint)}/${encodeURIComponent(String(iconVersion))}.png`
    : null
  return {
    ...server,
    title,
    hostname: title,
    iconUrl,
    iconVersion,
    online: true,
    clients,
    maxClients,
    players,
    source: 'cfx-api',
    checkedAt: new Date().toISOString()
  }
}

async function getFiveMServerStatus(server, force = false) {
  const cached = serverStatusCache.get(server.code)
  if (!force && cached && Date.now() - cached.cachedAt < 15000) return cached.value

  const code = sanitizeServerCode(server.code)
  const apiCandidates = [
    `https://frontend.cfx-services.net/api/servers/single/${code}`,
    `https://servers-frontend.fivem.net/api/servers/single/${code}`
  ]

  for (const url of apiCandidates) {
    try {
      const { text } = await fetchText(url, 5500)
      const parsed = JSON.parse(text)
      const value = normalizeServerApiData(server, parsed)
      serverStatusCache.set(server.code, { cachedAt: Date.now(), value })
      return value
    } catch {}
  }

  try {
    const { text } = await fetchText(server.joinUrl, 6500)
    const bodyText = stripHtml(text)
    const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    const clientMatch = text.match(/"clients"\s*:\s*(\d+)/i) || text.match(/people_outline[^0-9]{0,120}([\d,]+)/i) || bodyText.match(/people_outline\s*([\d,]+)/i)
    const maxMatch = text.match(/"sv_maxclients"\s*:\s*"?(\d+)/i) || text.match(/"svMaxclients"\s*:\s*"?(\d+)/i)
    const clients = clientMatch ? Number(String(clientMatch[1]).replace(/,/g, '')) : null
    const maxClients = maxMatch ? Number(maxMatch[1]) : null
    const pageTitle = titleMatch ? stripHtml(titleMatch[1]).replace(/\s*\/\s*Cfx.*$/i, '').trim() : ''
    const value = {
      ...server,
      title: pageTitle || server.name,
      hostname: pageTitle || server.name,
      iconUrl: null,
      online: true,
      clients: Number.isFinite(clients) ? clients : null,
      maxClients: Number.isFinite(maxClients) ? maxClients : null,
      players: [],
      source: 'join-page',
      checkedAt: new Date().toISOString()
    }
    serverStatusCache.set(server.code, { cachedAt: Date.now(), value })
    return value
  } catch (error) {
    const value = {
      ...server,
      title: server.name,
      hostname: server.name,
      iconUrl: null,
      online: false,
      clients: null,
      maxClients: null,
      players: [],
      source: 'unavailable',
      error: error?.message || 'Server status unavailable',
      checkedAt: new Date().toISOString()
    }
    serverStatusCache.set(server.code, { cachedAt: Date.now(), value })
    return value
  }
}

async function listFeaturedServers(force = false) {
  const values = await Promise.all(FEATURED_SERVERS.map((server) => getFiveMServerStatus(server, force)))
  return values.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1
    return (b.clients ?? -1) - (a.clients ?? -1)
  })
}

async function createServerLaunchOverlay(serverName = 'FiveM') {
  if (serverLaunchWindow && !serverLaunchWindow.isDestroyed()) serverLaunchWindow.close()
  const display = mainWindow && !mainWindow.isDestroyed()
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay()
  const bounds = display.workArea || display.bounds
  // Match FiveM's compact bootstrap window footprint so Soren cleanly covers it.
  const overlaySize = Math.max(360, Math.min(522, bounds.width - 32, bounds.height - 32))
  const overlayWidth = overlaySize
  const overlayHeight = overlaySize
  const overlayX = Math.round(bounds.x + (bounds.width - overlayWidth) / 2)
  const overlayY = Math.round(bounds.y + (bounds.height - overlayHeight) / 2)
  serverLaunchWindow = new BrowserWindow({
    x: overlayX,
    y: overlayY,
    width: overlayWidth,
    height: overlayHeight,
    frame: false,
    transparent: true,
    hasShadow: true,
    roundedCorners: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  serverLaunchWindow.setAlwaysOnTop(true, 'screen-saver')
  serverLaunchWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  serverLaunchWindow.on('closed', () => { serverLaunchWindow = null })
  await serverLaunchWindow.loadFile(path.join(__dirname, 'server-launch.html'), { query: { server: String(serverName || 'FiveM') } })
  if (serverLaunchWindow && !serverLaunchWindow.isDestroyed()) serverLaunchWindow.showInactive()
  return serverLaunchWindow
}

async function updateServerLaunchOverlay(progress, status, detail = '') {
  if (!serverLaunchWindow || serverLaunchWindow.isDestroyed()) return
  const payload = JSON.stringify({ progress: Math.max(0, Math.min(100, Number(progress) || 0)), status: String(status || ''), detail: String(detail || '') })
  await serverLaunchWindow.webContents.executeJavaScript(`window.sorenLaunchUpdate && window.sorenLaunchUpdate(${payload})`).catch(() => {})
}

async function closeServerLaunchOverlay(delayMs = 0) {
  if (delayMs) await sleep(delayMs)
  if (!serverLaunchWindow || serverLaunchWindow.isDestroyed()) return
  await serverLaunchWindow.webContents.executeJavaScript('window.sorenLaunchFinish && window.sorenLaunchFinish()').catch(() => {})
  await sleep(320)
  if (serverLaunchWindow && !serverLaunchWindow.isDestroyed()) serverLaunchWindow.close()
}

function getFiveMProcessState() {
  if (process.platform !== 'win32') return Promise.resolve({ launcher: false, game: false, names: [] })
  return new Promise((resolve) => {
    const child = spawn('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true })
    let output = ''
    child.stdout.on('data', (d) => { output += d.toString() })
    child.once('error', () => resolve({ launcher: false, game: false, names: [] }))
    child.once('close', () => {
      const names = [...output.matchAll(/^"([^"]+)"/gm)].map((m) => m[1]).filter((name) => /^FiveM/i.test(name))
      resolve({
        launcher: names.some((name) => /^FiveM(?:\.exe|_[^]*Launcher(?:\.exe)?)$/i.test(name) || /^FiveM.*\.exe$/i.test(name)),
        game: names.some((name) => /(GTAProcess|GameProcess)/i.test(name)),
        names
      })
    })
  })
}

async function monitorFiveMLaunchOverlay(serverName, connecting = false) {
  const started = Date.now()
  let detected = false
  while (Date.now() - started < 22000) {
    const state = await getFiveMProcessState()
    if (state.game) {
      detected = true
      await updateServerLaunchOverlay(92, connecting ? `Connecting to ${serverName}` : 'FiveM is ready', connecting ? 'Connection request handed to FiveM.' : 'Game process detected.')
      break
    }
    if (state.launcher || state.names.length) {
      detected = true
      await updateServerLaunchOverlay(72, 'FiveM started', connecting ? `Preparing ${serverName}…` : 'Preparing the game…')
    } else {
      const elapsed = Date.now() - started
      const progress = Math.min(64, 34 + Math.round(elapsed / 700))
      await updateServerLaunchOverlay(progress, 'Waiting for FiveM', 'Starting the FiveM client…')
    }
    await sleep(650)
  }
  await updateServerLaunchOverlay(100, connecting ? `Opening ${serverName}` : 'Opening FiveM', detected ? 'Launch handoff complete.' : 'FiveM is taking longer than usual, but the launch request was sent.')
  await closeServerLaunchOverlay(1800)
}

async function launchFiveM() {
  const settings = await getSettings()
  const executable = fiveMExecutableCandidates(settings).find((candidate) => fs.existsSync(candidate))
  await createServerLaunchOverlay('FiveM')
  await updateServerLaunchOverlay(12, 'Starting Soren launch', 'Checking the FiveM installation…')

  try {
    if (process.platform === 'win32') {
      if (executable) {
        await updateServerLaunchOverlay(26, 'Opening FiveM', 'Launching through the normal Windows desktop session…')
        await launchThroughWindowsDesktopShell(executable)
        monitorFiveMLaunchOverlay('FiveM', false).catch(() => closeServerLaunchOverlay(1200))
        return { ok: true, method: 'desktop-shell', path: executable }
      }

      try {
        await updateServerLaunchOverlay(26, 'Opening FiveM', 'Using the FiveM protocol handler…')
        await launchThroughWindowsDesktopShell('fivem://')
        monitorFiveMLaunchOverlay('FiveM', false).catch(() => closeServerLaunchOverlay(1200))
        return { ok: true, method: 'desktop-shell-protocol' }
      } catch {}
    }
  } catch (error) {
    await updateServerLaunchOverlay(100, 'Could not launch FiveM', error?.message || 'Launch failed')
    await closeServerLaunchOverlay(2600)
    throw error
  }

  await updateServerLaunchOverlay(100, 'FiveM not found', 'Verify your FiveM paths in Settings and try again.')
  await closeServerLaunchOverlay(2600)
  throw new Error('FiveM.exe could not be found. Use Verify FiveM Paths in Settings, then try again.')
}

async function joinFeaturedServer(code) {
  const safeCode = sanitizeServerCode(code)
  const server = FEATURED_SERVERS.find((item) => item.code === safeCode)
  if (!server) throw new Error('That server is not in the Soren server list.')
  if (process.platform !== 'win32') throw new Error('Server Quick Launch is currently available on Windows only.')

  await createServerLaunchOverlay(server.name)
  await updateServerLaunchOverlay(8, `Checking ${server.name}`, 'Refreshing server availability…')
  const status = await getFiveMServerStatus(server, true).catch(() => ({ ...server, online: null }))
  if (status?.online === false) {
    await updateServerLaunchOverlay(18, 'Server status unavailable', 'Soren will still attempt to connect.')
  } else if (status?.clients != null) {
    await updateServerLaunchOverlay(20, `${status.clients}${status.maxClients ? ` / ${status.maxClients}` : ''} players online`, 'Sending the join request to FiveM…')
  } else {
    await updateServerLaunchOverlay(20, `${server.name} is reachable`, 'Sending the join request to FiveM…')
  }

  const connectUri = `fivem://connect/cfx.re/join/${safeCode}`
  try {
    await launchThroughWindowsDesktopShell(connectUri)
  } catch (error) {
    await updateServerLaunchOverlay(100, 'Could not open FiveM', error?.message || 'The FiveM protocol handler failed.')
    await closeServerLaunchOverlay(2600)
    throw error
  }

  await updateServerLaunchOverlay(36, 'Launching FiveM', `Quick joining ${server.name}…`)
  monitorFiveMLaunchOverlay(server.name, true).catch(() => closeServerLaunchOverlay(1200))
  return { ok: true, server: { ...server, status }, connectUri }
}

function backupPathForId(id) {
  const safeId = path.basename(String(id || ''))
  if (!safeId || safeId !== String(id || '')) throw new Error('Invalid backup id.')
  const root = path.resolve(backupsRoot())
  const target = path.resolve(root, safeId)
  if (!target.startsWith(root + path.sep)) throw new Error('Invalid backup path.')
  return target
}

async function listBackups() {
  const root = backupsRoot()
  await fsp.mkdir(root, { recursive: true })
  const history = await readJson(userDataFile('history.json'), [])
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  const result = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const full = path.join(root, ent.name)
    const index = await readJson(path.join(full, '_soren-backup.json'), null)
    const stat = await fsp.stat(full).catch(() => null)
    const hist = history.find((h) => h.backupPath && normalizeTrackedPath(h.backupPath) === normalizeTrackedPath(full))
    result.push({
      id: ent.name,
      path: full,
      title: index?.title || hist?.title || ent.name,
      category: index?.category || hist?.category || 'Backup',
      createdAt: index?.createdAt || hist?.installedAt || stat?.mtime?.toISOString?.() || null,
      size: Number.isFinite(index?.size) ? index.size : await directorySize(full),
      canRestore: Boolean(index?.version === 1 && Array.isArray(index?.installedTargets))
    })
  }
  return result.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
}

async function deleteBackup(id) {
  const target = backupPathForId(id)
  if (!await exists(target)) return listBackups()
  await fsp.rm(target, { recursive: true, force: true })
  return listBackups()
}

async function restoreBackup(id) {
  const target = backupPathForId(id)
  const index = await readJson(path.join(target, '_soren-backup.json'), null)
  if (!index?.version || !Array.isArray(index.installedTargets)) throw new Error('This backup was created by an older Soren version and can only be opened or deleted.')
  const settings = await getSettings()
  const isGtaTarget = (value) => settings.gtaAudio && normalizeTrackedPath(value).startsWith(normalizeTrackedPath(settings.gtaAudio))

  const installedTargets = [...new Set(index.installedTargets.map((x) => x.path || x).filter(Boolean))]
    .sort((a, b) => String(b).length - String(a).length)
  for (const installed of installedTargets) {
    if (!await exists(installed)) continue
    try { await fsp.rm(installed, { recursive: true, force: true }) }
    catch (e) { throw makePermissionAwareError(e, installed, isGtaTarget(installed)) }
  }

  for (const entry of index.entries || []) {
    const source = safeTarget(target, entry.backupRelative)
    if (!await exists(source)) continue
    try {
      await fsp.mkdir(path.dirname(entry.originalPath), { recursive: true })
      if (entry.kind === 'directory') await fsp.cp(source, entry.originalPath, { recursive: true, force: true })
      else await fsp.copyFile(source, entry.originalPath)
    } catch (e) { throw makePermissionAwareError(e, entry.originalPath, isGtaTarget(entry.originalPath)) }
  }

  if (index.previousManifest) await writeInstalledManifest(index.previousManifest)
  if (index.previousActiveSetup) await writeJson(activeSetupFile(), index.previousActiveSetup)
  return { ok: true, title: index.title, restoredEntries: (index.entries || []).length }
}

function vanillaBackupRoot() {
  return path.join(app.getPath('userData'), 'vanilla-backup')
}

async function ensureVanillaBackup(plan, item) {
  const root = vanillaBackupRoot()
  const stateFile = path.join(root, 'state.json')
  const state = await readJson(stateFile, { slots: {}, graphics: false })
  await fsp.mkdir(root, { recursive: true })

  const bySlot = new Map()
  for (const entry of plan) {
    if (!entry.slot) continue
    if (!bySlot.has(entry.slot)) bySlot.set(entry.slot, [])
    bySlot.get(entry.slot).push(entry)
  }
  for (const [slot, entries] of bySlot) {
    if (state.slots[slot]) continue
    for (const entry of entries) {
      if (!await exists(entry.dst)) continue
      const rel = entry.backupRelative || path.join(entry.route || slot, path.basename(entry.dst))
      const dst = safeTarget(root, path.join('slots', slot, rel))
      await fsp.mkdir(path.dirname(dst), { recursive: true })
      try {
        if (entry.operation === 'replace-directory') await fsp.cp(entry.dst, dst, { recursive: true, force: true })
        else await fsp.copyFile(entry.dst, dst)
      } catch (e) { throw makePermissionAwareError(e, entry.dst, entry.route === 'gtaAudio') }
    }
    state.slots[slot] = true
  }

  if (item?.category === 'Graphics packs' && !state.graphics) {
    const citizenEntry = plan.find(e => e.operation === 'replace-directory' && e.route === 'citizen')
    if (citizenEntry && await exists(citizenEntry.dst)) {
      const dst = path.join(root, 'graphics', 'citizen')
      try { await fsp.cp(citizenEntry.dst, dst, { recursive: true, force: true }) }
      catch (e) { throw makePermissionAwareError(e, citizenEntry.dst, false) }
      state.graphics = true
    }
  }
  await writeJson(stateFile, state)
}

async function confirmInstall({ jobId, selectedRoute, replaceExisting = false, ignoreDiskWarning = false }) {
  const job = preparedJobs.get(jobId)
  if (!job) throw new Error('Prepared download expired. Open the pack again.')
  if (job.missingFiles?.length) throw new Error(`Missing required files: ${job.missingFiles.join(', ')}`)

  emitInstallProgress(jobId, 'Preparing install', 3)
  const settings = await getSettings()
  const plan = await buildInstallPlan(job, settings, selectedRoute)
  if (!plan.length) throw new Error('No installable files were found in this pack.')

  const previousManifest = await readInstalledManifest()
  const installedManifest = JSON.parse(JSON.stringify(previousManifest))
  installedManifest.slots ||= {}
  const { touchedSlots, staleWork } = await collectManagedStaleWork(plan, installedManifest)

  emitInstallProgress(jobId, 'Checking disk space', 7)
  const diskCheck = await diskSpaceForPlan(plan, staleWork)
  if (diskCheck.insufficient) {
    return { ok: false, needsDiskConfirmation: true, canContinue: false, diskCheck }
  }
  if (diskCheck.warning && !ignoreDiskWarning) {
    return { ok: false, needsDiskConfirmation: true, canContinue: true, diskCheck }
  }

  const conflicts = []
  for (const entry of plan) {
    if (await exists(entry.dst)) conflicts.push(entry.dst)
  }

  if (conflicts.length && !replaceExisting) {
    return {
      ok: false,
      needsOverwriteConfirmation: true,
      conflictCount: conflicts.length,
      conflicts: conflicts.slice(0, 40),
      diskCheck
    }
  }

  emitInstallProgress(jobId, 'Creating safety backup', 12)
  const previousActiveSetup = await getActiveSetup()
  await ensureVanillaBackup(plan, job.item)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupRoot = path.join(backupsRoot(), `${stamp}-${job.item.id}`)
  await fsp.mkdir(backupRoot, { recursive: true })
  const backupIndex = {
    version: 1,
    id: path.basename(backupRoot),
    title: job.item.title,
    category: job.item.category,
    createdAt: new Date().toISOString(),
    previousManifest: JSON.parse(JSON.stringify(previousManifest)),
    previousActiveSetup: JSON.parse(JSON.stringify(previousActiveSetup)),
    entries: [],
    installedTargets: []
  }

  // Remove only files recorded by Soren for the same managed slot. Unrelated
  // user mods are never considered here.
  let removedStaleFiles = 0

  for (let i = 0; i < staleWork.length; i++) {
    const { slot, oldFile } = staleWork[i]
    emitInstallProgress(jobId, 'Removing previous pack files', 18 + Math.round(((i + 1) / Math.max(1, staleWork.length)) * 12), path.basename(oldFile), i + 1, staleWork.length)
    const tag = crypto.createHash('sha1').update(normalizeTrackedPath(oldFile)).digest('hex').slice(0, 8)
    const backupRelative = path.join('removed', slot, `${tag}-${path.basename(oldFile)}`)
    const backupTarget = safeTarget(backupRoot, backupRelative)
    await fsp.mkdir(path.dirname(backupTarget), { recursive: true })
    try { await fsp.copyFile(oldFile, backupTarget) } catch (e) { throw makePermissionAwareError(e, oldFile, slot === 'gtasounds') }
    backupIndex.entries.push({ originalPath: oldFile, backupRelative, kind: 'file', reason: 'stale-managed-file' })
    try { await fsp.rm(oldFile, { force: true }) } catch (e) { throw makePermissionAwareError(e, oldFile, slot === 'gtasounds') }
    removedStaleFiles += 1
  }

  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i]
    const percent = 32 + Math.round(((i + 1) / Math.max(1, plan.length)) * 60)
    emitInstallProgress(jobId, entry.operation === 'replace-directory' ? 'Replacing Citizen folder' : 'Copying pack files', percent, path.basename(entry.dst), i + 1, plan.length)

    if (entry.operation === 'replace-directory') {
      if (await exists(entry.dst)) {
        const backupRelative = entry.backupRelative
        const backupTarget = safeTarget(backupRoot, backupRelative)
        try { await fsp.cp(entry.dst, backupTarget, { recursive: true, force: true }) } catch (e) { throw makePermissionAwareError(e, entry.dst, entry.route === 'gtaAudio') }
        backupIndex.entries.push({ originalPath: entry.dst, backupRelative, kind: 'directory', reason: 'replaced' })
        try { await fsp.rm(entry.dst, { recursive: true, force: true }) } catch (e) { throw makePermissionAwareError(e, entry.dst, entry.route === 'gtaAudio') }
      }
      try { await fsp.cp(entry.src, entry.dst, { recursive: true, force: true }) } catch (e) { throw makePermissionAwareError(e, entry.dst, entry.route === 'gtaAudio') }
      backupIndex.installedTargets.push({ path: entry.dst, kind: 'directory' })
      continue
    }

    try { await fsp.mkdir(path.dirname(entry.dst), { recursive: true }) } catch (e) { throw makePermissionAwareError(e, entry.dst, entry.route === 'gtaAudio') }
    if (await exists(entry.dst)) {
      const backupRelative = entry.backupRelative
      const backupTarget = safeTarget(backupRoot, backupRelative)
      await fsp.mkdir(path.dirname(backupTarget), { recursive: true })
      try { await fsp.copyFile(entry.dst, backupTarget) } catch (e) { throw makePermissionAwareError(e, entry.dst, entry.route === 'gtaAudio') }
      backupIndex.entries.push({ originalPath: entry.dst, backupRelative, kind: 'file', reason: 'replaced' })
    }
    try { await fsp.copyFile(entry.src, entry.dst) } catch (e) { throw makePermissionAwareError(e, entry.dst, entry.route === 'gtaAudio') }
    backupIndex.installedTargets.push({ path: entry.dst, kind: 'file' })
  }

  emitInstallProgress(jobId, 'Saving install state', 96)
  if (touchedSlots.length) {
    const installedAt = new Date().toISOString()
    for (const slot of touchedSlots) {
      const files = plan.filter((entry) => entry.slot === slot).map((entry) => entry.dst)
      installedManifest.slots[slot] = { itemId: job.item.id, itemTitle: job.item.title, files, installedAt }
    }
    await writeInstalledManifest(installedManifest)
  }

  const usedRoutes = [...new Set(plan.map((x) => x.route))]
  const installedAt = new Date().toISOString()
  const historyEntry = {
    id: crypto.randomUUID(),
    itemId: job.item.id,
    title: job.item.title,
    category: job.item.category,
    installedAt,
    routes: usedRoutes,
    backupPath: backupRoot,
    replacedFiles: conflicts.length,
    removedStaleFiles
  }

  await updateActiveSetup(job.item, usedRoutes, installedAt)
  backupIndex.size = await directorySize(backupRoot)
  await writeJson(path.join(backupRoot, '_soren-backup.json'), backupIndex)
  await addHistory(historyEntry)

  // Archives inside Documents\Soren FiveM\Packs are the user's permanent pack
  // library and are never deleted after installation.
  preparedJobs.delete(jobId)
  await fsp.rm(job.tempDir, { recursive: true, force: true }).catch(() => {})
  emitInstallProgress(jobId, 'Installed', 100, '', plan.length, plan.length)
  return { ok: true, historyEntry, copiedFiles: plan.length, replacedFiles: conflicts.length, removedStaleFiles, sourceRemoved: false, diskCheck }
}

async function addPackArchive(sourcePath) {
  if (!sourcePath) throw new Error('No archive was selected.')
  const ext = path.extname(sourcePath).toLowerCase()
  if (!['.zip', '.rar', '.7z'].includes(ext)) throw new Error('Soren only accepts ZIP, RAR and 7Z archives.')
  const dir = await ensurePacksDir()
  let target = path.join(dir, path.basename(sourcePath))
  if (path.resolve(sourcePath) === path.resolve(target)) return { ok: true, fileName: path.basename(target), alreadyInPacks: true }
  if (await exists(target)) {
    const parsed = path.parse(target)
    let i = 2
    while (await exists(target)) target = path.join(parsed.dir, `${parsed.name} (${i++})${parsed.ext}`)
  }
  await fsp.copyFile(sourcePath, target)
  return { ok: true, fileName: path.basename(target), path: target }
}

async function getFavorites() {
  return readJson(userDataFile('favorites.json'), [])
}

async function setFavorite({ itemId, favorite }) {
  const list = new Set(await getFavorites())
  if (favorite) list.add(itemId); else list.delete(itemId)
  const next = [...list]
  await writeJson(userDataFile('favorites.json'), next)
  return next
}

async function copyBackupTree(srcRoot, dstRoot) {
  if (!srcRoot || !dstRoot || !await exists(srcRoot)) return 0
  let count = 0
  for (const src of await collectFiles(srcRoot)) {
    const rel = path.relative(srcRoot, src)
    const dst = safeTarget(dstRoot, rel)
    await fsp.mkdir(path.dirname(dst), { recursive: true })
    await fsp.copyFile(src, dst)
    count++
  }
  return count
}

async function restoreVanilla() {
  const settings = await getSettings()
  const manifest = await readInstalledManifest()
  const root = vanillaBackupRoot()
  let removed = 0, restored = 0

  for (const slot of Object.keys(manifest.slots || {})) {
    for (const target of manifest.slots[slot]?.files || []) {
      if (!await exists(target)) continue
      try { await fsp.rm(target, { recursive: true, force: true }); removed++ }
      catch (e) { throw makePermissionAwareError(e, target, slot === 'gtasounds') }
    }
  }

  const slotMappings = [
    ['bloodfx', 'fivemMod', settings.fivemMod],
    ['bloodfx', 'citizen', settings.citizen],
    ['gtasounds', 'gtaAudio', settings.gtaAudio]
  ]
  for (const [slot, route, dest] of slotMappings) {
    if (!dest) continue
    restored += await copyBackupTree(path.join(root, 'slots', slot, route), dest)
  }

  const graphicsBackup = path.join(root, 'graphics', 'citizen')
  if (settings.citizen && await exists(graphicsBackup)) {
    try {
      await fsp.rm(settings.citizen, { recursive: true, force: true })
      await fsp.cp(graphicsBackup, settings.citizen, { recursive: true, force: true })
      restored++
    } catch (e) { throw makePermissionAwareError(e, settings.citizen, false) }
  }

  manifest.slots = {}
  await writeInstalledManifest(manifest)
  await writeJson(activeSetupFile(), { slots: {}, updatedAt: new Date().toISOString() })
  return { ok: true, removed, restored, backupAvailable: await exists(root) }
}

function makePermissionAwareError(error, targetPath = '', gtaAudio = false) {
  const code = String(error?.code || '').toUpperCase()
  const permission = ['EACCES','EPERM'].includes(code) || /access denied|permission/i.test(String(error?.message || ''))
  if (permission && gtaAudio) {
    const err = new Error(`Windows blocked access to the GTA sound folder${targetPath ? `: ${targetPath}` : ''}. Close GTA/FiveM and run Soren FiveM as Administrator, then try again.`)
    err.code = 'ADMIN_REQUIRED'
    return err
  }
  if (permission) {
    const err = new Error(`Windows blocked access to ${targetPath || 'this folder'}. Close FiveM/GTA and try running Soren FiveM as Administrator.`)
    err.code = 'ADMIN_REQUIRED'
    return err
  }
  return error
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 857,
    height: 575,
    minWidth: 820,
    minHeight: 540,
    frame: false,
    title: 'Soren FiveM',
    icon: path.join(__dirname, '..', 'assets', 'soren-logo.png'),
    autoHideMenuBar: true,
    backgroundColor: '#0b0809',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  mainWindow.once('ready-to-show', revealMainWindow)
  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(async () => {
  createSplashWindow()
  try {
    await migrateLegacyUserData()
    await ensurePacksDir()
    startPacksWatcher()
  } catch (error) {
    console.error('Soren FiveM startup preparation failed:', error)
  }

  accountCloud = createAccountCloudService({
    app,
    shell,
    net,
    mainWindow: () => mainWindow,
    ensurePacksDir
  })
  accountCloud.registerIpc(ipcMain)

  ipcMain.handle('packs:get', () => scanLocalPacks())
  ipcMain.handle('packs:open-folder', async () => shell.openPath(await ensurePacksDir()))
  ipcMain.handle('packs:add-file', async (_event, sourcePath) => addPackArchive(sourcePath))
  ipcMain.handle('packs:choose-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Add pack to Soren', properties: ['openFile'], filters: [{ name: 'Pack archives', extensions: ['zip','rar','7z'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    return addPackArchive(result.filePaths[0])
  })
  ipcMain.handle('fivem:launch', () => launchFiveM())
  ipcMain.handle('servers:list', (_event, force = false) => listFeaturedServers(Boolean(force)))
  ipcMain.handle('servers:join', (_event, code) => joinFeaturedServer(code))
  ipcMain.handle('paths:verify', () => verifyInstallPaths())
  ipcMain.handle('reshade:prepare-folders', () => prepareReshadeFolders())
  ipcMain.handle('reshade:download', () => shell.openExternal('https://reshade.me/#download'))
  ipcMain.handle('reshade:launch-setup', () => launchReshadeSetup())
  ipcMain.handle('reshade:finish-install', () => finishReshadeInstall())
  ipcMain.handle('reshade:status', () => reshadeFiveMStatus())
  ipcMain.handle('reshade:acknowledge', () => acknowledgeReshadeForFiveM())
  ipcMain.handle('active:get', () => getActiveSetup())
  ipcMain.handle('queue:get', () => getInstallQueue())
  ipcMain.handle('queue:add', (_event, item) => addInstallQueueItem(item))
  ipcMain.handle('queue:remove', (_event, itemId) => removeInstallQueueItem(itemId))
  ipcMain.handle('queue:clear', () => clearInstallQueue())
  ipcMain.handle('backups:get', () => listBackups())
  ipcMain.handle('backups:delete', (_event, id) => deleteBackup(id))
  ipcMain.handle('backups:restore', (_event, id) => restoreBackup(id))
  ipcMain.handle('favorites:get', () => getFavorites())
  ipcMain.handle('favorites:set', (_event, payload) => setFavorite(payload))
  ipcMain.handle('restore:vanilla', () => restoreVanilla())
  ipcMain.handle('discord:open', () => shell.openExternal('https://discord.gg/6c7DHcuuk7'))
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:choose-folder', async (_event, key) => {
    if (!(key in routeLabels)) throw new Error('Unknown folder setting')
    const current = await getSettings()
    const result = await dialog.showOpenDialog(mainWindow, {
      title: `Choose ${routeLabels[key]} folder`,
      defaultPath: current[key] || undefined,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return current
    current[key] = result.filePaths[0]
    return saveSettings(current)
  })
  ipcMain.handle('settings:clear-folder', async (_event, key) => {
    if (!(key in routeLabels)) throw new Error('Unknown folder setting')
    const current = await getSettings()
    current[key] = ''
    return saveSettings(current)
  })
  ipcMain.handle('install:prepare', (_event, item) => prepareInstall(item))
  ipcMain.handle('install:confirm', (_event, payload) => confirmInstall(payload))
  ipcMain.handle('install:cancel-prepared', async (_event, jobId) => {
    const job = preparedJobs.get(jobId)
    if (job) {
      preparedJobs.delete(jobId)
      await fsp.rm(job.tempDir, { recursive: true, force: true }).catch(() => {})
    }
    return true
  })
  ipcMain.handle('history:get', async () => {
    const history = await readJson(userDataFile('history.json'), [])
    return Promise.all(history.map(async (entry) => ({ ...entry, backupExists: Boolean(entry.backupPath && await exists(entry.backupPath)) })))
  })
  ipcMain.handle('app:info', () => getAppInfo())
  ipcMain.handle('security:verify', () => verifyIntegrity())
  ipcMain.handle('shell:open-path', (_event, targetPath) => shell.openPath(targetPath))
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())

  createWindow()

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (serverLaunchWindow && !serverLaunchWindow.isDestroyed()) serverLaunchWindow.close()
  packsWatcher?.close()
  clearTimeout(packsWatchTimer)
  for (const job of preparedJobs.values()) {
    fs.rmSync(job.tempDir, { recursive: true, force: true })
  }
})
