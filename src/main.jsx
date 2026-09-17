import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Compass, Settings, History, Search, FolderOpen, RotateCw, Download,
  FileArchive, X, Music2, Boxes, Puzzle, Sparkles, TriangleAlert,
  LoaderCircle, CircleCheck, Minus, Square, Info, ShieldCheck,
  ShieldAlert, RefreshCw, ChevronRight, Archive, ScanSearch, Star,
  Upload, HardDrive, RotateCcw, MessageCircle, Play, Activity,
  ListOrdered, DatabaseBackup, Trash2, Plus, Check, Clock3, Cloud, UserRound,
  Copy, LogOut, UsersRound, CloudUpload, CloudDownload, KeyRound, ExternalLink, WifiOff, Wifi, Server
} from 'lucide-react'
import './styles.css'

const ROUTES = [
  { key: 'gtaAudio', label: 'GTA audio', icon: Music2 },
  { key: 'citizen', label: 'Citizen', icon: Boxes },
  { key: 'fivemMod', label: 'FiveM mods', icon: Puzzle },
  { key: 'fivemAddon', label: 'FiveM addons', icon: Sparkles }
]
const ROUTE_LABELS = Object.fromEntries(ROUTES.map((r) => [r.key, r.label]))
const PAGE_SIZE = 12

function friendlyError(error) {
  const raw = error?.message || String(error || 'Unknown error')
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '')
}

function prettyBytes(bytes) {
  if (bytes == null) return 'Unknown'
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = Number(bytes)
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`
}

function validationFor(item) {
  if (item.scanError) return { type: 'error', label: 'Archive unreadable', detail: item.scanError }
  if (item.missingFiles?.length) return { type: 'warn', label: `Missing ${item.missingFiles.join(', ')}`, detail: 'Required pack files are missing.' }
  if (item.category === 'GTA Sounds') return { type: 'ok', label: 'GTA Sounds ready', detail: 'Required audio RPF files found.' }
  if (item.category === 'Blood FX') return { type: 'ok', label: 'Blood FX ready', detail: 'Blood effects and RPF files detected.' }
  if (item.category === 'Graphics packs') return { type: 'ok', label: 'Graphics pack ready', detail: 'Citizen folder detected.' }
  return { type: 'neutral', label: 'Manual routing', detail: 'Soren could not identify a supported automatic layout.' }
}

function formatDate(value) {
  if (!value) return 'Not installed'
  try { return new Date(value).toLocaleString() } catch { return String(value) }
}

function App() {
  const [view, setView] = useState('discover')
  const [catalog, setCatalog] = useState({ categories: [], items: [], packsDir: '' })
  const [settings, setSettings] = useState({})
  const [history, setHistory] = useState([])
  const [favorites, setFavorites] = useState([])
  const [activeSetup, setActiveSetup] = useState({ slots: {} })
  const [queue, setQueue] = useState([])
  const [backups, setBackups] = useState([])
  const [appInfo, setAppInfo] = useState({ name: 'Soren FiveM', version: '3.1.3' })
  const [security, setSecurity] = useState(null)
  const [securityLoading, setSecurityLoading] = useState(true)
  const [category, setCategory] = useState('All')
  const [query, setQuery] = useState('')
  const [loadingCatalog, setLoadingCatalog] = useState(true)
  const [modal, setModal] = useState(null)
  const [toast, setToast] = useState(null)
  const [downloadProgress, setDownloadProgress] = useState(null)
  const [installProgress, setInstallProgress] = useState(null)
  const [pathCheck, setPathCheck] = useState(null)
  const [account, setAccount] = useState(undefined)
  const [authSkipped, setAuthSkipped] = useState(false)
  const [cloudData, setCloudData] = useState({ files: [], storage: { used: 0, quota: 0 } })
  const [cloudProgress, setCloudProgress] = useState(null)
  const [ownerUsers, setOwnerUsers] = useState([])
  const [servers, setServers] = useState([])
  const [serversLoading, setServersLoading] = useState(false)

  const showToast = (message, type = 'success') => {
    setToast({ message, type })
    clearTimeout(showToast.timer)
    showToast.timer = setTimeout(() => setToast(null), 4200)
  }

  const loadAll = async ({ quiet = false } = {}) => {
    if (!quiet) setLoadingCatalog(true)
    try {
      const [c, s, h, info, fav, active, q, b] = await Promise.all([
        window.appAPI.getPacks(),
        window.appAPI.getSettings(),
        window.appAPI.getHistory(),
        window.appAPI.getAppInfo(),
        window.appAPI.getFavorites(),
        window.appAPI.getActiveSetup(),
        window.appAPI.getInstallQueue(),
        window.appAPI.getBackups()
      ])
      setCatalog(c)
      setSettings(s)
      setHistory(h)
      setAppInfo(info)
      setFavorites(fav || [])
      setActiveSetup(active || { slots: {} })
      setQueue(q || [])
      setBackups(b || [])
      if (category !== 'All' && category !== 'Favorites' && !c.categories.includes(category)) setCategory('All')
    } catch (e) {
      showToast(friendlyError(e), 'error')
    } finally {
      if (!quiet) setLoadingCatalog(false)
    }
  }

  const loadAccount = async () => {
    try {
      const me = await window.appAPI.getAccount()
      setAccount(me || null)
      return me || null
    } catch {
      setAccount(null)
      return null
    }
  }

  const loadCloud = async (quiet = true) => {
    if (!account) return
    try {
      const data = await window.appAPI.getCloudFiles()
      setCloudData(data || { files: [], storage: { used: 0, quota: 0 } })
    } catch (e) {
      if (!quiet) showToast(friendlyError(e), 'error')
    }
  }

  const loadOwnerUsers = async () => {
    if (account?.role !== 'owner') return
    try {
      const data = await window.appAPI.getOwnerUsers()
      setOwnerUsers(data?.users || [])
    } catch (e) { showToast(friendlyError(e), 'error') }
  }

  const loadServers = async (quiet = false) => {
    if (!quiet) setServersLoading(true)
    try {
      const data = await window.appAPI.getServers(!quiet)
      setServers(Array.isArray(data) ? data : [])
    } catch (e) {
      if (!quiet) showToast(friendlyError(e), 'error')
    } finally {
      if (!quiet) setServersLoading(false)
    }
  }

  const joinServer = async (server) => {
    try {
      await window.appAPI.joinServer(server.code)
      showToast(`Quick joining ${server.name}`)
    } catch (e) { showToast(friendlyError(e), 'error') }
  }

  const handleSignedIn = async (me) => {
    setAccount(me)
    setAuthSkipped(false)
    setView('discover')
    try {
      const data = await window.appAPI.getCloudFiles()
      setCloudData(data || { files: [], storage: { used: 0, quota: 0 } })
    } catch {}
  }

  const signOut = async () => {
    await window.appAPI.logoutAccount().catch(() => {})
    setAccount(null)
    setCloudData({ files: [], storage: { used: 0, quota: 0 } })
    setOwnerUsers([])
    setView('discover')
  }

  const uploadCloud = async (item, moveAfterUpload = false) => {
    if (!account) return showToast('Sign in to use Soren Cloud', 'warning')
    if (moveAfterUpload && !confirm(`Move ${item.title} to Soren Cloud? The local archive will only be removed after the VPS confirms the upload.`)) return
    try {
      setCloudProgress({ direction: 'upload', fileName: item.fileName, percent: 0 })
      await window.appAPI.uploadPackToCloud({ item, moveAfterUpload })
      await Promise.all([loadAll({ quiet: true }), loadCloud(false)])
      if (moveAfterUpload) setModal(null)
      showToast(moveAfterUpload ? `${item.title} moved to cloud` : `${item.title} uploaded to cloud`)
    } catch (e) { showToast(friendlyError(e), 'error') }
    finally { setTimeout(() => setCloudProgress(null), 700) }
  }

  const downloadCloudLocal = async (file) => {
    try {
      setCloudProgress({ direction: 'download', fileName: file.fileName, percent: 0 })
      await window.appAPI.downloadCloudPack(file)
      await loadAll({ quiet: true })
      showToast(`${file.title} downloaded to Packs`)
    } catch (e) { showToast(friendlyError(e), 'error') }
    finally { setTimeout(() => setCloudProgress(null), 700) }
  }

  const deleteCloud = async (file) => {
    if (!confirm(`Delete ${file.title} from Soren Cloud? This removes the VPS copy.`)) return
    try {
      await window.appAPI.deleteCloudPack(file.id)
      await loadCloud(false)
      showToast('Cloud pack deleted')
    } catch (e) { showToast(friendlyError(e), 'error') }
  }

  const verifySecurity = async (quiet = false) => {
    setSecurityLoading(true)
    try {
      const result = await window.appAPI.verifyIntegrity()
      setSecurity(result)
      if (!quiet) showToast(result.status === 'verified' ? 'Release integrity verified' : 'Integrity check found changes', result.status === 'verified' ? 'success' : 'error')
    } catch (e) {
      setSecurity({ status: 'unavailable', message: friendlyError(e) })
      if (!quiet) showToast(friendlyError(e), 'error')
    } finally { setSecurityLoading(false) }
  }

  useEffect(() => {
    loadAll()
    verifySecurity(true)
    loadAccount().then((me) => {
      if (me) window.appAPI.getCloudFiles().then((data) => setCloudData(data || { files: [], storage: { used: 0, quota: 0 } })).catch(() => {})
    })
    const stopCloud = window.appAPI.onCloudProgress((data) => setCloudProgress(data))
    const stopDownload = window.appAPI.onDownloadProgress((data) => setDownloadProgress(data))
    const stopInstall = window.appAPI.onInstallProgress((data) => setInstallProgress(data))
    const stopPacks = window.appAPI.onPacksChanged(() => loadAll({ quiet: true }))
    return () => { stopCloud?.(); stopDownload?.(); stopInstall?.(); stopPacks?.() }
  }, [])

  useEffect(() => {
    if (account && view === 'cloud') loadCloud(true)
    if (account?.role === 'owner' && view === 'owner') loadOwnerUsers()
  }, [view, account?.id])

  useEffect(() => {
    if (view !== 'servers') return
    loadServers(false)
    const timer = setInterval(() => loadServers(true), 30000)
    return () => clearInterval(timer)
  }, [view])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const fav = new Set(favorites)
    return [...catalog.items]
      .filter((item) => (category === 'All' || (category === 'Favorites' ? fav.has(item.id) : item.category === category)) && (!q || item.title.toLowerCase().includes(q) || item.fileName.toLowerCase().includes(q)))
      .sort((a, b) => Number(fav.has(b.id)) - Number(fav.has(a.id)) || a.title.localeCompare(b.title))
  }, [catalog.items, category, query, favorites])

  const launchFiveM = async () => {
    try {
      await window.appAPI.launchFiveM()
      showToast('Launching FiveM')
    } catch (e) { showToast(friendlyError(e), 'error') }
  }

  const verifyPaths = async () => {
    try {
      const result = await window.appAPI.verifyPaths()
      setPathCheck(result)
      showToast(result.ok ? 'FiveM paths verified' : 'Some paths need attention', result.ok ? 'success' : 'warning')
    } catch (e) { showToast(friendlyError(e), 'error') }
  }

  const toggleFavorite = async (item) => {
    try {
      const next = await window.appAPI.setFavorite(item.id, !favorites.includes(item.id))
      setFavorites(next)
    } catch (e) { showToast(friendlyError(e), 'error') }
  }

  const addToQueue = async (item) => {
    try {
      const next = await window.appAPI.addInstallQueueItem(item)
      setQueue(next)
      showToast(`${item.title} added to queue`)
    } catch (e) { showToast(friendlyError(e), 'error') }
  }

  const removeFromQueue = async (itemId) => {
    try { setQueue(await window.appAPI.removeInstallQueueItem(itemId)) }
    catch (e) { showToast(friendlyError(e), 'error') }
  }

  const clearQueue = async () => {
    if (!queue.length || !confirm('Clear the install queue?')) return
    try { setQueue(await window.appAPI.clearInstallQueue()) }
    catch (e) { showToast(friendlyError(e), 'error') }
  }

  const preparePack = async (item) => {
    if (item.scanError) {
      setModal({ stage: 'archive-error', item, errorMessage: item.scanError })
      return
    }
    if (item.missingFiles?.length) {
      setModal({ stage: 'missing-files', item, missingFiles: item.missingFiles })
      return
    }
    setDownloadProgress({ jobId: null, percent: item.localPath ? 100 : 0, received: 0, total: 0 })
    setInstallProgress(null)
    setModal({ stage: 'preparing', item })
    try {
      const prepared = await window.appAPI.prepareInstall(item)
      if (prepared.missingFiles?.length) {
        setModal({ stage: 'missing-files', item, missingFiles: prepared.missingFiles, prepared })
        return
      }
      setModal({ stage: 'ready', item, prepared, selectedRoute: prepared.routing.suggested || '' })
    } catch (e) {
      const message = friendlyError(e)
      if (/corrupt|incomplete|archive/i.test(message)) setModal({ stage: 'archive-error', item, errorMessage: message })
      else { setModal(null); showToast(message, 'error') }
    } finally { setDownloadProgress(null) }
  }

  const openPack = (item) => setModal({ stage: 'details', item })

  const closeModal = async () => {
    if (modal?.prepared?.jobId) await window.appAPI.cancelPrepared(modal.prepared.jobId)
    setModal(null)
    setDownloadProgress(null)
    setInstallProgress(null)
  }

  const installPrepared = async (replaceExisting = false, ignoreDiskWarning = false) => {
    if (!modal?.prepared) return
    const prepared = modal.prepared
    const item = modal.item
    const selectedRoute = modal.selectedRoute
    setInstallProgress({ jobId: prepared.jobId, stage: 'Starting install', percent: 1 })
    setModal((m) => ({ ...m, stage: 'installing', diskConfirmed: ignoreDiskWarning || m?.diskConfirmed }))
    try {
      const result = await window.appAPI.confirmInstall({ jobId: prepared.jobId, selectedRoute, replaceExisting, ignoreDiskWarning })
      if (result?.needsDiskConfirmation) {
        setModal((m) => ({ ...m, stage: 'disk-warning', diskCheck: result.diskCheck, canContinue: result.canContinue, diskConfirmed: false }))
        return
      }
      if (result?.needsOverwriteConfirmation) {
        setModal((m) => ({ ...m, stage: 'overwrite', overwrite: result, diskConfirmed: ignoreDiskWarning || m?.diskConfirmed }))
        return
      }
      const nextQueue = await window.appAPI.removeInstallQueueItem(item.id).catch(() => queue)
      setQueue(nextQueue || [])
      await loadAll({ quiet: true })
      setModal({ stage: 'done', item, result, nextQueue: nextQueue || [] })
      showToast(`${item.title} installed`)
    } catch (e) {
      const message = friendlyError(e)
      if (/administrator|blocked access|permission/i.test(message)) setModal((m) => ({ ...m, stage: 'admin-warning', errorMessage: message }))
      else if (/missing required/i.test(message)) setModal((m) => ({ ...m, stage: 'missing-files', missingFiles: message.replace(/^.*?:\s*/, '').split(/,\s*/), errorMessage: message }))
      else { setModal((m) => ({ ...m, stage: 'ready' })); showToast(message, 'error') }
    }
  }

  const restoreVanilla = async () => {
    if (!confirm('Restore files managed by Soren back to their vanilla backups? Your pack archives will stay in the Packs folder.')) return
    try {
      const result = await window.appAPI.restoreVanilla()
      await loadAll({ quiet: true })
      showToast(`Vanilla restored · ${result.removed} managed files removed · ${result.restored} backups restored`)
    } catch (e) { showToast(friendlyError(e), 'error') }
  }

  const restoreBackup = async (backup) => {
    if (!confirm(`Restore the backup from ${backup.title}? This will replace the current files affected by that install.`)) return
    try {
      const result = await window.appAPI.restoreBackup(backup.id)
      await loadAll({ quiet: true })
      showToast(`${result.title} backup restored`)
    } catch (e) { showToast(friendlyError(e), 'error') }
  }

  const deleteBackup = async (backup) => {
    if (!confirm(`Delete the backup for ${backup.title}? This cannot be undone.`)) return
    try {
      setBackups(await window.appAPI.deleteBackup(backup.id))
      showToast('Backup deleted')
    } catch (e) { showToast(friendlyError(e), 'error') }
  }

  const installNextQueue = () => {
    if (!queue.length) return
    preparePack(queue[0])
  }

  if (account === undefined) return <div className="app-shell"><TitleBar/><div className="auth-shell loading"><LoaderCircle size={24} className="spin"/><span>Checking Soren account…</span></div></div>
  if (!account && !authSkipped) return <div className="app-shell"><TitleBar/><WelcomeGate onSignedIn={handleSignedIn} onOffline={() => setAuthSkipped(true)} /></div>

  return <div className="app-shell">
    <TitleBar />
    <div className="workspace">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo mono-logo" src="./soren-logo.png" alt=""/>
          <div className="brand-copy"><strong>Soren</strong><span>FiveM manager</span></div>
        </div>
        <nav>
          <NavButton active={view === 'discover'} icon={Compass} label="Library" onClick={() => setView('discover')} />
          <NavButton active={view === 'servers'} icon={Server} label="Servers" onClick={() => setView('servers')} />
          <NavButton active={view === 'cloud'} icon={Cloud} label="Cloud" onClick={() => account ? setView('cloud') : setAuthSkipped(false)} />
          <NavButton active={view === 'activity'} icon={Activity} label="Activity" badge={queue.length || null} onClick={() => setView('activity')} />
          <NavButton active={view === 'account' || view === 'owner'} icon={UserRound} label="Account" onClick={() => account ? setView('account') : setAuthSkipped(false)} />
          <NavButton active={view === 'settings'} icon={Settings} label="Settings" onClick={() => setView('settings')} />
        </nav>
        <div className="sidebar-bottom">
          <button className="sidebar-action strong" onClick={launchFiveM}><Play size={14}/>Launch FiveM</button>
          <button className="sidebar-profile" onClick={() => account ? setView('account') : setAuthSkipped(false)}>
            {account ? <img src={account.avatarUrl || './soren-logo.png'} alt=""/> : <div className="sidebar-profile-fallback"><UserRound size={15}/></div>}
            <div><strong>{account?.username || 'Sign in'}</strong><span>{account ? (account.role === 'owner' ? 'Owner' : 'Connected') : 'Soren Cloud'}</span></div>
            <ChevronRight size={14}/>
          </button>
        </div>
      </aside>

      <main className="main"><div className="view-stage" key={view}>
        {view === 'discover' && <Discover catalog={catalog} items={filtered} favorites={favorites} toggleFavorite={toggleFavorite} category={category} setCategory={setCategory} query={query} setQuery={setQuery} openPack={openPack} loading={loadingCatalog} reload={() => loadAll()} showToast={showToast} activeSetup={activeSetup} restoreVanilla={restoreVanilla} />}
        {view === 'servers' && <ServersView servers={servers} loading={serversLoading} refresh={() => loadServers(false)} join={joinServer} />}
        {view === 'cloud' && account && <CloudView data={cloudData} install={preparePack} download={downloadCloudLocal} remove={deleteCloud} reload={() => loadCloud(false)} />}
        {view === 'activity' && <ActivityView queue={queue} history={history} backups={backups} installNext={installNextQueue} removeQueue={removeFromQueue} clearQueue={clearQueue} restoreBackup={restoreBackup} deleteBackup={deleteBackup} />}
        {view === 'settings' && <SettingsView settings={settings} packsDir={catalog.packsDir} reload={() => loadAll({ quiet: true })} showToast={showToast} restoreVanilla={restoreVanilla} verifyPaths={verifyPaths} pathCheck={pathCheck} appInfo={appInfo} security={security} securityLoading={securityLoading} verifySecurity={verifySecurity} />}
        {view === 'account' && account && <AccountView account={account} storage={cloudData.storage} signOut={signOut} openOwner={() => { setView('owner'); setTimeout(loadOwnerUsers, 0) }} />}
        {view === 'owner' && account?.role === 'owner' && <OwnerView users={ownerUsers} reload={loadOwnerUsers} back={() => setView('account')} />}
      </div></main>
    </div>

    {modal && <InstallModal modal={modal} setModal={setModal} close={closeModal} prepare={preparePack} install={installPrepared} addToQueue={addToQueue} downloadProgress={downloadProgress} installProgress={installProgress} settings={settings} account={account} uploadCloud={uploadCloud} />}
    {cloudProgress && <div className="cloud-transfer"><Cloud size={14}/><div><strong>{cloudProgress.direction === 'upload' ? 'Uploading to cloud' : 'Downloading from cloud'}</strong><span>{cloudProgress.fileName || 'Pack'}{cloudProgress.percent != null ? ` · ${cloudProgress.percent}%` : ''}</span></div></div>}
    {toast && <div className={`toast ${toast.type}`}>
      {toast.type === 'error' ? <TriangleAlert size={16}/> : toast.type === 'warning' ? <ShieldAlert size={16}/> : <CircleCheck size={16}/>}<span>{toast.message}</span>
    </div>}
  </div>
}

function TitleBar() {
  return <div className="titlebar" onDoubleClick={(e) => { if (!e.target.closest('button')) window.appAPI.toggleMaximizeWindow() }}>
    <div className="titlebar-identity"><img className="mono-logo" src="./soren-logo.png" alt=""/><span>Soren FiveM</span></div>
    <div className="window-actions">
      <button className="window-btn" title="Minimize" onClick={() => window.appAPI.minimizeWindow()}><Minus size={14}/></button>
      <button className="window-btn" title="Maximize" onClick={() => window.appAPI.toggleMaximizeWindow()}><Square size={11}/></button>
      <button className="window-btn close" title="Close" onClick={() => window.appAPI.closeWindow()}><X size={14}/></button>
    </div>
  </div>
}

function NavButton({ active, icon: Icon, label, badge, onClick }) {
  return <button className={`nav-btn ${active ? 'active' : ''}`} onClick={onClick}><Icon size={17}/><span>{label}</span>{badge ? <b>{badge}</b> : null}</button>
}

function PageHead({ title, description, action }) {
  return <header className="page-head"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</header>
}

function Discover({ catalog, items, favorites, toggleFavorite, category, setCategory, query, setQuery, openPack, loading, reload, showToast, activeSetup, restoreVanilla }) {
  const [page, setPage] = useState(1)
  const [dragging, setDragging] = useState(false)
  const [adding, setAdding] = useState(false)
  const [showActive, setShowActive] = useState(false)
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const first = (safePage - 1) * PAGE_SIZE
  const pageItems = items.slice(first, first + PAGE_SIZE)
  const last = Math.min(first + pageItems.length, items.length)
  const totalSize = catalog.items.reduce((n, i) => n + (i.size || 0), 0)
  const activeNames = ['graphics', 'bloodfx', 'gtasounds'].map((key) => activeSetup?.slots?.[key]?.title).filter(Boolean)
  useEffect(() => setPage(1), [category, query])
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [page, pageCount])
  const changePage = (next) => {
    setPage(Math.max(1, Math.min(pageCount, next)))
    document.querySelector('.main')?.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const tabs = ['All', ...(favorites.length ? ['Favorites'] : []), ...catalog.categories]
  const addFile = async (file) => {
    if (!file || adding) return
    setAdding(true)
    try {
      const sourcePath = window.appAPI.getPathForFile(file)
      const result = await window.appAPI.addPackPath(sourcePath)
      if (result) { showToast(`${result.fileName} added to Packs`); await reload() }
    } catch (e) { showToast(friendlyError(e), 'error') }
    finally { setAdding(false) }
  }
  const choose = async () => {
    if (adding) return
    setAdding(true)
    try {
      const result = await window.appAPI.choosePackFile()
      if (result) { showToast(`${result.fileName} added to Packs`); await reload() }
    } catch (e) { showToast(friendlyError(e), 'error') }
    finally { setAdding(false) }
  }

  return <div className="library-shell"
    onDragEnter={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragging(true) } }}
    onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault() }}
    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false) }}
    onDrop={(e) => { e.preventDefault(); setDragging(false); addFile(e.dataTransfer.files?.[0]) }}>
    <PageHead title="Library" description="Your local FiveM packs." action={<div className="head-actions"><button className="text-btn library-add" onClick={choose} disabled={adding}>{adding ? <LoaderCircle size={14} className="spin"/> : <Plus size={14}/>}Add pack</button><button className="text-btn" onClick={() => window.appAPI.openPacksFolder()}><FolderOpen size={14}/>Open folder</button><button className="icon-btn ghost" title="Scan again" onClick={reload}><RotateCw size={15}/></button></div>} />

    <div className={`active-summary ${showActive ? 'open' : ''}`}>
      <button className="active-summary-main" onClick={() => setShowActive((v) => !v)}>
        <span>Active</span><strong>{activeNames.length ? activeNames.join(' · ') : 'Nothing installed'}</strong><small>{showActive ? 'Hide' : 'Manage'}</small>
      </button>
      {showActive && <div className="active-inline">
        {[['graphics','Graphics'],['bloodfx','Blood FX'],['gtasounds','GTA Sounds']].map(([key,label]) => <div key={key}><span>{label}</span><strong>{activeSetup?.slots?.[key]?.title || 'None'}</strong></div>)}
        <button className="text-btn" onClick={restoreVanilla}><RotateCcw size={14}/>Restore vanilla</button>
      </div>}
    </div>

    <div className="toolbar"><label className="search"><Search size={16}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search packs"/></label><span className="count">{catalog.items.length} packs · {prettyBytes(totalSize)}</span></div>
    <div className="category-tabs">{tabs.map((c) => <button key={c} className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>{c}</button>)}</div>
    {loading ? <div className="empty-state"><LoaderCircle className="spin" size={20}/><span>Scanning Packs folder…</span></div> : items.length ? <>
      <div className="list-meta">{first + 1}–{last} of {items.length}</div>
      <div className="pack-grid">{pageItems.map((item, index) => <PackCard key={item.id} item={item} favorite={favorites.includes(item.id)} onFavorite={() => toggleFavorite(item)} onOpen={() => openPack(item)} index={index} />)}</div>
      {pageCount > 1 && <div className="pagination"><button disabled={safePage === 1} onClick={() => changePage(safePage - 1)}>‹</button><span>{safePage} / {pageCount}</span><button disabled={safePage === pageCount} onClick={() => changePage(safePage + 1)}>›</button></div>}
    </> : <div className="empty-state tall"><Archive size={23}/><h3>No packs found</h3><span>Drop a ZIP, RAR or 7Z anywhere on this page, or choose Add pack.</span></div>}

    {dragging && <div className="library-drop-overlay"><Upload size={28}/><strong>Drop to add to Soren</strong><span>ZIP · RAR · 7Z</span></div>}
  </div>
}
function PackCard({ item, favorite, onFavorite, onOpen, index }) {
  const Icon = item.category === 'Graphics packs' ? Boxes : item.category === 'GTA Sounds' ? Music2 : Archive
  const validation = validationFor(item)
  const ext = String(item.fileName || '').split('.').pop()?.toUpperCase() || 'ARCHIVE'
  return <div className={`pack-tile ${item.scanError ? 'has-error' : ''}`} style={{ '--delay': `${Math.min(index, 8) * 22}ms` }} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}>
    <div className="pack-icon"><Icon size={20}/></div>
    <div className="pack-copy">
      <div className="pack-title-row"><strong>{item.title}</strong><button className={`favorite-btn ${favorite ? 'active' : ''}`} title={favorite ? 'Remove favorite' : 'Favorite'} onClick={(e) => { e.stopPropagation(); onFavorite() }}><Star size={14} fill={favorite ? 'currentColor' : 'none'}/></button><ChevronRight size={14} className="pack-chevron"/></div>
      <div className="pack-type-row"><span>{item.category}</span><span>{ext}</span></div>
      <div className="pack-footer"><span className={`pack-validation ${validation.type}`}><span className={`validation-dot ${validation.type}`}/>{validation.label}</span><span className="pack-size">{prettyBytes(item.size)}</span></div>
    </div>
  </div>
}

function DropView({ reload, showToast }) {
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const addFile = async (file) => {
    if (!file || busy) return
    setBusy(true)
    try {
      const sourcePath = window.appAPI.getPathForFile(file)
      const result = await window.appAPI.addPackPath(sourcePath)
      if (result) { showToast(`${result.fileName} added to Packs`); await reload() }
    } catch (e) { showToast(friendlyError(e), 'error') }
    finally { setBusy(false) }
  }
  const choose = async () => {
    setBusy(true)
    try {
      const result = await window.appAPI.choosePackFile()
      if (result) { showToast(`${result.fileName} added to Packs`); await reload() }
    } catch (e) { showToast(friendlyError(e), 'error') }
    finally { setBusy(false) }
  }
  return <>
    <PageHead title="Drag & Drop" description="Add an archive without moving the original file."/>
    <div className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragEnter={(e) => { e.preventDefault(); setDragging(true) }} onDragOver={(e) => e.preventDefault()} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false) }} onDrop={(e) => { e.preventDefault(); setDragging(false); addFile(e.dataTransfer.files?.[0]) }}>
      {busy ? <LoaderCircle size={27} className="spin"/> : <Upload size={28}/>}<h2>{busy ? 'Adding pack…' : 'Drop your pack here'}</h2><p>Soren copies it into the Packs folder. Your original file stays where it is.</p><span>ZIP · RAR · 7Z</span><button className="primary-btn" onClick={choose} disabled={busy}>Choose archive</button>
    </div>
  </>
}

function ActiveSetupView({ activeSetup, launchFiveM, restoreVanilla }) {
  const rows = [
    ['graphics', 'Graphics', Boxes],
    ['bloodfx', 'Blood FX', Archive],
    ['gtasounds', 'GTA Sounds', Music2]
  ]
  return <>
    <PageHead title="Active Setup" description="What Soren currently has installed." action={<button className="primary-btn" onClick={launchFiveM}><Play size={14}/>Launch FiveM</button>} />
    <div className="active-list">
      {rows.map(([key, label, Icon]) => {
        const slot = activeSetup?.slots?.[key]
        return <div className="active-row" key={key}><Icon size={18}/><div><span>{label}</span><strong>{slot?.title || 'Nothing installed'}</strong></div><small>{slot?.installedAt ? formatDate(slot.installedAt) : '—'}</small></div>
      })}
    </div>
    <div className="quiet-actions"><button className="secondary-btn" onClick={restoreVanilla}><RotateCcw size={14}/>Restore Vanilla</button></div>
  </>
}

function ActivityView({ queue, history, backups, installNext, removeQueue, clearQueue, restoreBackup, deleteBackup }) {
  const [section, setSection] = useState('queue')
  return <>
    <PageHead title="Activity" description="Installs, history and recovery." />
    <div className="activity-tabs">
      <button className={section === 'queue' ? 'active' : ''} onClick={() => setSection('queue')}>Queue{queue.length ? ` ${queue.length}` : ''}</button>
      <button className={section === 'history' ? 'active' : ''} onClick={() => setSection('history')}>History</button>
      <button className={section === 'backups' ? 'active' : ''} onClick={() => setSection('backups')}>Backups</button>
    </div>
    {section === 'queue' && <QueueView embedded queue={queue} installNext={installNext} remove={removeQueue} clear={clearQueue}/>} 
    {section === 'history' && <HistoryView embedded history={history}/>} 
    {section === 'backups' && <BackupView embedded backups={backups} restore={restoreBackup} remove={deleteBackup}/>} 
  </>
}

function QueueView({ queue, installNext, remove, clear, embedded = false }) {
  return <>
    {!embedded && <PageHead title="Install Queue" description="Line up packs and install them one at a time." action={queue.length ? <button className="primary-btn" onClick={installNext}><Play size={14}/>Install next</button> : null} />}
    {embedded && queue.length ? <div className="activity-action"><button className="primary-btn" onClick={installNext}><Play size={14}/>Install next</button></div> : null}
    {!queue.length ? <div className="empty-state tall"><ListOrdered size={23}/><h3>Queue is empty</h3><span>Open a pack and choose Add to queue.</span></div> : <>
      <div className="simple-list">{queue.map((item, i) => <div className="simple-row" key={item.id}><span className="row-index">{String(i + 1).padStart(2, '0')}</span><div className="row-copy"><strong>{item.title}</strong><span>{item.category} · {prettyBytes(item.size)}</span></div>{item.missingFiles?.length ? <span className="status-text warn">Missing files</span> : <span className="status-text">Ready</span>}<button className="icon-btn ghost" title="Remove" onClick={() => remove(item.id)}><X size={14}/></button></div>)}</div>
      <div className="quiet-actions"><button className="text-btn danger" onClick={clear}>Clear queue</button></div>
    </>}
  </>
}

function BackupView({ backups, restore, remove, embedded = false }) {
  return <>
    {!embedded && <PageHead title="Backup Manager" description="Backups Soren created before replacing files."/>}
    {!backups.length ? <div className="empty-state tall"><DatabaseBackup size={23}/><h3>No backups yet</h3><span>Backups appear here after installing packs.</span></div> : <div className="simple-list backup-list">{backups.map((backup) => <div className="simple-row backup-row" key={backup.id}>
      <DatabaseBackup size={17}/><div className="row-copy"><strong>{backup.title}</strong><span>{backup.category} · {formatDate(backup.createdAt)} · {prettyBytes(backup.size)}</span></div>
      <button className="text-btn" onClick={() => window.appAPI.openPath(backup.path)}>Open</button>
      <button className="text-btn" disabled={!backup.canRestore} title={backup.canRestore ? 'Restore this backup' : 'Legacy backup: open or delete only'} onClick={() => restore(backup)}>Restore</button>
      <button className="icon-btn ghost danger" title="Delete backup" onClick={() => remove(backup)}><Trash2 size={14}/></button>
    </div>)}</div>}
  </>
}


function WelcomeGate({ onSignedIn, onOffline }) {
  const [mode, setMode] = useState('home')
  const [key, setKey] = useState('')
  const [discordId, setDiscordId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [inviteOpened, setInviteOpened] = useState(false)

  const generate = async () => {
    setBusy(true); setError(''); setStatus('')
    try {
      const result = await window.appAPI.generateAccountKey()
      setKey(result.key || '')
      setMode('create')
    } catch (e) { setError(friendlyError(e)) }
    finally { setBusy(false) }
  }

  const signIn = async () => {
    setBusy(true); setError('')
    try {
      const me = await window.appAPI.loginAccount({ key, discordId })
      onSignedIn(me)
    } catch (e) {
      const message = friendlyError(e)
      setError(message)
      if (/join the soren discord/i.test(message)) await window.appAPI.openSignupDiscord().catch(() => {})
    } finally { setBusy(false) }
  }

  const pollClaim = async () => {
    let openedInvite = inviteOpened
    for (let i = 0; i < 48; i++) {
      const result = await window.appAPI.checkAccountClaim({ key, discordId })
      if (result.status === 'active') {
        const me = await window.appAPI.loginAccount({ key, discordId })
        onSignedIn(me)
        return true
      }
      if (result.needsJoin) {
        setStatus('Join the Soren Discord to finish signup. Soren will keep checking automatically.')
        if (!openedInvite) {
          openedInvite = true
          setInviteOpened(true)
          await window.appAPI.openSignupDiscord().catch(() => {})
        }
      } else {
        setStatus('Finish the Discord verification in your browser, then return here.')
      }
      await new Promise((resolve) => setTimeout(resolve, 2500))
    }
    setStatus('Still waiting for verification. You can press Check again after joining Discord.')
    return false
  }

  const beginClaim = async () => {
    setBusy(true); setError(''); setStatus('Opening Discord verification…')
    try {
      await window.appAPI.beginDiscordClaim({ key, discordId })
      await pollClaim()
    } catch (e) { setError(friendlyError(e)) }
    finally { setBusy(false) }
  }

  const checkAgain = async () => {
    setBusy(true); setError('')
    try { await pollClaim() } catch (e) { setError(friendlyError(e)) }
    finally { setBusy(false) }
  }

  return <div className="auth-shell">
    <div className="auth-panel">
      <img className="auth-logo mono-logo" src="./soren-logo.png" alt=""/>
      {mode === 'home' && <>
        <h1>Welcome to Soren</h1>
        <p>Sign in to keep packs in Soren Cloud, or create a new account.</p>
        <div className="auth-actions"><button className="primary-btn wide" onClick={() => setMode('signin')}><KeyRound size={15}/>Sign in</button><button className="secondary-btn wide" onClick={generate} disabled={busy}>{busy ? <LoaderCircle size={15} className="spin"/> : <UserRound size={15}/>}Generate account key</button></div>
        <button className="text-btn offline-link" onClick={onOffline}><WifiOff size={13}/>Use Soren locally</button>
      </>}

      {mode === 'signin' && <>
        <button className="auth-back" onClick={() => { setMode('home'); setError('') }}>← Back</button>
        <h1>Sign in</h1><p>Use the Discord ID linked to your Soren key.</p>
        <label className="auth-field"><span>Discord ID</span><input value={discordId} onChange={(e) => setDiscordId(e.target.value.replace(/\D/g, '').slice(0,22))} placeholder="123456789012345678"/></label>
        <label className="auth-field"><span>Soren key</span><input value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="SRN-XXXX-XXXX-XXXX-XXXX"/></label>
        {error && <div className="auth-error"><TriangleAlert size={14}/>{error}</div>}
        <button className="primary-btn wide" disabled={busy || !key || !discordId} onClick={signIn}>{busy ? <LoaderCircle size={15} className="spin"/> : <KeyRound size={15}/>}Sign in</button>
      </>}

      {mode === 'create' && <>
        <button className="auth-back" onClick={() => { setMode('home'); setError(''); setStatus('') }}>← Back</button>
        <h1>Your Soren key</h1><p>Save this key. You will use it with your Discord ID to sign in.</p>
        <div className="generated-key"><code>{key || 'Generating…'}</code><button className="icon-btn" title="Copy key" onClick={() => window.appAPI.copyText(key)}><Copy size={15}/></button></div>
        <label className="auth-field"><span>Discord ID</span><input value={discordId} onChange={(e) => setDiscordId(e.target.value.replace(/\D/g, '').slice(0,22))} placeholder="Paste your Discord user ID"/></label>
        {status && <div className="auth-status"><MessageCircle size={14}/><span>{status}</span></div>}
        {error && <div className="auth-error"><TriangleAlert size={14}/>{error}</div>}
        <button className="primary-btn wide" disabled={busy || !key || !discordId} onClick={beginClaim}>{busy ? <LoaderCircle size={15} className="spin"/> : <ExternalLink size={15}/>}Verify with Discord</button>
        {status && !busy && <button className="secondary-btn wide" onClick={checkAgain}>Check again</button>}
      </>}
    </div>
  </div>
}

function ServersView({ servers, loading, refresh, join }) {
  const [expanded, setExpanded] = useState(null)
  const [brokenIcons, setBrokenIcons] = useState({})
  return <>
    <PageHead title="Servers" action={<button className="icon-btn" title="Refresh servers" onClick={refresh} disabled={loading}>{loading ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>}</button>} />
    {loading && !servers.length ? <div className="empty-state tall"><LoaderCircle size={20} className="spin"/></div> : <div className="server-list">
      {servers.map((server) => {
        const online = server.online !== false
        const hasNames = Array.isArray(server.players) && server.players.length > 0
        const count = server.clients == null ? '—' : server.maxClients ? `${server.clients} / ${server.maxClients}` : `${server.clients}`
        const title = server.title || server.hostname || server.name
        const showIcon = Boolean(server.iconUrl && !brokenIcons[server.code])
        const initials = String(title || server.name || 'S').replace(/[^a-z0-9 ]/gi, ' ').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'S'
        return <div className="server-entry" key={server.code}>
          <div className="server-row">
            <div className="server-logo" aria-hidden="true">
              {showIcon ? <img src={server.iconUrl} alt="" onError={() => setBrokenIcons((current) => ({ ...current, [server.code]: true }))}/> : <span>{initials}</span>}
            </div>
            <div className="server-copy"><strong title={title}>{title}</strong></div>
            <button className={`server-player-count ${online ? 'online' : ''}`} onClick={() => hasNames && setExpanded(expanded === server.code ? null : server.code)} disabled={!hasNames} title={hasNames ? 'Show current players' : online ? 'Player list unavailable' : 'Server unavailable'}>
              {online ? <Wifi size={14}/> : <WifiOff size={14}/>}<strong>{count}</strong>
            </button>
            <button className="primary-btn server-join" onClick={() => join(server)} disabled={!online}><Play size={14}/>Join</button>
          </div>
          {expanded === server.code && hasNames && <div className="server-players">
            <div className="server-player-names">{server.players.slice(0, 80).map((player, index) => <span key={`${server.code}-${player.id ?? index}-${player.name}`}>{player.name}</span>)}</div>
          </div>}
        </div>
      })}
      {!servers.length && !loading && <div className="empty-state tall"><Server size={22}/><h3>No servers available</h3></div>}
    </div>}
  </>
}

function CloudView({ data, install, download, remove, reload }) {
  const files = data?.files || []
  const storage = data?.storage || { used: 0, quota: 0 }
  const percent = storage.quota ? Math.min(100, Math.round((storage.used / storage.quota) * 100)) : 0
  return <>
    <PageHead title="Soren Cloud" description="Keep pack archives on your VPS instead of your PC." action={<button className="text-btn" onClick={reload}><RefreshCw size={14}/>Refresh</button>} />
    <div className="cloud-usage"><div><strong>{prettyBytes(storage.used)} used</strong><span>{prettyBytes(storage.quota)} available to your account</span></div><span>{percent}%</span></div>
    <div className="cloud-usage-track"><div style={{ width: `${percent}%` }}/></div>
    {!files.length ? <div className="empty-state tall"><Cloud size={24}/><h3>No cloud packs yet</h3><span>Open a local pack and choose Upload or Move to cloud.</span></div> : <div className="cloud-list">{files.map((file) => {
      const item = { ...file, id: `cloud:${file.id}`, cloudFileId: file.id, previewType: 'none' }
      return <div className="cloud-row" key={file.id}><Cloud size={18}/><div className="row-copy"><strong>{file.title}</strong><span>{file.category} · {prettyBytes(file.size)} · {formatDate(file.uploadedAt)}</span></div><button className="text-btn" onClick={() => install(item)}><Play size={13}/>Install</button><button className="text-btn" onClick={() => download(file)}><CloudDownload size={13}/>Local copy</button><button className="icon-btn ghost" title="Delete cloud copy" onClick={() => remove(file)}><Trash2 size={14}/></button></div>
    })}</div>}
  </>
}

function AccountView({ account, storage, signOut, openOwner }) {
  const used = storage?.used ?? account.storage?.used ?? 0
  const quota = storage?.quota ?? account.storage?.quota ?? 0
  return <>
    <PageHead title="Account" description="Your Soren Cloud identity." action={account.role === 'owner' ? <button className="text-btn" onClick={openOwner}><UsersRound size={14}/>Owner panel</button> : null} />
    <div className="account-profile"><img src={account.avatarUrl || './soren-logo.png'} alt=""/><div><h2>{account.username}</h2><p>Discord connected · {account.role === 'owner' ? 'Owner' : 'Soren user'}</p></div></div>
    <section className="plain-section account-details"><InfoRow label="Discord ID" value={account.discordId || 'Not linked'}/><InfoRow label="Account key" value={account.keyMask || 'Hidden'}/><InfoRow label="Cloud storage" value={`${prettyBytes(used)} / ${prettyBytes(quota)}`}/><InfoRow label="Status" value={account.status || 'active'}/></section>
    <div className="account-actions"><button className="secondary-btn" onClick={() => window.appAPI.openDiscord()}><MessageCircle size={14}/>Open Discord</button><button className="secondary-btn" onClick={signOut}><LogOut size={14}/>Sign out</button></div>
  </>
}

function OwnerView({ users, reload, back }) {
  const [selectedUser, setSelectedUser] = useState(null)
  return <>
    <PageHead title="Owner" description="Discord accounts connected to Soren." action={<div className="head-actions"><button className="text-btn" onClick={back}>Back to account</button><button className="text-btn" onClick={reload}><RefreshCw size={14}/>Refresh</button></div>} />
    {!users.length ? <div className="empty-state tall"><UsersRound size={22}/><h3>No accounts found</h3><span>Verified users will appear here.</span></div> : <div className="owner-list">{users.map((user) => <div className="owner-user" key={user.id}>
      <img src={user.avatarUrl || './soren-logo.png'} alt=""/>
      <div className="owner-user-copy">
        <button className="owner-user-name" onClick={() => setSelectedUser(user)}>{user.username}</button>
        <span>{user.discordUsername ? `@${user.discordUsername}` : 'Discord not linked'}</span>
      </div>
    </div>)}</div>}
    {selectedUser && <OwnerUserPopup user={selectedUser} close={() => setSelectedUser(null)} />}
  </>
}

function OwnerUserPopup({ user, close }) {
  return <div className="owner-popup-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
    <div className="owner-popup" role="dialog" aria-modal="true" aria-label={`${user.username} account information`}>
      <div className="owner-popup-head">
        <div className="owner-popup-user">
          <img src={user.avatarUrl || './soren-logo.png'} alt=""/>
          <div><h2>{user.username}</h2><span>{user.discordUsername ? `@${user.discordUsername}` : 'Discord not linked'} · {user.status || 'unknown'}</span></div>
        </div>
        <button className="icon-btn ghost" title="Close" onClick={close}><X size={16}/></button>
      </div>
      <div className="owner-popup-details">
        <InfoRow label="Discord ID" value={user.discordId || 'Not linked'}/>
        <InfoRow label="Account role" value={user.role || 'user'}/>
        <InfoRow label="Account key" value={user.keyMask || 'Hidden'}/>
        <InfoRow label="Status" value={user.status || 'Unknown'}/>
        <InfoRow label="Last IP" value={user.lastIp || '—'}/>
        <InfoRow label="Cloud storage" value={`${prettyBytes(user.storageUsed)} / ${prettyBytes(user.storageQuota)}`}/>
        <InfoRow label="Cloud files" value={String(user.cloudFiles ?? 0)}/>
        <InfoRow label="Devices" value={String(user.deviceCount ?? 0)}/>
        <InfoRow label="Device name" value={user.deviceName || '—'}/>
        <InfoRow label="Platform" value={user.devicePlatform || '—'}/>
        <InfoRow label="Device ID (hashed HWID)" value={user.deviceHash || '—'}/>
        <InfoRow label="Created" value={formatDate(user.createdAt)}/>
        <InfoRow label="Last seen" value={formatDate(user.lastSeenAt)}/>
      </div>
      <p className="owner-popup-note">Private account and security information. Only owner-authorized sessions can request this data.</p>
    </div>
  </div>
}

function SettingsView({ settings, packsDir, reload, showToast, restoreVanilla, verifyPaths, pathCheck, appInfo, security, securityLoading, verifySecurity }) {
  const pathByKey = Object.fromEntries((pathCheck?.paths || []).map((x) => [x.key, x]))
  const [reshadePaths, setReshadePaths] = useState(null)
  const [reshadeBusy, setReshadeBusy] = useState(false)
  const [reshadeInstalled, setReshadeInstalled] = useState(null)
  const [reshadeStatus, setReshadeStatus] = useState(null)
  const checkReshadeStatus = async () => {
    try { setReshadeStatus(await window.appAPI.getReshadeStatus()) }
    catch (error) { showToast(friendlyError(error), 'error') }
  }
  useEffect(() => { checkReshadeStatus() }, [])
  const prepareReshade = async () => {
    setReshadeBusy(true)
    try {
      const result = await window.appAPI.prepareReshadeFolders()
      setReshadePaths(result)
      if (result.plugins.status !== 'missing' && result.gta.status === 'found') showToast('FiveM plugins and GTA folders are ready')
      else showToast('Some ReShade folders could not be found', 'error')
    } catch (error) { showToast(friendlyError(error), 'error') }
    finally { setReshadeBusy(false) }
  }
  const launchReshade = async () => {
    setReshadeBusy(true)
    try {
      const result = await window.appAPI.launchReshadeSetup()
      if (result.installed) {
        setReshadeInstalled(result)
        setReshadePaths({ plugins: { status: 'found', path: result.plugins }, gta: { status: 'found', path: result.gta } })
        showToast('ReShade installed to GTA V and FiveM')
        await reload()
        await checkReshadeStatus()
      }
    } catch (error) { showToast(friendlyError(error), 'error') }
    finally { setReshadeBusy(false) }
  }
  const finishReshade = async () => {
    setReshadeBusy(true)
    try {
      const result = await window.appAPI.finishReshadeInstall()
      setReshadeInstalled(result)
      setReshadePaths({ plugins: { status: 'found', path: result.plugins }, gta: { status: 'found', path: result.gta } })
      showToast('ReShade installed into FiveM plugins')
      await reload()
      await checkReshadeStatus()
    } catch (error) { showToast(friendlyError(error), 'error') }
    finally { setReshadeBusy(false) }
  }
  const acknowledgeReshade = async () => {
    setReshadeBusy(true)
    try {
      const result = await window.appAPI.acknowledgeReshade()
      setReshadeStatus(result)
      showToast('ReShade acknowledged. Restart FiveM.')
    } catch (error) { showToast(friendlyError(error), 'error') }
    finally { setReshadeBusy(false) }
  }
  return <>
    <PageHead title="Settings" description="Game locations and recovery tools." action={<button className="primary-btn" onClick={verifyPaths}><ScanSearch size={14}/>Verify FiveM Paths</button>} />
    <section className="plain-section">
      <div className="section-heading"><h2>Install locations</h2><p>Verify checks that each folder exists and Soren can write to it.</p></div>
      <div className="setting-list">{ROUTES.filter(({ key }) => key !== 'fivemAddon').map(({ key, label, icon: Icon }) => {
        const check = pathByKey[key]
        const detected = Boolean(settings[key])
        return <div className="setting-row" key={key}><Icon size={18}/><div className="setting-copy"><strong>{label}</strong><span>{settings[key] || 'Not detected'}</span></div>{check ? <span className={`path-state ${check.status}`}>{check.status === 'ok' ? <Check size={14}/> : <TriangleAlert size={14}/>} {check.message}</span> : <span className={detected ? 'path-state' : 'path-state missing'}>{detected ? 'Detected' : 'Not found'}</span>}</div>
      })}</div>
    </section>
    <section className="plain-section"><div className="section-heading"><h2>Install ReShade for FiveM</h2><p>Soren installs ReShade to GTA V, downloads the official shaders and prepares FiveM.</p></div><div className="restore-row"><div><strong>1. Check game folders</strong><span>Find GTA V and find or create FiveM's plugins folder.</span></div><button className="secondary-btn" disabled={reshadeBusy} onClick={prepareReshade}>{reshadeBusy ? <LoaderCircle size={15} className="spin"/> : <FolderOpen size={15}/>}Check folders</button></div>{reshadePaths && <div className="setting-list">{[['FiveM plugins', reshadePaths.plugins], ['GTA V', reshadePaths.gta]].map(([label, result]) => <div className="setting-row" key={label}><FolderOpen size={18}/><div className="setting-copy"><strong>{label}</strong><span>{result.path || 'Not detected'}</span></div><span className={`path-state ${result.status === 'missing' ? 'missing' : 'ok'}`}>{result.status === 'created' ? 'Created' : result.status === 'found' ? 'Found' : 'Not found'}</span></div>)}</div>}<div className="restore-row"><div><strong>2. Install ReShade</strong><span>Download the official setup, then choose its EXE. Soren installs it to GTA V, adds shaders and finishes the FiveM files. This can take a few minutes.</span></div><button className="text-btn" onClick={() => window.appAPI.downloadReshade().catch((error) => showToast(friendlyError(error), 'error'))}><ExternalLink size={14}/>Download</button><button className="primary-btn" disabled={reshadeBusy} onClick={launchReshade}>{reshadeBusy ? <LoaderCircle size={14} className="spin"/> : <Download size={14}/>}Install ReShade</button></div><div className="restore-row"><div><strong>Repair FiveM files</strong><span>If ReShade is already installed to GTA V, copy its DLL to FiveM plugins and refresh shader paths.</span></div><button className="secondary-btn" disabled={reshadeBusy} onClick={finishReshade}><RotateCw size={14}/>Repair</button></div>{reshadeInstalled && <div className="setting-list"><div className="setting-row"><CircleCheck size={18}/><div className="setting-copy"><strong>GTA V DLL verified</strong><span>{reshadeInstalled.gtaDll}</span></div></div><div className="setting-row"><CircleCheck size={18}/><div className="setting-copy"><strong>FiveM plugin DLL verified</strong><span>{reshadeInstalled.pluginDll}</span></div></div></div>}<div className="restore-row"><div><strong>3. Enable in FiveM</strong><span>{reshadeStatus?.state === 'blocked' ? 'FiveM blocked ReShade. Acknowledge its crash warning to let FiveM load this DLL.' : reshadeStatus?.state === 'acknowledged' ? 'Acknowledged. Restart FiveM, then press Home to open ReShade.' : reshadeStatus?.message || 'Launch FiveM once, then check its log for the required acknowledgement.'}</span></div><button className="secondary-btn" disabled={reshadeBusy} onClick={checkReshadeStatus}><ScanSearch size={14}/>Check log</button>{reshadeStatus?.state === 'blocked' && <button className="primary-btn" disabled={reshadeBusy} onClick={acknowledgeReshade}>Acknowledge warning</button>}</div>{reshadeStatus?.state === 'blocked' && <p className="logic-note">FiveM warns that ReShade 5 or higher may cause crashes. Soren will add only the acknowledgement line shown in your own FiveM log and keep a backup of CitizenFX.ini.</p>}</section>
    <section className="plain-section"><div className="section-heading"><h2>Packs folder</h2><p>Your original archives stay here after installation.</p></div><div className="setting-row"><Archive size={18}/><div className="setting-copy"><strong>Soren Packs</strong><span>{packsDir || 'Loading…'}</span></div><button className="text-btn" onClick={() => window.appAPI.openPacksFolder()}>Open</button><button className="text-btn" onClick={async () => { await reload(); showToast('Packs folder scanned') }}>Scan</button></div></section>
    <section className="plain-section"><div className="section-heading"><h2>Restore</h2><p>Remove Soren-managed pack files and restore the vanilla safety backup.</p></div><div className="restore-row"><div><strong>Restore vanilla files</strong><span>Your ZIP, RAR and 7Z archives are kept.</span></div><button className="secondary-btn" onClick={restoreVanilla}><RotateCcw size={15}/>Restore</button></div></section>
    <section className="plain-section settings-about"><div className="section-heading"><h2>About Soren</h2><p>Build information, Discord and release integrity.</p></div><InfoRow label="Developer" value="@sob"/><InfoRow label="Version" value={`Soren FiveM ${appInfo?.version || '3.1.3'}`}/><InfoRow label="Platform" value={`${appInfo?.platform || 'Windows'} · ${appInfo?.arch || 'x64'}`}/><div className="settings-inline-actions"><button className="text-btn" onClick={() => window.appAPI.openDiscord()}><MessageCircle size={14}/>Discord</button><button className="text-btn" disabled={securityLoading} onClick={() => verifySecurity(false)}>{securityLoading ? <LoaderCircle size={14} className="spin"/> : security?.status === 'verified' ? <ShieldCheck size={14}/> : <ShieldAlert size={14}/>} {securityLoading ? 'Checking build' : security?.status === 'verified' ? 'Verified release' : 'Verify build'}</button></div></section>
  </>
}

function HistoryView({ history, embedded = false }) {
  return <>
    {!embedded && <PageHead title="Installation History" description="Recent installs and their backup locations."/>}
    {!history.length ? <div className="empty-state tall"><History size={21}/><h3>No installs yet</h3><span>Installed packs will appear here.</span></div> : <div className="simple-list">{history.map((h) => <div className="simple-row" key={h.id}><Clock3 size={16}/><div className="row-copy"><strong>{h.title}</strong><span>{h.category} · {formatDate(h.installedAt)}</span></div><span className="history-route">{(h.routes || []).map((r) => ROUTE_LABELS[r] || r).join(' · ')}</span><button className="text-btn" disabled={!h.backupExists} onClick={() => h.backupPath && window.appAPI.openPath(h.backupPath)}>Backup</button></div>)}</div>}
  </>
}

function AboutView({ appInfo, security, securityLoading, verifySecurity }) {
  const verified = security?.status === 'verified'
  return <>
    <PageHead title="About" description="Soren FiveM"/>
    <div className="about-intro"><img className="mono-logo" src="./soren-logo.png" alt=""/><div><strong>Soren FiveM</strong><p>FiveM pack management with optional Soren Cloud.</p><button className="text-btn discord-link" onClick={() => window.appAPI.openDiscord()}><MessageCircle size={14}/>Join Discord</button></div></div>
    <section className="plain-section"><InfoRow label="Developer" value="@sob"/><InfoRow label="Version" value={`Soren FiveM ${appInfo.version || '3.1.3'}`}/><InfoRow label="Platform" value={`${appInfo.platform || 'Windows'} · ${appInfo.arch || 'x64'}`}/></section>
    <section className="plain-section"><div className="section-heading security-heading"><div><h2>Release integrity</h2><p>Checks core files against the signed release manifest.</p></div><button className="text-btn" disabled={securityLoading} onClick={() => verifySecurity(false)}>{securityLoading ? <LoaderCircle size={14} className="spin"/> : <RefreshCw size={14}/>}Verify</button></div><div className={`security-line ${verified ? 'verified' : securityLoading ? 'checking' : 'warning'}`}>{securityLoading ? <LoaderCircle size={17} className="spin"/> : verified ? <ShieldCheck size={17}/> : <ShieldAlert size={17}/>}<div><strong>{securityLoading ? 'Checking release…' : verified ? 'Release manifest is valid' : 'Integrity status unavailable'}</strong><span>{security?.checkedFiles != null ? `${security.checkedFiles} core files checked` : security?.message || 'No result yet'}</span></div></div></section>
  </>
}

function InfoRow({ label, value }) {
  return <div className="info-row"><span>{label}</span><strong>{value}</strong></div>
}

function PackDetails({ item, close, prepare, addToQueue, account, uploadCloud }) {
  const Icon = item.category === 'Graphics packs' ? Boxes : item.category === 'GTA Sounds' ? Music2 : Archive
  const ext = String(item.fileName || '').split('.').pop()?.toUpperCase() || 'ARCHIVE'
  const validation = validationFor(item)
  const blocked = Boolean(item.scanError || item.missingFiles?.length)
  return <div className="pack-detail">
    <div className="detail-top"><div className="detail-icon"><Icon size={23}/></div><div className="detail-title"><h3>{item.title}</h3><p className="detail-file">{item.fileName}</p></div></div>
    <div className="detail-info"><div><span>Category</span><strong>{item.category}</strong></div><div><span>Archive</span><strong>{ext} · {prettyBytes(item.size)}</strong></div></div>
    <div className={`validation-line ${validation.type}`}>{validation.type === 'ok' ? <CircleCheck size={16}/> : validation.type === 'neutral' ? <Info size={16}/> : <TriangleAlert size={16}/>}<div><strong>{validation.label}</strong><span>{validation.detail}</span></div></div>
    {account && item.localPath && <div className="cloud-pack-line"><span>Cloud storage</span><button className="text-btn" onClick={() => uploadCloud(item, false)}><CloudUpload size={14}/>Upload</button><button className="text-btn" onClick={() => uploadCloud(item, true)}>Move to cloud</button></div>}
    <div className="modal-actions"><button className="secondary-btn" onClick={close}>Cancel</button><button className="secondary-btn" disabled={blocked || item.cloudFileId} onClick={() => { addToQueue(item); close() }}><Plus size={14}/>Add to queue</button><button className="primary-btn" disabled={blocked} onClick={() => prepare(item)}><Download size={15}/>Install</button></div>
  </div>
}

function DiskWarning({ diskCheck, canContinue, close, onContinue }) {
  const volumes = diskCheck?.volumes || []
  return <div className="state-view warning-state"><HardDrive size={27}/><h3>{canContinue ? 'Low disk space' : 'Not enough disk space'}</h3><p>{canContinue ? 'Soren can continue, but the install and safety backup may leave this drive very low on space.' : 'There is not enough free space for the pack and its safety backup.'}</p><div className="disk-lines">{volumes.map((v) => <div key={v.root}><span>{v.root}</span><small>{prettyBytes(v.free)} free · about {prettyBytes(v.required)} needed</small></div>)}</div><div className="modal-actions"><button className="secondary-btn" onClick={close}>Cancel</button>{canContinue && <button className="primary-btn" onClick={onContinue}>Continue anyway</button>}</div></div>
}

function InstallModal({ modal, setModal, close, prepare, install, addToQueue, downloadProgress, installProgress, settings, account, uploadCloud }) {
  const p = modal.prepared
  const detected = p?.routing?.detected || []
  const needsManual = p && (detected.length === 0 || p.routing?.needsManual)
  const selectedMissing = needsManual && modal.selectedRoute && !settings[modal.selectedRoute]
  const detectedMissing = detected.some((route) => !settings[route])
  const installPercent = Math.max(0, Math.min(100, Number(installProgress?.percent || 0)))

  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && modal.stage !== 'installing' && close()}><div className="modal">
    <div className="modal-head"><div><span>{modal.item.category}</span><h2>{modal.item.title}</h2></div>{modal.stage !== 'installing' && <button className="icon-btn ghost" onClick={close}><X size={16}/></button>}</div>

    {modal.stage === 'details' && <PackDetails item={modal.item} close={close} prepare={prepare} addToQueue={addToQueue} account={account} uploadCloud={uploadCloud}/>} 
    {modal.stage === 'preparing' && <div className="state-view"><ScanSearch size={24}/><h3>Checking archive</h3><p>Soren is validating the archive before anything changes.</p><div className="progress-track indeterminate"><div/></div></div>}
    {modal.stage === 'archive-error' && <div className="state-view error-state"><TriangleAlert size={27}/><h3>Archive problem</h3><p>{modal.errorMessage}</p><div className="modal-actions"><button className="primary-btn" onClick={close}>Close</button></div></div>}
    {modal.stage === 'missing-files' && <div className="state-view warning-state"><TriangleAlert size={27}/><h3>Required files are missing</h3><p>This pack cannot be installed automatically until the missing files are added.</p><div className="missing-list">{(modal.missingFiles || []).map((name) => <code key={name}>{name}</code>)}</div><div className="modal-actions"><button className="primary-btn" onClick={close}>Close</button></div></div>}
    {modal.stage === 'installing' && <div className="state-view install-state"><LoaderCircle className="spin" size={25}/><h3>{installProgress?.stage || 'Installing pack'}</h3><p>{installProgress?.current || 'Backing up replacements and applying the new pack.'}</p><div className="progress-track"><div style={{ width: `${installPercent}%` }}/></div><span>{installPercent}%{installProgress?.total ? ` · ${installProgress.completed || 0}/${installProgress.total}` : ''}</span></div>}
    {modal.stage === 'disk-warning' && <DiskWarning diskCheck={modal.diskCheck} canContinue={modal.canContinue} close={close} onContinue={() => install(false, true)}/>} 
    {modal.stage === 'done' && <div className="state-view success-state"><CircleCheck size={28}/><h3>Installed</h3><p>{modal.item.title} was installed successfully.</p><div className="modal-actions">{modal.nextQueue?.length ? <button className="secondary-btn" onClick={() => { setModal(null); setTimeout(() => prepare(modal.nextQueue[0]), 60) }}>Install next queued pack</button> : null}<button className="primary-btn" onClick={() => setModal(null)}>Done</button></div></div>}
    {modal.stage === 'admin-warning' && <div className="state-view warning-state"><ShieldAlert size={29}/><h3>Administrator access needed</h3><p>{modal.errorMessage}</p><div className="admin-note"><strong>Fix</strong><span>Close Soren, right-click Soren FiveM and choose <b>Run as administrator</b>, then install the audio pack again.</span></div><div className="modal-actions"><button className="primary-btn" onClick={close}>Got it</button></div></div>}
    {modal.stage === 'overwrite' && <div className="state-view warning-state"><TriangleAlert size={25}/><h3>Files will be replaced</h3><p>{modal.overwrite?.conflictCount || 0} existing file{modal.overwrite?.conflictCount === 1 ? '' : 's'} will be backed up before replacement.</p><div className="conflict-list">{(modal.overwrite?.conflicts || []).slice(0, 8).map((file) => <code key={file}>{file}</code>)}</div>{(modal.overwrite?.conflictCount || 0) > 8 && <span className="more-conflicts">+{modal.overwrite.conflictCount - 8} more</span>}<div className="modal-actions"><button className="secondary-btn" onClick={close}>Cancel</button><button className="primary-btn" onClick={() => install(true, Boolean(modal.diskConfirmed))}>Replace files</button></div></div>}

    {modal.stage === 'ready' && p && <>
      <div className="summary-line"><span><b>Archive</b>{p.fileName}</span><span><b>Files</b>{p.fileCount}</span><span><b>Size</b>{prettyBytes(p.totalSize)}</span></div>
      <div className="modal-section"><div className="modal-section-head"><div><strong>Install routing</strong><span>{p.routing.confidence === 'category-logic' ? 'Automatic detection' : detected.length ? 'Detected from archive' : 'Choose destination'}</span></div>{p.integrity?.ok && <span className="integrity-pass"><ShieldCheck size={14}/>Archive checked</span>}</div>{p.routing.logic && <p className="logic-note">{p.routing.logic}</p>}{detected.length ? <div className="route-list">{detected.map((route) => <div className={settings[route] ? '' : 'missing'} key={route}><span>{settings[route] ? <CircleCheck size={14}/> : <TriangleAlert size={14}/>} {ROUTE_LABELS[route]}</span><small>{settings[route] || 'Not configured'}</small></div>)}</div> : <select value={modal.selectedRoute} onChange={(e) => setModal((m) => ({ ...m, selectedRoute: e.target.value }))}><option value="">Select a destination…</option>{ROUTES.map((r) => <option key={r.key} value={r.key}>{r.label}{settings[r.key] ? '' : ' — not configured'}</option>)}</select>}</div>
      <div className="modal-section contents-section"><div className="modal-section-head"><div><strong>Contents</strong><span>{p.files.length}{p.fileCount > p.files.length ? ` of ${p.fileCount}` : ''} shown</span></div><FileArchive size={16}/></div><div className="file-list">{p.files.length ? p.files.map((f, i) => <div className="file-line" key={`${f.path}-${i}`}><code>{f.path}</code>{!f.folder && <small>{prettyBytes(f.size)}</small>}</div>) : <div className="file-empty">No file listing was returned.</div>}</div></div>
      {(detectedMissing || selectedMissing) && <div className="inline-warning"><TriangleAlert size={15}/><span>A required destination is not configured.</span></div>}
      {detected.includes('gtaAudio') && <div className="permission-hint"><ShieldAlert size={15}/><span>If Windows blocks GTA audio files, run Soren as Administrator.</span></div>}
      <div className="modal-actions"><button className="secondary-btn" onClick={close}>Cancel</button><button className="primary-btn" disabled={detectedMissing || selectedMissing || (needsManual && !modal.selectedRoute)} onClick={() => install(false, false)}><Download size={14}/>Install</button></div>
    </>}
  </div></div>
}

createRoot(document.getElementById('root')).render(<App />)
