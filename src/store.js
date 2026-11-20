'use strict';
/**
 * Local recipe mirror. Mirrors what the Android app keeps:
 *   <dataDir>/recipes/<id>.brewie   recipe JSON (exactly as exchanged with the machine)
 *   <dataDir>/sync.json             { removed: [ids], modified: [ids] }
 * Unknown recipe fields are preserved on every edit so round-trips stay lossless.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class RecipeStore extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dir = path.join(dataDir, 'recipes');
    this.syncFile = path.join(dataDir, 'sync.json');
    fs.mkdirSync(this.dir, { recursive: true });
    this.sync = { removed: [], modified: [] };
    try { Object.assign(this.sync, JSON.parse(fs.readFileSync(this.syncFile, 'utf8'))); } catch (_) { /* first run */ }
  }

  saveSync() { fs.writeFileSync(this.syncFile, JSON.stringify(this.sync, null, 2)); }
  file(id) { return path.join(this.dir, `${sanitizeId(id)}.brewie`); }

  list() {
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.brewie')).map((f) => {
      const full = path.join(this.dir, f);
      try {
        const r = JSON.parse(fs.readFileSync(full, 'utf8'));
        return { recipe: r, mtime: fs.statSync(full).mtimeMs };
      } catch (e) { return null; }
    }).filter(Boolean);
  }

  summaries() {
    return this.list().map(({ recipe, mtime }) => ({
      id: recipe.id, name: recipe.name || '(unnamed)', style: styleName(recipe.style),
      batchSize: recipe.batchSize, estABV: recipe.estABV, estOG: recipe.estOG, IBU: recipe.IBU, estColor: recipe.estColor,
      modified: mtime, pendingUpload: this.sync.modified.includes(recipe.id),
    })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  get(id) {
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch (_) { return null; }
  }

  /** Save a recipe. `fromMachine` = received over the wire (not a local modification). */
  put(recipe, { fromMachine = false, mtime } = {}) {
    if (!recipe || typeof recipe !== 'object') throw new Error('recipe must be an object');
    if (!recipe.id) recipe.id = newId();
    if (!recipe.path) recipe.path = `/recipes/${recipe.id}`;
    const f = this.file(recipe.id);
    fs.writeFileSync(f, JSON.stringify(recipe, null, 2));
    if (mtime) { const t = new Date(mtime); fs.utimesSync(f, t, t); }
    this.sync.removed = this.sync.removed.filter((x) => x !== recipe.id);
    if (!fromMachine && !this.sync.modified.includes(recipe.id)) this.sync.modified.push(recipe.id);
    if (fromMachine) this.sync.modified = this.sync.modified.filter((x) => x !== recipe.id);
    this.saveSync();
    this.emit('change', { id: recipe.id, fromMachine });
    return recipe;
  }

  remove(id, { fromMachine = false } = {}) {
    const f = this.file(id); const existed = fs.existsSync(f);
    if (existed) fs.unlinkSync(f);
    this.sync.modified = this.sync.modified.filter((x) => x !== id);
    if (!fromMachine && !this.sync.removed.includes(id)) this.sync.removed.push(id);
    this.saveSync();
    if (existed) this.emit('change', { id, removed: true, fromMachine });
    return existed;
  }

  /** Entries for the RECIPE_LIST (100) message — mirrors RemoteConnectionHandler::getRecipes(). */
  syncList() {
    const list = this.list().map(({ recipe, mtime }) => ({
      id: recipe.id, time: Math.round(mtime), modified: this.sync.modified.includes(recipe.id),
    }));
    return list;
  }
  clearModified() { this.sync.modified = []; this.saveSync(); }
  takeRemoved() { const r = this.sync.removed.slice(); this.sync.removed = []; this.saveSync(); return r; }
}

function newId() { return crypto.randomUUID().replace(/[{}-]/g, ''); }
function sanitizeId(id) { return String(id).replace(/[^A-Za-z0-9_.-]/g, '_'); }
function styleName(style) {
  if (!style) return '';
  if (typeof style === 'string') return style;
  return style.name || style.code || '';
}

module.exports = { RecipeStore, newId };
