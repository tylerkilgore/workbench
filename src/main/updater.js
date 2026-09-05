'use strict'

// Checking GitHub Releases for a newer Workbench, and installing it.
//
// Two platforms, two mechanisms, for one reason: signing.
//
// Windows installers are signed in CI when the Azure Trusted Signing secrets
// are present, so Squirrel's native flow works — download in the background,
// install on restart.
//
// macOS builds carry an ad-hoc signature, not a Developer ID one, and
// Squirrel.Mac silently refuses to install an update over a bundle it cannot
// verify: `quitAndInstall` returns without doing anything and the user is left
// believing they upgraded. So the Mac path never calls it. It downloads the DMG
// itself and opens it in Finder for a drag into Applications, which is the same
// thing the user did to install in the first place.

const { app, dialog, shell, net } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { autoUpdater } = require('electron-updater')

const OWNER = 'tylerkilgore'
const REPO = 'workbench'
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`

// Long enough that the first window is drawn and the boards the user came for
// are already starting; an update prompt is never the point of launching.
const FIRST_CHECK_DELAY_MS = 6000

const useManualMacFlow = process.platform === 'darwin'

let checking = false

function log (message) {
  console.log(`[updater] ${message}`)
}

/**
 * Download the DMG for `version` matching this Mac's architecture and open it.
 *
 * The filename must match electron-builder's artifactName for the mac target;
 * if that config changes, this changes with it.
 */
async function downloadAndOpenMacDmg (version, onProgress) {
  // Must match electron-builder's mac artifactName,
  // '${productName}-${version}-${arch}.${ext}' — which suffixes *every* arch,
  // x64 included. Assuming a bare name for x64 asks GitHub for a file that was
  // never published.
  const filename = `Workbench-${version}-${process.arch}.dmg`
  const url = `https://github.com/${OWNER}/${REPO}/releases/download/v${version}/${filename}`
  const destination = path.join(app.getPath('downloads'), filename)

  const response = await net.fetch(url)
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)

  const total = Number(response.headers.get('content-length') || 0)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const stream = fs.createWriteStream(destination)
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      stream.write(Buffer.from(value))
      received += value.byteLength
      if (total > 0) onProgress?.(received / total)
    }
  } finally {
    stream.end()
  }
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve)
    stream.on('error', reject)
  })

  // shell.openPath resolves to '' on success and to a message on failure.
  const failure = await shell.openPath(destination)
  if (failure) throw new Error(`Could not open the disk image: ${failure}`)
  return destination
}

/**
 * @param {{ onProgress?: (fraction: number) => void }} [hooks]
 */
function setupUpdater (hooks = {}) {
  // Nothing to update: a development run is not installed from a release, and
  // checking would only produce a confusing prompt to "update" to the version
  // already in the working tree.
  if (!app.isPackaged) {
    log('development run — update checks disabled')
    return { check: async () => ({ skipped: 'development build' }) }
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} }

  autoUpdater.on('update-available', async (info) => {
    if (useManualMacFlow) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: 'Update available',
        message: `Workbench ${info.version} is available.`,
        detail: 'Download it now? Workbench keeps running while it downloads.',
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1
      })
      if (response !== 0) return

      try {
        await downloadAndOpenMacDmg(info.version, hooks.onProgress)
        await dialog.showMessageBox({
          type: 'info',
          title: 'Update ready',
          message: 'The installer is open in Finder.',
          detail: 'Drag Workbench into Applications to replace this copy, then relaunch it.',
          buttons: ['OK']
        })
      } catch (error) {
        log(`manual download failed: ${error.message}`)
        const { response: choice } = await dialog.showMessageBox({
          type: 'error',
          title: 'Update download failed',
          message: 'The update could not be downloaded automatically.',
          detail: `${error.message}\n\nYou can download it from the releases page instead.`,
          buttons: ['Open releases page', 'Cancel'],
          defaultId: 0,
          cancelId: 1
        })
        if (choice === 0) shell.openExternal(RELEASES_PAGE)
      }
      return
    }

    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `Workbench ${info.version} is available. Download it now?`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 0) autoUpdater.downloadUpdate()
  })

  autoUpdater.on('download-progress', (progress) => hooks.onProgress?.(progress.percent / 100))

  // Windows only: the Mac path never calls downloadUpdate, so it never lands here.
  autoUpdater.on('update-downloaded', async () => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: 'The update is downloaded. Restart Workbench to install it?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 0) {
      app.isQuitting = true
      autoUpdater.quitAndInstall(false, true)
    }
  })

  autoUpdater.on('error', (error) => log(`error: ${error.message}`))

  /**
   * @param {{ silent?: boolean }} [options] silent suppresses the
   *   "you are up to date" dialog, which is right for the automatic check on
   *   launch and wrong for one the user asked for.
   */
  async function check ({ silent = true } = {}) {
    if (checking) return { skipped: 'already checking' }
    checking = true
    try {
      const result = await autoUpdater.checkForUpdates()
      const available = Boolean(result?.updateInfo &&
        result.updateInfo.version !== app.getVersion())
      if (!available && !silent) {
        await dialog.showMessageBox({
          type: 'info',
          title: 'No updates',
          message: `Workbench ${app.getVersion()} is the latest version.`,
          buttons: ['OK']
        })
      }
      return { available, version: result?.updateInfo?.version ?? null }
    } catch (error) {
      log(`check failed: ${error.message}`)
      if (!silent) {
        await dialog.showMessageBox({
          type: 'error',
          title: 'Update check failed',
          message: 'Could not check for updates.',
          detail: error.message,
          buttons: ['OK']
        })
      }
      return { error: error.message }
    } finally {
      checking = false
    }
  }

  setTimeout(() => { check({ silent: true }) }, FIRST_CHECK_DELAY_MS)
  return { check }
}

module.exports = { setupUpdater, RELEASES_PAGE }
