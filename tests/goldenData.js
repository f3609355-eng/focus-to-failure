/**
 * Golden dataset: tiny, hand-crafted sequences to validate the engines.
 * Times are in seconds for focus durations and goal_seconds.
 */

export function makeBlocks(seq, goalSec){
  // seq: array of focus seconds (numbers)
  return seq.map((f,i)=>({
    id: `b${i+1}`,
    ts: new Date(Date.now() - (seq.length-i)*3600*1000).toISOString(),
    focus_seconds: f,
    goal_seconds: goalSec,
    stop_reason: "DISTRACTED"
  }));
}

/** Dataset A: includes an interruption (<50% of goal) that must be ignored for raw floor. */
export function datasetWithInterruption(){
  const goal = 25*60;
  // 22m, 24m, 5m (interruption), 26m, 27m, 23m, 25m
  return { goal, blocks: makeBlocks([1320,1440,300,1560,1620,1380,1500], goal) };
}

/** Dataset B: improvement trend (raw floor above prev). */
export function datasetImproving(){
  const goal = 20*60;
  return { goal, blocks: makeBlocks([900, 1000, 1100, 1200, 1300, 1400, 1500, 1550, 1600, 1650, 1700], goal) };
}

/** Dataset C: slump trend (raw floor below prev) but should fall slowly. */
export function datasetSlumping(){
  const goal = 25*60;
  return { goal, blocks: makeBlocks([1500, 1480, 1450, 1400, 1380, 1200, 1100, 1000, 980, 960, 940], goal) };
}

/** Dataset D: plateau-like (flat) vs volatile to test plateau vote. */
export function datasetPlateau(){
  const goal = 25*60;
  // fairly flat within ~2% then repeated fails -> plateauByFails likely
  return { goal, blocks: makeBlocks([1500,1490,1510,1505,1495,1500,1485,1490,1500,1495], goal) };
}
