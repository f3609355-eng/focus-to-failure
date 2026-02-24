/**
 * IndexedDB storage
 * - One database: focus_to_failure
 * - One store: blocks (keyPath: idx)
 */
const DB_NAME = "focus_to_failure";
const DB_VERSION = 1;
const STORE = "blocks";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "idx" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
