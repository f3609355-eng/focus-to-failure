/**
 * IndexedDB storage with migration support.
 * - Database: FocusToFailureDB
 * - Store: blocks (keyPath: idx)
 *
 * To add a migration:
 * 1. Bump DB_VERSION
 * 2. Add a case to the switch in onupgradeneeded
 */
const DB_NAME = "FocusToFailureDB";
const DB_VERSION = 2; // bump when schema changes
const STORE = "blocks";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion || 0;

      // Version 0→1: Create blocks store (original schema)
      if (oldVersion < 1) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "idx" });
        }
      }

      // Version 1→2: Add date index for weekly queries
      if (oldVersion < 2) {
        const tx = req.transaction;
        if (tx) {
          const store = tx.objectStore(STORE);
          if (!store.indexNames.contains("by_date")) {
            store.createIndex("by_date", "date", { unique: false });
          }
          if (!store.indexNames.contains("by_bucket")) {
            store.createIndex("by_bucket", "bucket", { unique: false });
          }
        }
      }

      // Future migrations go here:
      // if (oldVersion < 3) { ... }
    };
    req.onsuccess = () => {
      // Also try to open old DB and migrate data if it exists
      migrateOldDB(req.result).then(() => resolve(req.result));
    };
    req.onerror = () => reject(req.error);
  });
}

/** One-time migration from old "focus_to_failure" DB name to new name */
async function migrateOldDB(newDb) {
  const OLD_DB_NAME = "focus_to_failure";
  try {
    // Check if old DB exists by trying to open it at version 1
    const oldReq = indexedDB.open(OLD_DB_NAME, 1);
    await new Promise((resolve, reject) => {
      oldReq.onupgradeneeded = () => {
        // Old DB doesn't exist — this is creating it. Abort.
        oldReq.transaction.abort();
        resolve();
      };
      oldReq.onsuccess = async () => {
        const oldDb = oldReq.result;
        if (!oldDb.objectStoreNames.contains("blocks")) {
          oldDb.close();
          resolve();
          return;
        }
        // Read all blocks from old DB
        const tx = oldDb.transaction("blocks", "readonly");
        const getAll = tx.objectStore("blocks").getAll();
        getAll.onsuccess = async () => {
          const oldBlocks = getAll.result || [];
          oldDb.close();
          if (oldBlocks.length > 0) {
            // Check if new DB already has data
            const newTx = newDb.transaction(STORE, "readonly");
            const newCount = newTx.objectStore(STORE).count();
            await new Promise(r => { newCount.onsuccess = r; });
            if (newCount.result === 0) {
              // Copy old blocks to new DB
              const writeTx = newDb.transaction(STORE, "readwrite");
              const writeStore = writeTx.objectStore(STORE);
              for (const b of oldBlocks) writeStore.put(b);
              await new Promise(r => { writeTx.oncomplete = r; });
              console.log(`Migrated ${oldBlocks.length} blocks from old DB`);
            }
            // Delete old DB
            indexedDB.deleteDatabase(OLD_DB_NAME);
          }
          resolve();
        };
        getAll.onerror = () => { oldDb.close(); resolve(); };
      };
      oldReq.onerror = () => resolve();
    });
  } catch (e) {
    // Silently ignore migration errors
  }
}

export async function getAllBlocks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function putBlock(block) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(block);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function bulkPut(blocks) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const st = tx.objectStore(STORE);
    for (const b of blocks) st.put(b);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
const CFG_KEY = "ftf_config_v1";

export function getConfig(){
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e){
    console.warn("Failed to parse saved config", e);
    return null;
  }
}

export function setConfig(cfg){
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch (e){
    console.warn("Failed to save config", e);
  }
}

export function clearConfig(){
  try { localStorage.removeItem(CFG_KEY); } catch(e){}
}


const STATE_KEY = "ftf_training_state_v2";
const PREF_KEYS = ["ftf_intensity","ftf_advanced","ftf_scale_v2"];

export function getTrainingState(){
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e){
    console.warn("Failed to parse training state", e);
    return null;
  }
}

export function setTrainingState(state){
  try {
    if (state == null) localStorage.removeItem(STATE_KEY);
    else localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (e){
    console.warn("Failed to save training state", e);
  }
}

export function clearTrainingState(){
  try { localStorage.removeItem(STATE_KEY); } catch(e){}
}

export function getPrefs(){
  const out = {};
  for (const k of PREF_KEYS){
    try {
      const v = localStorage.getItem(k);
      if (v != null) out[k] = v;
    } catch(e){}
  }
  return out;
}

export function setPrefs(prefs){
  if (!prefs) return;
  for (const [k,v] of Object.entries(prefs)){
    if (!PREF_KEYS.includes(k)) continue;
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, String(v));
    } catch(e){}
  }
}

export function clearPrefs(){
  for (const k of PREF_KEYS){
    try { localStorage.removeItem(k); } catch(e){}
  }
}

/**
 * Export a single-file backup: blocks + config + training state + prefs.
 */
export async function exportBackup(){
  const blocks = await getAllBlocks();
  return {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    blocks,
    config: getConfig(),
    training_state: getTrainingState(),
    prefs: getPrefs(),
  };
}

/**
 * Import a single-file backup. Overwrites existing data by default.
 */
export async function importBackup(payload, { overwrite=true } = {}){
  if (!payload || typeof payload !== "object") throw new Error("Invalid backup file");
  const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
  const cfg = payload.config ?? null;
  const st = payload.training_state ?? null;
  const prefs = payload.prefs ?? null;

  if (overwrite){
    await clearAll();
    clearConfig();
    clearTrainingState();
    clearPrefs();
  }

  // Ensure each block has idx
  const fixed = [];
  let nextIdx = 1;
  for (const b of blocks){
    if (!b || typeof b !== "object") continue;
    const nb = { ...b };
    if (nb.idx == null || nb.idx === "") nb.idx = nextIdx;
    nextIdx = Math.max(nextIdx, Number(nb.idx)||0) + 1;
    fixed.push(nb);
  }
  if (fixed.length) await bulkPut(fixed);
  if (cfg) setConfig(cfg);
  if (st) setTrainingState(st);
  if (prefs) setPrefs(prefs);
}
