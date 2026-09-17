const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const http = require('http')
const https = require('https')
const { execFile } = require('child_process')
const { safeStorage } = require('electron')

const DEFAULT_API_BASE = process.env.SOREN_API_URL || 'https://sorenm.xyz/api/v1'
const DEFAULT_DISCORD_INVITE = 'https://discord.gg/6c7DHcuuk7'

function createAccountCloudService({ app, shell, net, mainWindow, ensurePacksDir }) {
  const apiBase = String(DEFAULT_API_BASE).replace(/\/+$/, '')

  function accountStateFile() {
    return path.join(app.getPath('userData'), 'account-session.json')
  }

  async function readJson(file, fallback = null) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch { return fallback }
  }

  async function writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf8')
  }

  async function loadSessionToken() {
    const saved = await readJson(accountStateFile(), null)
    if (!saved) return null
    try {
      if (saved.encrypted && saved.value && safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(saved.value, 'base64'))
      }
      return saved.token || null
    } catch {
      return null
    }
  }

  async function saveSessionToken(token) {
    if (!token) {
      await fsp.rm(accountStateFile(), { force: true }).catch(() => {})
      return
    }
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(token).toString('base64')
      await writeJson(accountStateFile(), { encrypted: true, value: encrypted })
    } else {
      await writeJson(accountStateFile(), { encrypted: false, token })
    }
  }

  async function apiJson(endpoint, { method = 'GET', body = null, auth = false } = {}) {
    const headers = { Accept: 'application/json' }
    if (body != null) headers['Content-Type'] = 'application/json'
    if (auth) {
      const token = await loadSessionToken()
      if (!token) {
        const err = new Error('Sign in to your Soren account first.')
        err.status = 401
        throw err
      }
      headers.Authorization = `Bearer ${token}`
    }
    const response = await net.fetch(`${apiBase}${endpoint}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      redirect: 'follow'
    })
    const text = await response.text()
    let data = null
    try { data = text ? JSON.parse(text) : {} } catch { data = { message: text } }
    if (!response.ok) {
      const err = new Error(data?.error || data?.message || `Soren Cloud request failed (${response.status})`)
      err.status = response.status
      throw err
    }
    return data
  }

  async function machineIdentifier() {
    if (process.platform === 'win32') {
      const raw = await new Promise((resolve) => {
        execFile('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true }, (error, stdout) => {
          if (error) return resolve('')
          const match = String(stdout || '').match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i)
          resolve(match ? match[1].trim() : '')
        })
      })
      if (raw) return raw
    }

    const seedFile = path.join(app.getPath('userData'), 'device-seed.txt')
    try {
      const existing = (await fsp.readFile(seedFile, 'utf8')).trim()
      if (existing) return existing
    } catch {}
    const seed = crypto.randomBytes(32).toString('hex')
    await fsp.writeFile(seedFile, seed, 'utf8').catch(() => {})
    return seed
  }

  async function getDeviceInfo() {
    const identifier = await machineIdentifier()
    return {
      deviceHash: crypto.createHash('sha256').update(`soren-device-v1|${identifier}`).digest('hex'),
      deviceName: os.hostname().slice(0, 80),
      platform: `${process.platform} ${os.release()} ${process.arch}`.slice(0, 120)
    }
  }

  async function getAccount() {
    const token = await loadSessionToken()
    if (!token) return null
    try {
      const result = await apiJson('/me', { auth: true })
      return result.account || null
    } catch (error) {
      if (error.status === 401 || error.status === 403) await saveSessionToken(null)
      throw error
    }
  }

  async function getAccountSafe() {
    try { return await getAccount() } catch { return null }
  }

  async function generateKey() {
    return apiJson('/auth/generate-key', { method: 'POST', body: {} })
  }

  async function beginDiscordClaim(payload) {
    const discordId = String(payload?.discordId || '').trim()
    const key = String(payload?.key || '').trim()
    const result = await apiJson('/auth/discord/start', { method: 'POST', body: { discordId, key } })
    if (result.oauthUrl) await shell.openExternal(result.oauthUrl)
    return result
  }

  async function checkClaim(payload) {
    return apiJson('/auth/claim-status', {
      method: 'POST',
      body: { key: String(payload?.key || '').trim(), discordId: String(payload?.discordId || '').trim() }
    })
  }

  async function login(payload) {
    const result = await apiJson('/auth/login', {
      method: 'POST',
      body: {
        key: String(payload?.key || '').trim(),
        discordId: String(payload?.discordId || '').trim(),
        device: await getDeviceInfo()
      }
    })
    if (!result.sessionToken) throw new Error('The Soren server did not return a session token.')
    await saveSessionToken(result.sessionToken)
    return result.account
  }

  async function logout() {
    try { await apiJson('/auth/logout', { method: 'POST', body: {}, auth: true }) } catch {}
    await saveSessionToken(null)
    return true
  }

  async function openInvite() {
    let invite = DEFAULT_DISCORD_INVITE
    try {
      const cfg = await apiJson('/public/config')
      if (cfg.discordInvite) invite = cfg.discordInvite
    } catch {}
    await shell.openExternal(invite)
    return true
  }

  async function getCloudFiles() {
    return apiJson('/cloud/files', { auth: true })
  }

  async function streamUpload(filePath, category) {
    const token = await loadSessionToken()
    if (!token) throw new Error('Sign in to your Soren account first.')
    const stat = await fsp.stat(filePath)
    const target = new URL(`${apiBase}/cloud/upload`)
    const client = target.protocol === 'http:' ? http : https
    const fileName = path.basename(filePath)

    return new Promise((resolve, reject) => {
      const request = client.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'X-Soren-Filename': encodeURIComponent(fileName),
          'X-Soren-Category': encodeURIComponent(String(category || 'Other'))
        }
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let data = {}
          try { data = text ? JSON.parse(text) : {} } catch { data = { message: text } }
          if ((response.statusCode || 500) >= 400) return reject(new Error(data.error || data.message || `Cloud upload failed (${response.statusCode})`))
          resolve(data)
        })
      })
      request.on('error', reject)
      const input = fs.createReadStream(filePath)
      let sent = 0
      input.on('data', (chunk) => {
        sent += chunk.length
        mainWindow()?.webContents.send('cloud:progress', {
          direction: 'upload',
          fileName,
          transferred: sent,
          total: stat.size,
          percent: stat.size ? Math.round((sent / stat.size) * 100) : null
        })
      })
      input.on('error', reject)
      input.pipe(request)
    })
  }

  async function uploadLocalPack(payload) {
    const item = payload?.item || {}
    const source = path.resolve(String(item.localPath || ''))
    const packsDir = path.resolve(await ensurePacksDir())
    const rel = path.relative(packsDir, source)
    if (!source || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Only archives from the Soren Packs folder can be uploaded.')
    if (!/\.(zip|rar|7z)$/i.test(source)) throw new Error('Cloud storage supports ZIP, RAR and 7Z pack archives.')
    const result = await streamUpload(source, item.category)
    if (payload?.moveAfterUpload) {
      await fsp.rm(source, { force: true })
      mainWindow()?.webContents.send('packs:changed')
    }
    return result
  }

  async function downloadCloudFile(fileId, targetPath, jobId = null) {
    const token = await loadSessionToken()
    if (!token) throw new Error('Sign in to your Soren account first.')
    const response = await net.fetch(`${apiBase}/cloud/files/${encodeURIComponent(fileId)}/download`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'follow'
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let message = text
      try { message = JSON.parse(text)?.error || text } catch {}
      throw new Error(message || `Cloud download failed (${response.status})`)
    }
    const total = Number(response.headers.get('content-length') || 0)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Cloud download stream unavailable.')
    await fsp.mkdir(path.dirname(targetPath), { recursive: true })
    const output = fs.createWriteStream(targetPath)
    let received = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (!output.write(Buffer.from(value))) await new Promise((r) => output.once('drain', r))
        const progress = { direction: 'download', fileId, transferred: received, total, percent: total ? Math.round((received / total) * 100) : null }
        mainWindow()?.webContents.send('cloud:progress', progress)
        if (jobId) mainWindow()?.webContents.send('download:progress', { jobId, received, total, percent: progress.percent })
      }
    } finally {
      await new Promise((resolve, reject) => output.end((err) => err ? reject(err) : resolve()))
    }
    return { total, received, contentType: response.headers.get('content-type') || 'application/octet-stream' }
  }

  async function downloadCloudToPacks(file) {
    if (!file?.id || !file?.fileName) throw new Error('Invalid cloud pack.')
    const packsDir = await ensurePacksDir()
    const cleanName = path.basename(String(file.fileName)).replace(/[<>:"/\\|?*]/g, '_')
    let target = path.join(packsDir, cleanName)
    if (fs.existsSync(target)) {
      const ext = path.extname(cleanName)
      const base = path.basename(cleanName, ext)
      target = path.join(packsDir, `${base}-${Date.now()}${ext}`)
    }
    await downloadCloudFile(file.id, target)
    mainWindow()?.webContents.send('packs:changed')
    return { ok: true, path: target }
  }

  async function deleteCloudFile(fileId) {
    return apiJson(`/cloud/files/${encodeURIComponent(fileId)}`, { method: 'DELETE', auth: true })
  }

  async function getOwnerUsers() {
    return apiJson('/owner/users', { auth: true })
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('account:get', () => getAccountSafe())
    ipcMain.handle('account:generate-key', () => generateKey())
    ipcMain.handle('account:begin-discord', (_event, payload) => beginDiscordClaim(payload))
    ipcMain.handle('account:check-claim', (_event, payload) => checkClaim(payload))
    ipcMain.handle('account:login', (_event, payload) => login(payload))
    ipcMain.handle('account:logout', () => logout())
    ipcMain.handle('account:open-invite', () => openInvite())
    ipcMain.handle('cloud:list', () => getCloudFiles())
    ipcMain.handle('cloud:upload-local', (_event, payload) => uploadLocalPack(payload))
    ipcMain.handle('cloud:download-local', (_event, file) => downloadCloudToPacks(file))
    ipcMain.handle('cloud:delete', (_event, fileId) => deleteCloudFile(fileId))
    ipcMain.handle('owner:users', () => getOwnerUsers())
  }

  return {
    apiBase,
    registerIpc,
    downloadCloudFile,
    getAccountSafe
  }
}

module.exports = { createAccountCloudService }
