const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron')
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { Worker } = require('worker_threads')

app.setName('Soren FiveM')

let mainWindow
let splashWindow
let splashShownAt = 0
const preparedJobs = new Map()

const routeLabels = {
  gtaAudio: 'GTA sound / audio',
  citizen: 'Citizen',
  fivemMod: 'FiveM mod',
  fivemAddon: 'FiveM addon'
}


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
    width: 300,
    height: 176,
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
    backgroundColor: '#0b0809',
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

async function getCatalog() {
  try {
    const remote = await getRemoteCatalog()
    await writeJson(userDataFile('catalog-cache.json'), remote)
    return remote
  } catch (error) {
    const cached = await readJson(userDataFile('catalog-cache.json'), null)
    if (cached?.items?.length) {
      return {
        ...cached,
        source: 'cache',
        sourceLabel: `${cached.sourceLabel || 'GitHub catalogue'} · cached`,
        remoteError: error.message
      }
    }
    const local = await getLocalCatalog()
    return { ...local, remoteError: error.message }
  }
}

async function getSettings() {
  return readJson(userDataFile('settings.json'), {
    gtaAudio: '',
    citizen: '',
    fivemMod: '',
    fivemAddon: ''
  })
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

function segmentRoute(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean).map((p) => p.toLowerCase())
  const dirParts = parts.slice(0, Math.max(0, parts.length - 1))
  const rules = [
    ['citizen', ['citizen']],
    ['gtaAudio', ['audio', 'sfx']],
    ['fivemMod', ['mods', 'mod']],
    ['fivemAddon', ['addons', 'addon']]
  ]
  for (const [route, markers] of rules) {
    if (dirParts.some((p) => markers.includes(p))) return route
  }
  return null
}

function categoryFallback(category) {
  const c = String(category || '').toLowerCase()
  if (c.includes('sound')) return 'gtaAudio'
  if (c.includes('graphic')) return 'citizen'
  if (c.includes('tracer') || c.includes('blood')) return 'fivemMod'
  return null
}

function isBloodFxCategory(category) {
  return String(category || '').toLowerCase().includes('blood')
}

function isGraphicsCategory(category) {
  return String(category || '').toLowerCase().includes('graphic')
}

function detectRoutes(files, category) {
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
      logic: 'Blood FX: .rpf files → FiveM mods; effect files → Citizen/common/data/effects'
    }
  }

  if (isGraphicsCategory(category)) {
    return {
      detected: ['citizen'],
      suggested: 'citizen',
      confidence: 'category-logic',
      logic: 'Graphics: contents inside the archive citizen folder → configured Citizen folder'
    }
  }

  const detected = [...new Set(files.map((f) => segmentRoute(f.path)).filter(Boolean))]
  if (detected.length) return { detected, suggested: detected.length === 1 ? detected[0] : null, confidence: 'content' }
  const fallback = categoryFallback(category)
  return { detected: [], suggested: fallback, confidence: fallback ? 'category' : 'manual' }
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

async function prepareInstall(item) {
  const jobId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'soren-fivem-'))
  try {
    const fileName = item.fileName || filenameFromUrl(item.downloadUrl)
    const archivePath = path.join(tempDir, fileName.replace(/[<>:"/\\|?*]/g, '_'))
    const downloadInfo = await downloadTo(item.downloadUrl, archivePath, jobId)
    await validateDownloadedFile(archivePath, fileName, downloadInfo?.contentType)

    const kind = archiveKind(fileName)
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

    const routing = detectRoutes(files, item.category)
    preparedJobs.set(jobId, { jobId, tempDir, archivePath, fileName, kind, item, files, routing })
    return {
      jobId,
      fileName,
      kind,
      fileCount: files.filter((f) => !f.folder).length,
      totalSize: files.reduce((n, f) => n + (f.folder ? 0 : f.size), 0),
      files: files.slice(0, 250),
      routing,
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
  const needsMod = job.files.some((f) => !f.folder && path.extname(f.path).toLowerCase() === '.rpf') || path.extname(job.fileName).toLowerCase() === '.rpf'
  const needsCitizen = job.files.some((f) => !f.folder && path.extname(f.path).toLowerCase() !== '.rpf') || (job.kind !== 'rpf' && !['archive', 'rar'].includes(job.kind))

  if (needsMod) {
    if (!modDest) throw new Error(`${routeLabels.fivemMod} folder is not configured in Settings.`)
    if (!fs.existsSync(modDest)) throw new Error(`${routeLabels.fivemMod} folder does not exist: ${modDest}`)
  }
  if (needsCitizen) {
    if (!citizenDest) throw new Error(`${routeLabels.citizen} folder is not configured in Settings.`)
    if (!fs.existsSync(citizenDest)) throw new Error(`${routeLabels.citizen} folder does not exist: ${citizenDest}`)
  }

  const effectsDest = citizenDest ? path.join(citizenDest, 'common', 'data', 'effects') : null

  if (['archive', 'rar'].includes(job.kind)) {
    const extracted = await ensureExtracted(job)
    const payloadRoot = await unwrapSingleFolder(extracted)
    for (const src of await collectFiles(payloadRoot)) {
      const ext = path.extname(src).toLowerCase()
      if (ext === '.rpf') {
        plan.push({ src, dst: safeTarget(modDest, path.basename(src)), route: 'fivemMod', backupRelative: path.join('fivemMod', path.basename(src)) })
      } else {
        const rel = relativeBloodEffectPath(payloadRoot, src)
        plan.push({ src, dst: safeTarget(effectsDest, rel), route: 'citizen', backupRelative: path.join('citizen', 'common', 'data', 'effects', rel) })
      }
    }
  } else if (path.extname(job.fileName).toLowerCase() === '.rpf') {
    plan.push({ src: job.archivePath, dst: safeTarget(modDest, job.fileName), route: 'fivemMod', backupRelative: path.join('fivemMod', job.fileName) })
  } else {
    plan.push({ src: job.archivePath, dst: safeTarget(effectsDest, job.fileName), route: 'citizen', backupRelative: path.join('citizen', 'common', 'data', 'effects', job.fileName) })
  }

  return plan
}

async function buildGraphicsPlan(job, settings) {
  const citizenDest = settings.citizen
  if (!citizenDest) throw new Error(`${routeLabels.citizen} folder is not configured in Settings.`)
  if (!fs.existsSync(citizenDest)) throw new Error(`${routeLabels.citizen} folder does not exist: ${citizenDest}`)

  if (!['archive', 'rar'].includes(job.kind)) {
    return [{ src: job.archivePath, dst: safeTarget(citizenDest, job.fileName), route: 'citizen', backupRelative: path.join('citizen', job.fileName) }]
  }

  const extracted = await ensureExtracted(job)
  const citizenDirs = await findNamedDirs(extracted, 'citizen')
  if (!citizenDirs.length) throw new Error('This Graphics Pack does not contain a citizen folder, so it was not installed.')

  const plan = []
  await addTreeToPlan(plan, citizenDirs[0].dir, citizenDest, 'citizen', 'citizen')
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
  return buildGeneralPlan(job, settings, selectedRoute)
}

async function addHistory(entry) {
  const file = userDataFile('history.json')
  const history = await readJson(file, [])
  history.unshift(entry)
  await writeJson(file, history.slice(0, 100))
}

async function confirmInstall({ jobId, selectedRoute, replaceExisting = false }) {
  const job = preparedJobs.get(jobId)
  if (!job) throw new Error('Prepared download expired. Open the pack again.')
  const settings = await getSettings()
  const plan = await buildInstallPlan(job, settings, selectedRoute)
  if (!plan.length) throw new Error('No installable files were found in this pack.')

  const conflicts = []
  for (const entry of plan) {
    if (await exists(entry.dst)) conflicts.push(entry.dst)
  }

  if (conflicts.length && !replaceExisting) {
    return {
      ok: false,
      needsOverwriteConfirmation: true,
      conflictCount: conflicts.length,
      conflicts: conflicts.slice(0, 40)
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupRoot = path.join(app.getPath('userData'), 'backups', `${stamp}-${job.item.id}`)
  await fsp.mkdir(backupRoot, { recursive: true })

  for (const entry of plan) {
    await fsp.mkdir(path.dirname(entry.dst), { recursive: true })
    if (await exists(entry.dst)) {
      const backupTarget = safeTarget(backupRoot, entry.backupRelative)
      await fsp.mkdir(path.dirname(backupTarget), { recursive: true })
      await fsp.copyFile(entry.dst, backupTarget)
    }
    await fsp.copyFile(entry.src, entry.dst)
  }

  const usedRoutes = [...new Set(plan.map((x) => x.route))]
  const historyEntry = {
    id: crypto.randomUUID(),
    itemId: job.item.id,
    title: job.item.title,
    category: job.item.category,
    installedAt: new Date().toISOString(),
    routes: usedRoutes,
    backupPath: backupRoot,
    replacedFiles: conflicts.length
  }
  await addHistory(historyEntry)
  preparedJobs.delete(jobId)
  await fsp.rm(job.tempDir, { recursive: true, force: true }).catch(() => {})
  return { ok: true, historyEntry, copiedFiles: plan.length, replacedFiles: conflicts.length }
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
    await ensureCatalog()
  } catch (error) {
    console.error('Soren FiveM startup preparation failed:', error)
  }

  ipcMain.handle('catalog:get', () => getCatalog())
  ipcMain.handle('catalog:open-folder', async () => {
    await ensureCatalog()
    return shell.openPath(userCatalogDir())
  })
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
  ipcMain.handle('history:get', () => readJson(userDataFile('history.json'), []))
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
  for (const job of preparedJobs.values()) {
    fs.rmSync(job.tempDir, { recursive: true, force: true })
  }
})
