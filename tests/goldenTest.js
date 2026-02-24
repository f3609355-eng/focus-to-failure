import { DEFAULT_CONFIG } from "../config.js";
import { computeMetrics } from "../analytics.js";
import { computeRawFloor, updateEffectiveFloor } from "../engine/floorEngine.js";
import { computeWaveGoal } from "../engine/goalEngine.js";
import { detectPlateau, BlockType } from "../engine/waveEngine.js";
import { datasetWithInterruption, datasetImproving, datasetSlumping, datasetPlateau } from "./goldenData.js";

// ---------- tiny test runner ----------
const results = [];
function ok(name, pass, info=""){
  results.push({ name, pass: !!pass, info });
}
function approx(a,b,tol){
  return Math.abs(a-b) <= tol;
}

// Seeded RNG for deterministic jitter checks
function mulberry32(seed){
  return function(){
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fmtSec(s){
  if (s==null) return "—";
  const m = Math.floor(s/60);
  const ss = String(s%60).padStart(2,'0');
  return `${m}:${ss}`;
}

function render(){
  const el = document.getElementById("results");
  el.innerHTML = "";
  const passN = results.filter(r=>r.pass).length;
  const head = document.createElement("div");
  head.className = "gt-summary";
  head.innerHTML = `<b>Golden tests:</b> ${passN}/${results.length} passed`;
  el.appendChild(head);

  const table = document.createElement("table");
  table.className = "gt-table";
  table.innerHTML = `<thead><tr><th>Status</th><th>Test</th><th>Details</th></tr></thead>`;
  const tb = document.createElement("tbody");
  for (const r of results){
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="${r.pass?'gt-pass':'gt-fail'}">${r.pass?'PASS':'FAIL'}</td><td>${r.name}</td><td>${r.info||""}</td>`;
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  el.appendChild(table);
}

// ---------- Tests ----------
(function run(){
  // A) Interruption ignored (<50% goal)
  {
    const { goal, blocks } = datasetWithInterruption();
    const raw = computeRawFloor(blocks, { windowN: 11, percentile: 0.35, minFracGoal: 0.5 });
    // if interruption counted, quantile would shift down materially; with it ignored, raw should be near ~23-25m
    ok("Ignore <50% goal block in raw floor", raw.rawFloorSec > 1200, `raw=${fmtSec(raw.rawFloorSec)} (expect >20:00)`);
  }

  // B) Asymmetry: up moves faster than down
  {
    const { goal, blocks } = datasetImproving();
    const raw = computeRawFloor(blocks, { windowN: 11, percentile: 0.35, minFracGoal: 0.5 });
    const prev = 20*60;
    const up = updateEffectiveFloor(prev, raw.rawFloorSec, new Date(), "2026-01-01", { upRate: 0.35, downRate: 0.10, maxDailyDropFrac: 0.02 });
    const expected = Math.round(prev + 0.35*(raw.rawFloorSec - prev));
    ok("Asymmetric smoothing: UP uses 0.35 rate", approx(up.floorSec, expected, 1), `prev=${fmtSec(prev)} raw=${fmtSec(raw.rawFloorSec)} got=${fmtSec(up.floorSec)} exp≈${fmtSec(expected)}`);
  }

  {
    const { goal, blocks } = datasetSlumping();
    const raw = computeRawFloor(blocks, { windowN: 11, percentile: 0.35, minFracGoal: 0.5 });
    const prev = 25*60;
    const down = updateEffectiveFloor(prev, raw.rawFloorSec, new Date(), "2026-01-01", { upRate: 0.35, downRate: 0.10, maxDailyDropFrac: 0.02 });
    const expected = Math.round(prev + 0.10*(raw.rawFloorSec - prev));
    ok("Asymmetric smoothing: DOWN uses 0.10 rate", approx(down.floorSec, expected, 1), `prev=${fmtSec(prev)} raw=${fmtSec(raw.rawFloorSec)} got=${fmtSec(down.floorSec)} exp≈${fmtSec(expected)}`);
  }

  // C) Daily decay guard clamps drops
  {
    const prev = 60*60; // 60m
    const raw = 20*60;  // big drop request
    const now = new Date("2026-02-24T12:00:00");
    const upd = updateEffectiveFloor(prev, raw, now, "2026-02-24", { upRate:0.35, downRate:0.10, maxDailyDropFrac:0.02 });
    // same day => allowed drop at most 2%
    const minAllowed = Math.round(prev - prev*0.02);
    ok("Max daily decay guard (2%)", upd.floorSec >= minAllowed, `got=${fmtSec(upd.floorSec)} minAllowed=${fmtSec(minAllowed)}`);
  }

  // D) Goal jitter bounds (direct goalEngine call with seeded RNG)
  {
    const cfg = DEFAULT_CONFIG;
    const w = cfg.wave;
    const rng = mulberry32(123);
    const F = 30*60, M = 35*60, C = 50*60;
    const minGoalSec = 20*60;
    const out = computeWaveGoal({ bt: BlockType.PUSH_A, F, M, C, floorBonusSec:0, minGoalSec, intensity:"Balanced", waveCfg: w, rng });
    const pctBase = (w.push_a_pct_of_median||0.10);
    const jit = (w.push_jitter_pct||0);
    // We can't read pct directly, but we can ensure push target isn't wildly outside cap logic
    ok("Push target bounded (caps apply)", out.pushTarget <= (F + (w.push_cap_add_minutes||12)*60), `push=${fmtSec(out.pushTarget)} cap=${fmtSec(F + (w.push_cap_add_minutes||12)*60)}`);
  }

  // E) Plateau detector returns structured vote
  {
    const cfg = DEFAULT_CONFIG;
    const w = cfg.wave;
    const { blocks } = datasetPlateau();
    const pz = detectPlateau(blocks, w, { min_frac_goal: 0.5 });
    ok("Plateau detector returns booleans", typeof pz.plateauByFails==="boolean" && typeof pz.plateau==="boolean", `plateau=${pz.plateau} fails=${pz.fails} improvePct=${(pz.improvePct*100).toFixed(2)}%`);
  }

  render();
})();
