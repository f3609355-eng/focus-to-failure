export const PROFILES = {
  steady: {
    name: "Steady improver",
    seed: 1337,
    days: 10,
    blocksPerDay: 4,
    // user tends to distract slightly after goal early, improves over time
    model: { baseSkill: 0.55, learnRate: 0.015, noise: 0.08, fatigue: 0.06 }
  },
  volatile: {
    name: "Volatile",
    seed: 2025,
    days: 10,
    blocksPerDay: 4,
    model: { baseSkill: 0.50, learnRate: 0.010, noise: 0.18, fatigue: 0.08 }
  },
  plateau: {
    name: "Plateau then adapt",
    seed: 4242,
    days: 14,
    blocksPerDay: 4,
    model: { baseSkill: 0.58, learnRate: 0.006, noise: 0.10, fatigue: 0.07, plateauDay: 6 }
  },
  gaps: {
    name: "Gaps / inconsistent schedule",
    seed: 9001,
    days: 18,
    blocksPerDay: 3,
    model: { baseSkill: 0.55, learnRate: 0.012, noise: 0.12, fatigue: 0.06, gapEvery: 4 }
  },
  elite: {
    name: "Already strong (elite-ish)",
    seed: 777,
    days: 10,
    blocksPerDay: 4,
    model: { baseSkill: 0.75, learnRate: 0.004, noise: 0.06, fatigue: 0.05 }
  }
};
