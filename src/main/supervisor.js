'use strict'

// One `workbook serve` process per imported project, supervised.
//
// Why a child process per repository rather than one server for all of them:
// `serve` binds itself to the repository at its working directory, and the
// board's same-origin guard pins the Host header to the address that listener
// actually bound. Running the real thing per project and pointing a view at it
// satisfies both without a proxy in the middle rewriting either.
//
// The board also sends `frame-ancestors 'none'`, so these addresses cannot be
// put in an iframe. Each one is loaded in its own WebContentsView instead,
// which is a top-level contents and never triggers that check.

const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { resolveBinary } = require('./workbook')

// serve prints `Workbook board: http://127.0.0.1:7331` to stderr once bound.
// When 7331 is taken it binds a free port and prints the one it chose, so the
// banner — not the default — is the only reliable source for the address.
const BANNER = /Workbook board:\s*(https?:\/\/\S+)/

const START_TIMEOUT_MS = 15000

class Supervisor extends EventEmitter {
  constructor () {
    super()
    /** @type {Map<string, {child: import('node:child_process').ChildProcess, url: string|null, status: string, error: string|null, log: string[]}>} */
    this.processes = new Map()
    this.stopping = false
  }

  get (projectId) {
    return this.processes.get(projectId) ?? null
  }

  status (projectId) {
    const entry = this.processes.get(projectId)
    if (!entry) return { status: 'stopped', url: null, error: null }
    return { status: entry.status, url: entry.url, error: entry.error }
  }

  /**
   * Start a board for one project, or return the address of the running one.
   * @param {{id: string, path: string}} project
   * @param {{binary?: string}} [options]
   * @returns {Promise<string>} the bound board URL
   */
  async start (project, options = {}) {
    const existing = this.processes.get(project.id)
    if (existing && existing.status === 'running' && existing.url) {
      return existing.url
    }
    if (existing && existing.status === 'starting') {
      return existing.pending
    }

    const binary = await resolveBinary(options.binary)
    const child = spawn(binary, ['serve'], { cwd: project.path, env: process.env })

    const entry = { child, url: null, status: 'starting', error: null, log: [], pending: null }
    this.processes.set(project.id, entry)

    entry.pending = new Promise((resolve, reject) => {
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        entry.status = 'failed'
        entry.error = 'timed out waiting for the board to bind'
        child.kill()
        reject(new Error(entry.error))
      }, START_TIMEOUT_MS)

      const onText = (text) => {
        entry.log.push(text)
        if (entry.log.length > 200) entry.log.shift()
        const match = text.match(BANNER)
        if (match && !settled) {
          settled = true
          clearTimeout(timer)
          entry.url = match[1].trim()
          entry.status = 'running'
          this.emit('started', { projectId: project.id, url: entry.url })
          resolve(entry.url)
        }
      }

      child.stderr.on('data', (chunk) => onText(chunk.toString()))
      child.stdout.on('data', (chunk) => onText(chunk.toString()))

      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        entry.status = 'failed'
        entry.error = error.message
        reject(error)
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        const wasRunning = entry.status === 'running'
        entry.status = this.stopping ? 'stopped' : 'exited'
        entry.url = null
        if (!this.stopping && code !== 0) {
          entry.error = entry.log.join('').trim().split('\n').slice(-3).join('\n') ||
            `serve exited with code ${code}`
        }
        this.emit('exited', { projectId: project.id, code, wasRunning })
        if (!settled) {
          settled = true
          reject(new Error(entry.error ?? `serve exited with code ${code}`))
        }
      })
    })

    return entry.pending
  }

  /** Stop one project's board. */
  stop (projectId) {
    const entry = this.processes.get(projectId)
    if (!entry) return
    entry.status = 'stopped'
    entry.child.kill()
    this.processes.delete(projectId)
  }

  /**
   * Stop every board. Called on quit: these are real child processes holding
   * listeners, and leaking them would leave ports bound after the app closes.
   */
  stopAll () {
    this.stopping = true
    for (const [, entry] of this.processes) {
      entry.child.kill()
    }
    this.processes.clear()
  }
}

module.exports = { Supervisor }
