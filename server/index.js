require('dotenv').config()

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const express = require('express')
const helmet = require('helmet')
const { rateLimit } = require('express-rate-limit')
const Database = require('better-sqlite3')

const PORT = Number(process.env.PORT || 8787)
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://sorenm.xyz').replace(/\/+$/, '')
const API_PREFIX = '/api/v1'
const DISCORD_CLIENT_ID = String(process.env.DISCORD_CLIENT_ID || '')
const DISCORD_CLIENT_SECRET = String(process.env.DISCORD_CLIENT_SECRET || '')
const DISCORD_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || '')
const DISCORD_GUILD_ID = String(process.env.DISCORD_GUILD_ID || '')
const DISCORD_INVITE = String(process.env.DISCORD_INVITE || 'https://discord.gg/6c7DHcuuk7')
const OWNER_IDS = new Set(String(process.env.OWNER_DISCORD_IDS || '').split(',').map((x) => x.trim()).filter(Boolean))
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/opt/soren-cloud/data')
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || '/opt/soren-cloud/storage')
const DEFAULT_QUOTA = Math.max(1, Number(process.env.DEFAULT_QUOTA_GB || 10)) * 1024 ** 3
const MAX_UPLOAD = Math.max(1, Number(process.env.MAX_UPLOAD_GB || 4)) * 1024 ** 3
const SESSION_MS = Math.max(1, Number(process.env.SESSION_DAYS || 30)) * 86400_000

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(STORAGE_DIR, { recursive: true })

const db = new Database(path.join(DATA_DIR, 'soren-cloud.sqlite'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  discord_id TEXT UNIQUE,
  discord_username TEXT,
  discord_global_name TEXT,
  discord_avatar TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'pending_discord',
  quota_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_ip TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  last_ip TEXT
);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  device_name TEXT,
  platform TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_ip TEXT,
  UNIQUE(user_id, device_hash)
);
CREATE TABLE IF NOT EXISTS cloud_files (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  expected_discord_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_cloud_user ON cloud_files(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
`)

const app = express()
app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(helmet({ contentSecurityPolicy: false }))
app.use(express.json({ limit: '256kb' }))

const authLimiter = rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false })
const uploadLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false })
app.use(`${API_PREFIX}/auth`, authLimiter)

function now() { return new Date().toISOString() }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex') }
function roleForDiscordId(discordId) { return OWNER_IDS.has(String(discordId || '')) ? 'owner' : 'user' }
function clientIp(req) { return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 80) }
function validDiscordId(value) { return /^\d{15,22}$/.test(String(value || '').trim()) }
function validAccountKey(value) { return /^SRN-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(String(value || '').trim().toUpperCase()) }
function cleanFileName(value) {
  const decoded = (() => { try { return decodeURIComponent(String(value || '')) } catch { return String(value || '') } })()
  return path.basename(decoded).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim().slice(0, 180)
}
function cleanCategory(value) {
  const decoded = (() => { try { return decodeURIComponent(String(value || '')) } catch { return String(value || '') } })()
  return decoded.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || 'Other'
}
function avatarUrl(user) {
  if (user.discord_avatar && user.discord_id) return `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.discord_avatar}.png?size=128`
  if (!user.discord_id) return null
  let index = 0
  try { index = Number((BigInt(user.discord_id) >> 22n) % 6n) } catch {}
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`
}
function maskKey(hint) { return `SRN-••••-••••-••••-${String(hint || '????')}` }
function makeAccountKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.randomBytes(16)
  let raw = ''
  for (let i = 0; i < 16; i++) raw += alphabet[bytes[i] % alphabet.length]
  return `SRN-${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}`
}
function userStorage(userId) {
  return Number(db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS total FROM cloud_files WHERE user_id=?').get(userId)?.total || 0)
}
function publicAccount(user) {
  const used = userStorage(user.id)
  return {
    id: user.id,
    discordId: user.discord_id,
    username: user.discord_global_name || user.discord_username || 'Discord user',
    discordUsername: user.discord_username,
    avatarUrl: avatarUrl(user),
    role: user.role,
    status: user.status,
    keyMask: maskKey(user.key_hint),
    storage: { used, quota: Number(user.quota_bytes || DEFAULT_QUOTA) },
    createdAt: user.created_at,
    lastSeenAt: user.last_seen_at
  }
}
function htmlPage(title, message, extra = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#050505;color:#f5f5f5;font:15px Segoe UI,Arial,sans-serif;display:grid;place-items:center;min-height:100vh}.box{width:min(460px,calc(100% - 40px));padding:30px}h1{font-size:24px;margin:0 0 10px}p{color:#a9a9a9;line-height:1.6;margin:0 0 18px}a{display:inline-block;color:#050505;background:#fff;text-decoration:none;padding:10px 14px;border-radius:7px;font-weight:600}.muted{font-size:12px;color:#707070;margin-top:16px}</style></head><body><main class="box"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${extra}<div class="muted">You can return to Soren FiveM.</div></main></body></html>`
}
function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }

function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next) }

function cleanupExpired() {
  const t = now()
  db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(t)
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t)
}
setInterval(cleanupExpired, 10 * 60_000).unref()
cleanupExpired()

async function discordJson(endpoint, options = {}) {
  const response = await fetch(`https://discord.com/api/v10${endpoint}`, options)
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : {} } catch { data = { message: text } }
  if (!response.ok) {
    const error = new Error(data?.message || `Discord request failed (${response.status})`)
    error.status = response.status
    throw error
  }
  return data
}

async function oauthExchange(code, redirectUri) {
  const body = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  })
  return discordJson('/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
}

async function oauthGuildIds(accessToken) {
  const ids = new Set()
  let after = ''
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ limit: '200' })
    if (after) q.set('after', after)
    const guilds = await discordJson(`/users/@me/guilds?${q}`, { headers: { Authorization: `Bearer ${accessToken}` } })
    for (const guild of guilds) ids.add(String(guild.id))
    if (guilds.length < 200) break
    after = String(guilds[guilds.length - 1].id)
  }
  return ids
}

async function botMembership(discordId) {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) return false
  const response = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(DISCORD_GUILD_ID)}/members/${encodeURIComponent(discordId)}`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
  })
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`Discord membership check failed (${response.status}).`)
  return true
}

function requireAuth(req, res, next) {
  const raw = String(req.headers.authorization || '')
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : ''
  if (!token) return res.status(401).json({ error: 'Sign in required.' })
  const tokenHash = sha256(token)
  const row = db.prepare(`
    SELECT s.id AS session_id, s.token_hash, s.expires_at, u.*
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=?
  `).get(tokenHash)
  if (!row || Date.parse(row.expires_at) <= Date.now()) return res.status(401).json({ error: 'Session expired. Sign in again.' })
  if (row.status === 'disabled') return res.status(403).json({ error: 'This Soren account is disabled.' })
  const role = roleForDiscordId(row.discord_id)
  if (role !== row.role) db.prepare('UPDATE users SET role=?, updated_at=? WHERE id=?').run(role, now(), row.id)
  req.auth = { tokenHash, sessionId: row.session_id, user: { ...row, role } }
  const ip = clientIp(req)
  const t = now()
  db.prepare('UPDATE sessions SET last_used_at=?, last_ip=? WHERE id=?').run(t, ip, row.session_id)
  db.prepare('UPDATE users SET last_seen_at=?, last_ip=?, role=? WHERE id=?').run(t, ip, role, row.id)
  next()
}

function requireOwner(req, res, next) {
  if (req.auth?.user?.role !== 'owner') return res.status(404).json({ error: 'Not found.' })
  next()
}

app.get(`${API_PREFIX}/health`, (req, res) => res.json({ ok: true, service: 'Soren Cloud', version: '3.0.0' }))
app.get(`${API_PREFIX}/public/config`, (req, res) => res.json({ discordInvite: DISCORD_INVITE, accountKeyFormat: 'SRN-XXXX-XXXX-XXXX-XXXX' }))

app.post(`${API_PREFIX}/auth/generate-key`, (req, res) => {
  let key
  let keyHash
  do {
    key = makeAccountKey()
    keyHash = sha256(key)
  } while (db.prepare('SELECT 1 FROM users WHERE key_hash=?').get(keyHash))
  const t = now()
  db.prepare(`INSERT INTO users (key_hash,key_hint,role,status,quota_bytes,created_at,updated_at,last_ip) VALUES (?,?,?,?,?,?,?,?)`)
    .run(keyHash, key.slice(-4), 'user', 'pending_discord', DEFAULT_QUOTA, t, t, clientIp(req))
  res.json({ key, status: 'pending_discord' })
})

app.post(`${API_PREFIX}/auth/discord/start`, (req, res) => {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_GUILD_ID) return res.status(503).json({ error: 'Discord signup is not configured on the Soren server yet.' })
  const key = String(req.body?.key || '').trim().toUpperCase()
  const discordId = String(req.body?.discordId || '').trim()
  if (!validAccountKey(key)) return res.status(400).json({ error: 'Enter the generated Soren key.' })
  if (!validDiscordId(discordId)) return res.status(400).json({ error: 'Enter your Discord user ID.' })
  const user = db.prepare('SELECT * FROM users WHERE key_hash=?').get(sha256(key))
  if (!user) return res.status(404).json({ error: 'That Soren key does not exist.' })
  if (user.discord_id && user.discord_id !== discordId) return res.status(409).json({ error: 'That key is already linked to another Discord account.' })
  const state = crypto.randomBytes(32).toString('hex')
  const expires = new Date(Date.now() + 10 * 60_000).toISOString()
  db.prepare('INSERT INTO oauth_states (state,key_hash,expected_discord_id,expires_at) VALUES (?,?,?,?)').run(state, user.key_hash, discordId, expires)
  const redirectUri = `${PUBLIC_BASE_URL}${API_PREFIX}/auth/discord/callback`
  const query = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'identify guilds',
    state
  })
  res.json({ oauthUrl: `https://discord.com/oauth2/authorize?${query}`, expiresAt: expires })
})

app.get(`${API_PREFIX}/auth/discord/callback`, asyncRoute(async (req, res) => {
  const state = String(req.query.state || '')
  const code = String(req.query.code || '')
  const saved = db.prepare('SELECT * FROM oauth_states WHERE state=?').get(state)
  if (!saved || Date.parse(saved.expires_at) <= Date.now()) return res.status(400).send(htmlPage('Verification expired', 'Return to Soren and start Discord verification again.'))
  db.prepare('DELETE FROM oauth_states WHERE state=?').run(state)
  if (!code) return res.status(400).send(htmlPage('Discord verification cancelled', 'No authorization code was returned by Discord.'))

  const redirectUri = `${PUBLIC_BASE_URL}${API_PREFIX}/auth/discord/callback`
  const token = await oauthExchange(code, redirectUri)
  const discordUser = await discordJson('/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } })
  if (String(discordUser.id) !== String(saved.expected_discord_id)) {
    return res.status(403).send(htmlPage('Discord ID does not match', 'The Discord account you approved is not the Discord ID entered in Soren.'))
  }

  const guildIds = await oauthGuildIds(token.access_token)
  const isMember = guildIds.has(DISCORD_GUILD_ID)
  const existing = db.prepare('SELECT id,key_hash FROM users WHERE discord_id=?').get(String(discordUser.id))
  if (existing && existing.key_hash !== saved.key_hash) return res.status(409).send(htmlPage('Already linked', 'That Discord account is already linked to another Soren key.'))
  const status = isMember ? 'active' : 'pending_join'
  const role = roleForDiscordId(discordUser.id)
  const t = now()
  db.prepare(`UPDATE users SET discord_id=?,discord_username=?,discord_global_name=?,discord_avatar=?,role=?,status=?,updated_at=?,last_ip=? WHERE key_hash=?`)
    .run(String(discordUser.id), String(discordUser.username || ''), String(discordUser.global_name || ''), discordUser.avatar || null, role, status, t, clientIp(req), saved.key_hash)

  if (!isMember) {
    return res.send(htmlPage('Join the Soren Discord', 'Your Discord account is verified, but you need to join the Soren Discord to finish signup.', `<a href="${escapeHtml(DISCORD_INVITE)}">Join Discord</a>`))
  }
  res.send(htmlPage('Soren account verified', 'Discord verification is complete. Your Soren account is ready.'))
}))

app.post(`${API_PREFIX}/auth/claim-status`, asyncRoute(async (req, res) => {
  const key = String(req.body?.key || '').trim().toUpperCase()
  const discordId = String(req.body?.discordId || '').trim()
  if (!validAccountKey(key) || !validDiscordId(discordId)) return res.status(400).json({ error: 'Enter your Discord ID and Soren key.' })
  let user = db.prepare('SELECT * FROM users WHERE key_hash=?').get(sha256(key))
  if (!user) return res.status(404).json({ error: 'That Soren key does not exist.' })
  if (user.discord_id && user.discord_id !== discordId) return res.status(403).json({ error: 'Discord ID does not match this key.' })

  if (user.status === 'pending_join' && user.discord_id) {
    try {
      if (await botMembership(user.discord_id)) {
        const role = roleForDiscordId(user.discord_id)
        db.prepare('UPDATE users SET status=?,role=?,updated_at=? WHERE id=?').run('active', role, now(), user.id)
        user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id)
      }
    } catch (error) {
      console.warn('Discord bot membership recheck failed:', error.message)
    }
  }
  res.json({ status: user.status, account: user.discord_id ? publicAccount(user) : null, needsJoin: user.status === 'pending_join', discordInvite: DISCORD_INVITE })
}))

app.post(`${API_PREFIX}/auth/login`, (req, res) => {
  const key = String(req.body?.key || '').trim().toUpperCase()
  const discordId = String(req.body?.discordId || '').trim()
  if (!validAccountKey(key) || !validDiscordId(discordId)) return res.status(400).json({ error: 'Enter your Discord ID and Soren key.' })
  const user = db.prepare('SELECT * FROM users WHERE key_hash=? AND discord_id=?').get(sha256(key), discordId)
  if (!user) return res.status(401).json({ error: 'Discord ID or Soren key is incorrect.' })
  if (user.status === 'pending_join') return res.status(403).json({ error: 'Join the Soren Discord before signing in.', code: 'JOIN_REQUIRED', discordInvite: DISCORD_INVITE })
  if (user.status !== 'active') return res.status(403).json({ error: `This Soren account is ${user.status.replace(/_/g, ' ')}.` })

  const token = `srn_${crypto.randomBytes(40).toString('base64url')}`
  const tokenHash = sha256(token)
  const t = now()
  const expires = new Date(Date.now() + SESSION_MS).toISOString()
  const ip = clientIp(req)
  db.prepare('INSERT INTO sessions (token_hash,user_id,created_at,expires_at,last_used_at,last_ip) VALUES (?,?,?,?,?,?)').run(tokenHash, user.id, t, expires, t, ip)
  const device = req.body?.device || {}
  const deviceHash = String(device.deviceHash || '').slice(0, 128)
  if (deviceHash) {
    db.prepare(`INSERT INTO devices (user_id,device_hash,device_name,platform,first_seen_at,last_seen_at,last_ip)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,device_hash) DO UPDATE SET device_name=excluded.device_name,platform=excluded.platform,last_seen_at=excluded.last_seen_at,last_ip=excluded.last_ip`)
      .run(user.id, deviceHash, String(device.deviceName || '').slice(0,80), String(device.platform || '').slice(0,120), t, t, ip)
  }
  const role = roleForDiscordId(user.discord_id)
  db.prepare('UPDATE users SET last_seen_at=?,last_ip=?,role=?,updated_at=? WHERE id=?').run(t, ip, role, t, user.id)
  const refreshed = db.prepare('SELECT * FROM users WHERE id=?').get(user.id)
  res.json({ sessionToken: token, expiresAt: expires, account: publicAccount(refreshed) })
})

app.get(`${API_PREFIX}/me`, requireAuth, (req, res) => res.json({ account: publicAccount(req.auth.user) }))
app.post(`${API_PREFIX}/auth/logout`, requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.auth.tokenHash)
  res.json({ ok: true })
})

app.get(`${API_PREFIX}/cloud/files`, requireAuth, (req, res) => {
  const files = db.prepare('SELECT id,original_name,category,size_bytes,sha256,created_at FROM cloud_files WHERE user_id=? ORDER BY created_at DESC').all(req.auth.user.id)
  res.json({
    files: files.map((f) => ({ id: f.id, fileName: f.original_name, title: f.original_name.replace(/\.(zip|rar|7z)$/i, ''), category: f.category, size: f.size_bytes, sha256: f.sha256, uploadedAt: f.created_at })),
    storage: { used: userStorage(req.auth.user.id), quota: Number(req.auth.user.quota_bytes || DEFAULT_QUOTA) }
  })
})

app.post(`${API_PREFIX}/cloud/upload`, requireAuth, uploadLimiter, asyncRoute(async (req, res) => {
  const fileName = cleanFileName(req.headers['x-soren-filename'])
  const category = cleanCategory(req.headers['x-soren-category'])
  if (!fileName || !/\.(zip|rar|7z)$/i.test(fileName)) return res.status(400).json({ error: 'Only ZIP, RAR and 7Z archives can be stored in Soren Cloud.' })
  const declared = Number(req.headers['content-length'] || 0)
  if (!Number.isFinite(declared) || declared <= 0) return res.status(411).json({ error: 'Upload size is required.' })
  if (declared > MAX_UPLOAD) return res.status(413).json({ error: `This pack is larger than the ${Math.round(MAX_UPLOAD / 1024 ** 3)} GB per-file limit.` })
  const used = userStorage(req.auth.user.id)
  const quota = Number(req.auth.user.quota_bytes || DEFAULT_QUOTA)
  if (used + declared > quota) return res.status(413).json({ error: 'Your Soren Cloud storage quota is full.' })

  const userDir = path.join(STORAGE_DIR, 'users', String(req.auth.user.id), 'packs')
  await fsp.mkdir(userDir, { recursive: true })
  const id = crypto.randomUUID()
  const ext = path.extname(fileName).toLowerCase()
  const storedName = `${id}${ext}`
  const finalPath = path.join(userDir, storedName)
  const tempPath = `${finalPath}.upload`
  const output = fs.createWriteStream(tempPath, { flags: 'wx' })
  const hash = crypto.createHash('sha256')
  let size = 0
  let failed = false
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_UPLOAD || used + size > quota) throw new Error('Upload exceeded your storage limit.')
      hash.update(chunk)
      if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve))
    }
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()))
    if (size !== declared) throw new Error('Upload ended before the whole file was received.')
    await fsp.rename(tempPath, finalPath)
    const t = now()
    const digest = hash.digest('hex')
    db.prepare('INSERT INTO cloud_files (id,user_id,original_name,stored_name,category,size_bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, req.auth.user.id, fileName, storedName, category, size, digest, t)
    res.json({ ok: true, file: { id, fileName, title: fileName.replace(/\.(zip|rar|7z)$/i, ''), category, size, sha256: digest, uploadedAt: t }, storage: { used: used + size, quota } })
  } catch (error) {
    failed = true
    output.destroy()
    await fsp.rm(tempPath, { force: true }).catch(() => {})
    throw error
  } finally {
    if (!failed && fs.existsSync(tempPath)) await fsp.rm(tempPath, { force: true }).catch(() => {})
  }
}))

app.get(`${API_PREFIX}/cloud/files/:id/download`, requireAuth, asyncRoute(async (req, res) => {
  const file = db.prepare('SELECT * FROM cloud_files WHERE id=? AND user_id=?').get(String(req.params.id), req.auth.user.id)
  if (!file) return res.status(404).json({ error: 'Cloud pack not found.' })
  const full = path.join(STORAGE_DIR, 'users', String(req.auth.user.id), 'packs', file.stored_name)
  const stat = await fsp.stat(full).catch(() => null)
  if (!stat?.isFile()) return res.status(404).json({ error: 'Cloud pack data is missing from the VPS.' })
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Length', stat.size)
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`)
  fs.createReadStream(full).pipe(res)
}))

app.delete(`${API_PREFIX}/cloud/files/:id`, requireAuth, asyncRoute(async (req, res) => {
  const file = db.prepare('SELECT * FROM cloud_files WHERE id=? AND user_id=?').get(String(req.params.id), req.auth.user.id)
  if (!file) return res.status(404).json({ error: 'Cloud pack not found.' })
  const full = path.join(STORAGE_DIR, 'users', String(req.auth.user.id), 'packs', file.stored_name)
  await fsp.rm(full, { force: true }).catch(() => {})
  db.prepare('DELETE FROM cloud_files WHERE id=? AND user_id=?').run(file.id, req.auth.user.id)
  res.json({ ok: true, storage: { used: userStorage(req.auth.user.id), quota: Number(req.auth.user.quota_bytes || DEFAULT_QUOTA) } })
}))

app.get(`${API_PREFIX}/owner/users`, requireAuth, requireOwner, (req, res) => {
  const rows = db.prepare(`
    SELECT u.*,
      (SELECT COALESCE(SUM(cf.size_bytes),0) FROM cloud_files cf WHERE cf.user_id=u.id) AS storage_used,
      (SELECT COUNT(*) FROM cloud_files cf WHERE cf.user_id=u.id) AS cloud_files,
      (SELECT COUNT(*) FROM devices d WHERE d.user_id=u.id) AS device_count,
      (SELECT d.device_hash FROM devices d WHERE d.user_id=u.id ORDER BY d.last_seen_at DESC LIMIT 1) AS last_device_hash,
      (SELECT d.device_name FROM devices d WHERE d.user_id=u.id ORDER BY d.last_seen_at DESC LIMIT 1) AS last_device_name,
      (SELECT d.platform FROM devices d WHERE d.user_id=u.id ORDER BY d.last_seen_at DESC LIMIT 1) AS last_device_platform
    FROM users u ORDER BY COALESCE(u.last_seen_at,u.created_at) DESC
  `).all()
  res.json({ users: rows.map((u) => ({
    id: u.id,
    discordId: u.discord_id,
    username: u.discord_global_name || u.discord_username || 'Unclaimed account',
    discordUsername: u.discord_username,
    avatarUrl: avatarUrl(u),
    role: u.role,
    status: u.status,
    keyMask: maskKey(u.key_hint),
    keyHint: u.key_hint,
    lastIp: u.last_ip,
    createdAt: u.created_at,
    lastSeenAt: u.last_seen_at,
    storageUsed: Number(u.storage_used || 0),
    storageQuota: Number(u.quota_bytes || DEFAULT_QUOTA),
    cloudFiles: Number(u.cloud_files || 0),
    deviceCount: Number(u.device_count || 0),
    deviceHash: u.last_device_hash || null,
    deviceName: u.last_device_name || null,
    devicePlatform: u.last_device_platform || null
  })) })
})

app.use((error, req, res, next) => {
  console.error(error)
  if (res.headersSent) return next(error)
  const status = Number(error.status || 500)
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: status >= 500 ? 'The Soren server could not complete that request.' : error.message })
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Soren Cloud API listening on http://127.0.0.1:${PORT}`)
  console.log(`Public callback: ${PUBLIC_BASE_URL}${API_PREFIX}/auth/discord/callback`)
})
