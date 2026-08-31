const { parentPort, workerData } = require('worker_threads')
const path = require('path')

function safeRelativePath(name) {
  const cleaned = String(name || '')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/^[/\\]+/, '')
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.' && part !== '..')
  return cleaned.join(path.sep)
}

async function run() {
  const { createExtractorFromFile } = require('node-unrar-js')
  const { op, archivePath, targetPath } = workerData

  if (op === 'list') {
    const extractor = await createExtractorFromFile({ filepath: archivePath })
    const list = extractor.getFileList()
    const files = []
    for (const header of list.fileHeaders) {
      files.push({
        path: String(header.name || '').replace(/\\/g, '/'),
        folder: Boolean(header.flags?.directory),
        size: Number(header.unpSize || 0)
      })
    }
    return { files }
  }

  if (op === 'extract') {
    const extractor = await createExtractorFromFile({
      filepath: archivePath,
      targetPath,
      filenameTransform: safeRelativePath
    })
    const result = extractor.extract()
    let extractedCount = 0
    for (const file of result.files) {
      if (!file.fileHeader?.flags?.directory) extractedCount += 1
    }
    return { extractedCount }
  }

  throw new Error(`Unknown archive worker operation: ${op}`)
}

run()
  .then((result) => parentPort.postMessage({ ok: true, result }))
  .catch((error) => parentPort.postMessage({
    ok: false,
    error: error?.message || String(error)
  }))
