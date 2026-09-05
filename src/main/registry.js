'use strict'

// The list of imported projects, persisted between runs.
//
// This holds only what Workbench needs to find a repository again: paths and
// display names. Task data is never copied here — it lives in each repository's
// refs/workbook/*, which is the whole point of the storage model. A registry
// entry going stale is recoverable by rescanning; a registry entry is never
// the source of truth for anything.

const fs = require('node:fs/promises')
const path = require('node:path')

const EMPTY = { version: 1, scanRoots: [], projects: [], theme: 'system' }

class Registry {
  /** @param {string} directory Electron's userData path */
  constructor (directory) {
    this.file = path.join(directory, 'registry.json')
    this.state = structuredClone(EMPTY)
  }

  async load () {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.state = { ...structuredClone(EMPTY), ...parsed }
    } catch {
      this.state = structuredClone(EMPTY) // First run, or an unreadable file.
    }
    return this.state
  }

  async save () {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    await fs.writeFile(temporary, JSON.stringify(this.state, null, 2))
    await fs.rename(temporary, this.file) // Atomic: never leave a half-written registry.
  }

  get projects () {
    return this.state.projects
  }

  get scanRoots () {
    return this.state.scanRoots
  }

  /** 'system' | 'light' | 'dark' */
  get theme () {
    return this.state.theme ?? 'system'
  }

  async setTheme (theme) {
    this.state.theme = theme
    await this.save()
  }

  find (projectId) {
    return this.state.projects.find((project) => project.id === projectId) ?? null
  }

  async rememberScanRoot (root) {
    if (!this.state.scanRoots.includes(root)) {
      this.state.scanRoots.unshift(root)
      this.state.scanRoots = this.state.scanRoots.slice(0, 10)
      await this.save()
    }
  }

  /**
   * Add or update a project. Keyed by projectId, which Workbook mints and never
   * changes, so a repository that moved on disk updates in place rather than
   * appearing twice.
   */
  async upsert (project) {
    const index = this.state.projects.findIndex((existing) => existing.id === project.id)
    if (index === -1) {
      this.state.projects.push(project)
    } else {
      this.state.projects[index] = { ...this.state.projects[index], ...project }
    }
    await this.save()
    return project
  }

  async remove (projectId) {
    this.state.projects = this.state.projects.filter((project) => project.id !== projectId)
    await this.save()
  }
}

module.exports = { Registry }
