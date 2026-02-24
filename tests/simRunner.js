import { PROFILES } from "./simProfiles.js";
import { runScenario } from "./simCore.js";

function assert(cond, msg){
  if (!cond) throw new Error(msg);
}

function approx(a,b,tol){ return Math.abs(a-b) <= tol; }

function fingerprint(result){
  const blocks = result.blocks;
  const n = blocks.length;
  const goals = blocks.map(b=>b.goal_seconds||0);
  const focus = blocks.map(b=>b.focus_seconds||0);
  const phaseCounts = blocks.reduce((acc,b)=>{ acc[b.phase]=(acc[b.phase]||0)+1; return acc; }, {});
  const lastGoal = goals[n-1]||0;
  const lastFocus = focus[n-1]||0;
  const avgGoal = goals.reduce((a,x)=>a+x,0)/Math.max(1,n);
  const avgFocus = focus.reduce((a,x)=>a+x,0)/Math.max(1,n);
  const wins = blocks.filter(b=>(b.focus_seconds||0) >= (b.goal_seconds||0)).length;
  const winRate = wins/Math.max(1,n);
  return { n, lastGoal, lastFocus, avgGoal, avgFocus, winRate, phaseCounts };
}

export function runAssertions(profileKey, result){
  const fp = fingerprint(result);
  assert(fp.n > 0, "No blocks produced");
  assert(Number.isFinite(fp.avgGoal) && fp.avgGoal>0, "Invalid avgGoal");
  assert(Number.isFinite(fp.avgFocus) && fp.avgFocus>0, "Invalid avgFocus");
  assert(fp.winRate > 0.10 && fp.winRate < 0.98, `Win rate ${(fp.winRate*100).toFixed(1)}% out of expected 10-98% range`);
  // goals should not explode
  assert(fp.lastGoal < 4*60*60, "Goal exploded beyond 4 hours");
  // at least some variation (asymmetry + jitter)
  const uniqGoals = new Set(result.blocks.map(b=>b.goal_seconds)).size;
  assert(uniqGoals >= Math.min(5, Math.floor(fp.n/2)), "Goals too constant (jitter/bumps not applied?)");
  return fp;
}

export function runAll(){
  const out = {};
  for (const key of Object.keys(PROFILES)){
    // Clear planner state between profiles so they're independent
    try { localStorage.removeItem("ftf_training_state_v2"); } catch(e) {}
    try { localStorage.removeItem("ftf_intensity"); } catch(e) {}
    const r = runScenario(PROFILES[key]);
    const fp = runAssertions(key, r);
    out[key] = { fingerprint: fp };
  }
  return out;
}

export function compareToBaseline(current, baseline, tolerances={}){
  const tol = Object.assign({ avgGoal: 60, avgFocus: 90, winRate: 0.08, lastGoal: 120 }, tolerances);
  const diffs = {};
  let ok = true;
  for (const key of Object.keys(current)){
    const c = current[key].fingerprint;
    const b = baseline[key]?.fingerprint;
    if (!b){
      diffs[key] = { ok:false, reason:"missing baseline" };
      ok = false;
      continue;
    }
    const d = {
      avgGoal: c.avgGoal - b.avgGoal,
      avgFocus: c.avgFocus - b.avgFocus,
      winRate: c.winRate - b.winRate,
      lastGoal: c.lastGoal - b.lastGoal,
      phaseCounts: { current:c.phaseCounts, baseline:b.phaseCounts }
    };
    const pass = Math.abs(d.avgGoal) <= tol.avgGoal
      && Math.abs(d.avgFocus) <= tol.avgFocus
      && Math.abs(d.winRate) <= tol.winRate
      && Math.abs(d.lastGoal) <= tol.lastGoal;
    diffs[key] = { ok:pass, diff:d, tol };
    if (!pass) ok = false;
  }
  return { ok, diffs };
}
