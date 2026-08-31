import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Compass, Settings, History, Search, FolderOpen, RotateCw, Download, Play,
  Image as ImageIcon, FileArchive, X, Music2, Boxes, Puzzle,
  Sparkles, ExternalLink, TriangleAlert, LoaderCircle, CircleCheck, Files,
  Trash2, Minus, Square, Info, ShieldCheck, ShieldAlert, RefreshCw
} from 'lucide-react'
import './styles.css'

const ROUTES = [
  { key: 'gtaAudio', label: 'GTA sound / audio', hint: 'Choose the folder where sound/audio files should be merged.', icon: Music2 },
  { key: 'citizen', label: 'Citizen', hint: 'Select your existing main citizen folder.', icon: Boxes },
  { key: 'fivemMod', label: 'FiveM mods', hint: 'Target folder for standard FiveM mods.', icon: Puzzle },
  { key: 'fivemAddon', label: 'FiveM addons', hint: 'Target folder for FiveM addons.', icon: Sparkles }
]

const ROUTE_LABELS = Object.fromEntries(ROUTES.map((r) => [r.key, r.label]))
const PAGE_SIZE = 12

function friendlyError(error) {
  const raw = error?.message || String(error || 'Unknown error')
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '')
}

function prettyBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`
}

function App() {
  const [view, setView] = useState('discover')
  const [catalog, setCatalog] = useState({ categories: [], items: [] })
  const [settings, setSettings] = useState({})
  const [history, setHistory] = useState([])
  const [appInfo, setAppInfo] = useState({ name: 'Soren FiveM', version: '1.8.0' })
  const [security, setSecurity] = useState(null)
  const [securityLoading, setSecurityLoading] = useState(true)
  const [category, setCategory] = useState('All')
  const [query, setQuery] = useState('')
  const [loadingCatalog, setLoadingCatalog] = useState(true)
  const [modal, setModal] = useState(null)
  const [toast, setToast] = useState(null)
  const [progress, setProgress] = useState(null)

  const showToast = (message, type = 'success') => {
    setToast({ message, type })
    window.clearTimeout(showToast.timer)
    showToast.timer = window.setTimeout(() => setToast(null), 3400)
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
    } finally {
      setSecurityLoading(false)
    }
  }

  const loadAll = async () => {
    setLoadingCatalog(true)
    try {
      const [c, s, h, info] = await Promise.all([
        window.appAPI.getCatalog(),
        window.appAPI.getSettings(),
        window.appAPI.getHistory(),
        window.appAPI.getAppInfo()
      ])
      setCatalog(c)
      setSettings(s)
      setHistory(h)
      setAppInfo(info)
    } catch (e) {
      showToast(friendlyError(e), 'error')
    } finally {
      setLoadingCatalog(false)
    }
  }

  useEffect(() => {
    loadAll()
    verifySecurity(true)
    const stopProgress = window.appAPI.onDownloadProgress((data) => setProgress(data))
    const catalogTimer = window.setInterval(async () => {
      try { setCatalog(await window.appAPI.getCatalog()) } catch {}
    }, 10 * 60 * 1000)
    return () => {
      stopProgress?.()
      window.clearInterval(catalogTimer)
    }
  }, [])

  useEffect(() => {
    if (category !== 'All' && !catalog.categories.includes(category)) setCategory('All')
  }, [catalog.categories, category])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return catalog.items.filter((item) => {
      const categoryMatch = category === 'All' || item.category === category
      const queryMatch = !q || item.title.toLowerCase().includes(q) || item.fileName.toLowerCase().includes(q)
      return categoryMatch && queryMatch
    })
  }, [catalog.items, category, query])

  const openPack = async (item) => {
    setProgress({ jobId: null, percent: 0, received: 0, total: 0 })
    setModal({ stage: 'downloading', item })
    try {
      const prepared = await window.appAPI.prepareInstall(item)
      setModal({ stage: 'ready', item, prepared, selectedRoute: prepared.routing.suggested || '' })
    } catch (e) {
      setModal(null)
      showToast(friendlyError(e), 'error')
    } finally {
      setProgress(null)
    }
  }

  const closeModal = async () => {
    if (modal?.prepared?.jobId) await window.appAPI.cancelPrepared(modal.prepared.jobId)
    setModal(null)
    setProgress(null)
  }

  const installPrepared = async (replaceExisting = false) => {
    if (!modal?.prepared) return
    const prepared = modal.prepared
    const item = modal.item
    const selectedRoute = modal.selectedRoute
    setModal((m) => ({ ...m, stage: 'installing' }))
    try {
      const result = await window.appAPI.confirmInstall({ jobId: prepared.jobId, selectedRoute, replaceExisting })
      if (result?.needsOverwriteConfirmation) {
        setModal((m) => ({ ...m, stage: 'overwrite', overwrite: result }))
        return
      }
      setHistory((h) => [result.historyEntry, ...h])
      setModal({ stage: 'done', item, result })
      showToast(`${item.title} installed`)
    } catch (e) {
      setModal((m) => ({ ...m, stage: 'ready' }))
      showToast(friendlyError(e), 'error')
    }
  }

  const chooseFolder = async (key) => {
    try { setSettings(await window.appAPI.chooseFolder(key)) }
    catch (e) { showToast(friendlyError(e), 'error') }
  }

  const clearFolder = async (key) => setSettings(await window.appAPI.clearFolder(key))

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="workspace">
        <aside className="sidebar">
          <div className="brand">
            <img className="brand-logo" src="./soren-logo.png" alt="" />
            <div className="brand-copy"><strong>Soren</strong><span>FiveM library</span></div>
          </div>
          <nav>
            <NavButton active={view === 'discover'} icon={Compass} label="Discover" onClick={() => setView('discover')} />
            <NavButton active={view === 'history'} icon={History} label="Installed" onClick={() => setView('history')} />
            <NavButton active={view === 'settings'} icon={Settings} label="Settings" onClick={() => setView('settings')} />
            <NavButton active={view === 'about'} icon={Info} label="About" onClick={() => setView('about')} />
          </nav>
          <div className="sidebar-bottom">
            <div className={`integrity-mini ${security?.status || 'checking'}`}>
              {securityLoading ? <LoaderCircle size={11} className="spin"/> : security?.status === 'verified' ? <ShieldCheck size={11}/> : <ShieldAlert size={11}/>} 
              <span>{securityLoading ? 'Checking build' : security?.status === 'verified' ? 'Verified release' : 'Build check'}</span>
            </div>
            <span>v{appInfo.version || '1.8.0'}</span>
          </div>
        </aside>

        <main className="main">
          <div className="view-stage" key={view}>
            {view === 'discover' && <Discover catalog={catalog} items={filtered} category={category} setCategory={setCategory} query={query} setQuery={setQuery} openPack={openPack} loading={loadingCatalog} reload={loadAll} />}
            {view === 'settings' && <SettingsView settings={settings} chooseFolder={chooseFolder} clearFolder={clearFolder} catalog={catalog} reload={loadAll} showToast={showToast} />}
            {view === 'history' && <HistoryView history={history} />}
            {view === 'about' && <AboutView appInfo={appInfo} security={security} securityLoading={securityLoading} verifySecurity={verifySecurity} />}
          </div>
        </main>
      </div>

      {modal && <InstallModal modal={modal} setModal={setModal} close={closeModal} install={installPrepared} progress={progress} settings={settings} />}
      {toast && <div className={`toast ${toast.type}`}>{toast.type === 'error' ? <TriangleAlert size={14}/> : <CircleCheck size={14}/>}<span>{toast.message}</span></div>}
    </div>
  )
}

function TitleBar() {
  return <div className="titlebar" onDoubleClick={(e) => { if (!e.target.closest('button')) window.appAPI.toggleMaximizeWindow() }}>
    <div className="titlebar-identity"><img src="./soren-logo.png" alt="" /><span>Soren FiveM</span></div>
    <div className="window-actions">
      <button className="window-btn" title="Minimize" onClick={() => window.appAPI.minimizeWindow()}><Minus size={13}/></button>
      <button className="window-btn" title="Maximize" onClick={() => window.appAPI.toggleMaximizeWindow()}><Square size={10}/></button>
      <button className="window-btn close" title="Close" onClick={() => window.appAPI.closeWindow()}><X size={13}/></button>
    </div>
  </div>
}

function NavButton({ active, icon: Icon, label, onClick }) {
  return <button className={`nav-btn ${active ? 'active' : ''}`} onClick={onClick}><Icon size={15}/><span>{label}</span></button>
}

function PageHead({ title, description, action }) {
  return <header className="page-head"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</header>
}

function Discover({ catalog, items, category, setCategory, query, setQuery, openPack, loading, reload }) {
  const [page, setPage] = useState(1)
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const firstIndex = (safePage - 1) * PAGE_SIZE
  const pageItems = items.slice(firstIndex, firstIndex + PAGE_SIZE)
  const lastIndex = Math.min(firstIndex + pageItems.length, items.length)

  useEffect(() => { setPage(1) }, [category, query])
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [page, pageCount])

  const changePage = (nextPage) => {
    setPage(Math.max(1, Math.min(pageCount, nextPage)))
    document.querySelector('.main')?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return <>
    <PageHead title="Discover" description="Preview a pack, inspect its files, then install it to the right FiveM location." action={<button className="icon-btn" title="Reload catalogue" onClick={reload}><RotateCw size={14}/></button>} />

    <div className="toolbar">
      <label className="search"><Search size={14}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search packs" /></label>
      <span className="count">{items.length} packs</span>
    </div>

    <div className="category-tabs">
      {['All', ...catalog.categories].map((c) => <button key={c} onClick={() => setCategory(c)} className={category === c ? 'active' : ''}>{c}</button>)}
    </div>

    {loading ? <div className="empty-state"><LoaderCircle className="spin" size={17}/><span>Loading catalogue…</span></div> : items.length ? <>
      <div className="list-meta">{firstIndex + 1}–{lastIndex} of {items.length}</div>
      <div className="pack-grid">{pageItems.map((item) => <PackCard key={item.id} item={item} onOpen={() => openPack(item)} />)}</div>
      {pageCount > 1 && <div className="pagination">
        <button disabled={safePage === 1} onClick={() => changePage(safePage - 1)}>‹</button>
        <span>{safePage} / {pageCount}</span>
        <button disabled={safePage === pageCount} onClick={() => changePage(safePage + 1)}>›</button>
      </div>}
    </> : <div className="empty-state"><Files size={17}/><span>No packs match that filter.</span></div>}
  </>
}

function PackCard({ item, onOpen }) {
  return <article className="pack-tile" onClick={onOpen} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
    <LazyPreview item={item} />
    <div className="pack-copy"><strong title={item.title}>{item.title}</strong><span title={item.fileName}>{item.fileName}</span></div>
  </article>
}

function LazyPreview({ item }) {
  const hostRef = useRef(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    setVisible(false)
    const host = hostRef.current
    if (!host) return
    if (!('IntersectionObserver' in window)) { setVisible(true); return }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '90px 0px' })
    observer.observe(host)
    return () => observer.disconnect()
  }, [item.id])

  return <div className="preview" ref={hostRef} onClick={(e) => e.stopPropagation()}>
    {!visible ? <div className="preview-fallback">{item.previewType === 'video' ? <Play size={20}/> : <ImageIcon size={20}/>}</div> :
      item.previewType === 'video' ? <video src={item.previewUrl} preload="metadata" muted loop controls playsInline /> :
      item.previewType === 'image' ? <img src={item.previewUrl} loading="lazy" decoding="async" alt="" /> : <div className="preview-fallback"><ImageIcon size={20}/></div>}
    <span className="category-label">{item.category}</span>
  </div>
}

function SettingsView({ settings, chooseFolder, clearFolder, catalog, reload, showToast }) {
  return <>
    <PageHead title="Settings" description="Set the folders Soren FiveM is allowed to write to." />
    <section className="plain-section">
      <div className="section-heading"><h2>Install locations</h2><p>Existing files are backed up before replacement.</p></div>
      <div className="setting-list">
        {ROUTES.map(({ key, label, hint, icon: Icon }) => <div className="setting-row" key={key}>
          <Icon size={15}/>
          <div className="setting-copy"><strong>{label}</strong><span>{settings[key] || hint}</span></div>
          {settings[key] && <button className="link-btn danger" onClick={() => clearFolder(key)} title="Clear"><Trash2 size={13}/></button>}
          <button className="link-btn" onClick={() => chooseFolder(key)}><FolderOpen size={13}/>{settings[key] ? 'Change' : 'Choose'}</button>
        </div>)}
      </div>
    </section>

    <section className="plain-section">
      <div className="section-heading"><h2>Catalogue</h2><p>Discovery syncs from GitHub. Each pair is preview URL first, download URL second.</p></div>
      <div className="setting-row catalogue-row">
        <Files size={15}/><div className="setting-copy"><strong>Discovery source</strong><span>{catalog?.sourceLabel || catalog?.catalogDir || 'Loading…'}</span></div>
        <button className="link-btn" title="Open the local fallback catalogue" onClick={() => window.appAPI.openCatalogFolder()}><ExternalLink size={13}/>Fallback</button>
        <button className="link-btn" onClick={async () => { await reload(); showToast('Catalogue reloaded') }}><RotateCw size={13}/>Reload</button>
      </div>
    </section>
  </>
}

function HistoryView({ history }) {
  return <>
    <PageHead title="Installed" description="Recent installs and the backups created before replacements." />
    {!history.length ? <div className="empty-state tall"><History size={18}/><span>No packs installed yet.</span></div> : <div className="history-list">
      {history.map((h) => <div className="history-row" key={h.id}>
        <CircleCheck size={15} className="ok-icon"/>
        <div className="history-copy"><strong>{h.title}</strong><span>{h.category} · {new Date(h.installedAt).toLocaleString()}</span></div>
        <span className="history-route">{h.routes.map((r) => ROUTE_LABELS[r] || r).join(' · ')}</span>
        <button className="link-btn" onClick={() => window.appAPI.openPath(h.backupPath)}><FolderOpen size={13}/>Backup</button>
      </div>)}
    </div>}
  </>
}

function AboutView({ appInfo, security, securityLoading, verifySecurity }) {
  const verified = security?.status === 'verified'
  return <>
    <PageHead title="About Soren FiveM" description="A lightweight FiveM pack browser, inspector and installer." />

    <div className="about-intro">
      <img src="./soren-logo.png" alt="" />
      <div><strong>Soren FiveM</strong><p>Soren FiveM previews community packs, inspects archive contents before installation, routes supported files into configured FiveM/GTA folders, and asks before replacing existing files.</p></div>
    </div>

    <section className="plain-section">
      <div className="section-heading"><h2>Credits</h2></div>
      <InfoRow label="Developer" value="@misty" />
      <InfoRow label="Bug helpers" value="ChatGPT · e@sy" />
    </section>

    <section className="plain-section">
      <div className="section-heading"><h2>Release</h2></div>
      <InfoRow label="Version" value={`Soren FiveM ${appInfo.version || '1.8.0'}`} />
      <InfoRow label="Platform" value={`${appInfo.platform || 'Windows'} · ${appInfo.arch || 'x64'}`} />
      <InfoRow label="Build type" value={appInfo.packaged ? 'Packaged release' : 'Source / development'} />
    </section>

    <section className="plain-section security-section">
      <div className="section-heading security-heading"><div><h2>Release integrity</h2><p>Checks Soren FiveM's bundled core files against the signed v{appInfo.version || '1.8.0'} manifest.</p></div><button className="link-btn" disabled={securityLoading} onClick={() => verifySecurity(false)}>{securityLoading ? <LoaderCircle size={13} className="spin"/> : <RefreshCw size={13}/>}Verify</button></div>
      <div className={`security-status ${verified ? 'verified' : securityLoading ? 'checking' : 'warning'}`}>
        {securityLoading ? <LoaderCircle size={16} className="spin"/> : verified ? <ShieldCheck size={16}/> : <ShieldAlert size={16}/>} 
        <div><strong>{securityLoading ? 'Checking release…' : verified ? 'Signed release manifest is valid' : security?.status === 'modified' ? 'Core files do not match this release' : 'Integrity status unavailable'}</strong><span>{security?.checkedFiles != null ? `${security.checkedFiles} core files checked` : security?.message || 'No result yet'}</span></div>
      </div>
      <InfoRow label="Build fingerprint" value={security?.fingerprint || 'Checking…'} mono />
      <InfoRow label="Manifest signature" value={securityLoading ? 'Checking…' : security?.signatureValid ? 'Valid (Ed25519)' : 'Not valid'} />
      <InfoRow label="Core files" value={securityLoading ? 'Checking…' : security?.filesValid ? 'Match release' : security?.modifiedFiles?.length ? `${security.modifiedFiles.length} changed / missing` : 'Not verified'} />
      <InfoRow label="Windows publisher signature" value={security?.windowsSignature || (appInfo.packaged ? 'Not checked' : 'Development run')} />
      {security?.executableSha256 && <InfoRow label="Executable SHA-256" value={security.executableSha256.toUpperCase()} mono />}
      <InfoRow label="Install safeguards" value="Temporary inspection · overwrite confirmation · automatic backup" />
      <p className="security-note">A verified manifest means the bundled Soren FiveM core files match this release. Windows publisher signing is a separate check and requires a code-signing certificate.</p>
    </section>
  </>
}

function InfoRow({ label, value, mono = false }) {
  return <div className="info-row"><span>{label}</span><strong className={mono ? 'mono' : ''}>{value}</strong></div>
}

function InstallModal({ modal, setModal, close, install, progress, settings }) {
  const p = modal.prepared
  const detected = p?.routing?.detected || []
  const needsManual = p && detected.length === 0
  const selectedMissing = needsManual && modal.selectedRoute && !settings[modal.selectedRoute]
  const detectedMissing = detected.some((route) => !settings[route])

  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && modal.stage !== 'installing' && close()}>
    <div className="modal">
      <div className="modal-head"><div><span>{modal.item.category}</span><h2>{modal.item.title}</h2></div>{modal.stage !== 'installing' && <button className="icon-btn" onClick={close}><X size={15}/></button>}</div>

      {modal.stage === 'downloading' && <div className="state-view"><Download size={21}/><h3>Downloading for inspection</h3><p>Nothing is being installed yet.</p><div className="progress-track"><div style={{ width: `${progress?.percent ?? 18}%` }} /></div><span>{progress?.percent != null ? `${progress.percent}% · ${prettyBytes(progress.received)} / ${prettyBytes(progress.total)}` : `${prettyBytes(progress?.received || 0)} downloaded`}</span></div>}
      {modal.stage === 'installing' && <div className="state-view"><LoaderCircle className="spin" size={22}/><h3>Installing pack</h3><p>Soren FiveM is copying the planned files and backing up replacements.</p></div>}
      {modal.stage === 'done' && <div className="state-view"><CircleCheck className="ok-icon" size={23}/><h3>Installed</h3><p>{modal.item.title} was installed successfully.</p><button className="primary-btn" onClick={() => setModal(null)}>Done</button></div>}

      {modal.stage === 'overwrite' && <div className="overwrite-view">
        <TriangleAlert size={20} className="warn-icon"/><h3>Replace existing files?</h3><p>{modal.overwrite?.conflictCount || 0} file{modal.overwrite?.conflictCount === 1 ? '' : 's'} already exist. Nothing has been changed yet.</p>
        <div className="conflict-list">{(modal.overwrite?.conflicts || []).slice(0, 8).map((file) => <code key={file}>{file}</code>)}</div>
        {(modal.overwrite?.conflictCount || 0) > 8 && <span className="more-conflicts">+{modal.overwrite.conflictCount - 8} more</span>}
        <div className="modal-actions"><button className="secondary-btn" onClick={close}>Cancel</button><button className="primary-btn danger-confirm" onClick={() => install(true)}>Replace files</button></div>
      </div>}

      {modal.stage === 'ready' && p && <>
        <div className="summary-line"><span><b>Download</b>{p.fileName}</span><span><b>Files</b>{p.fileCount}</span><span><b>Size</b>{prettyBytes(p.totalSize)}</span></div>

        <div className="modal-section">
          <div className="modal-section-head"><div><strong>Install routing</strong><span>{p.routing.confidence === 'category-logic' ? 'Automatic category logic' : detected.length ? 'Detected from archive' : 'Choose destination'}</span></div><ShieldCheck size={15}/></div>
          {p.routing.logic && <p className="logic-note">{p.routing.logic}</p>}
          {detected.length ? <div className="route-list">{detected.map((route) => <div className={settings[route] ? '' : 'missing'} key={route}><span>{settings[route] ? <CircleCheck size={13}/> : <TriangleAlert size={13}/>} {ROUTE_LABELS[route]}</span><small>{settings[route] || 'Not configured'}</small></div>)}</div> :
            <select value={modal.selectedRoute} onChange={(e) => setModal((m) => ({ ...m, selectedRoute: e.target.value }))}><option value="">Select a destination…</option>{ROUTES.map((r) => <option key={r.key} value={r.key}>{r.label}{settings[r.key] ? '' : ' — not configured'}</option>)}</select>}
        </div>

        <div className="modal-section contents-section">
          <div className="modal-section-head"><div><strong>Contents</strong><span>{p.files.length}{p.fileCount > p.files.length ? ` of ${p.fileCount}` : ''} shown</span></div><FileArchive size={15}/></div>
          <div className="file-list">{p.files.length ? p.files.map((f, i) => <div className="file-line" key={`${f.path}-${i}`}><code>{f.path}</code>{!f.folder && <small>{prettyBytes(f.size)}</small>}</div>) : <div className="file-empty">No file listing was returned.</div>}</div>
        </div>

        {(detectedMissing || selectedMissing) && <div className="inline-warning"><TriangleAlert size={14}/><span>A required destination is not configured. Set it in Settings first.</span></div>}
        <div className="modal-actions"><button className="secondary-btn" onClick={close}>Cancel</button><button className="primary-btn" disabled={detectedMissing || selectedMissing || (needsManual && !modal.selectedRoute)} onClick={() => install(false)}><Download size={13}/>Install</button></div>
      </>}
    </div>
  </div>
}

createRoot(document.getElementById('root')).render(<App />)
