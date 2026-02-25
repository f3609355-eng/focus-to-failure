export const DEFAULT_CONFIG = {
  window: { ui_scale: 1.0 },
  breaks: {
    break_percent: 25.0,
    max_break_minutes: 15,
    min_break_seconds: 60,
    crash_break_multiplier: 1.5,
    overshoot_break_multiplier: 1.2,
    push_break_multiplier: 1.25,
    auto_start_next_focus: true,
  },
  floor_engine: {
    window_n: 11,
    percentile: 0.35,
    min_frac_goal: 0.5,
    up_rate: 0.35,
    down_rate: 0.10,
    max_daily_drop_frac: 0.02
  },

  analytics: {
    floor_percentile: 0.35,
    median_percentile: 0.50,
    ceiling_percentile: 0.80,
    iqr_low_percentile: 0.25,
    iqr_high_percentile: 0.75,
    recent_window_n: 13,
    crash_min_minutes: 8,
    crash_relative_mult: 0.60,
    overshoot_mult: 1.35,
    wave_gate_max_recent_iqr_minutes: 7,
    wave_gate_max_crashes_in_recent: 1,
    wave_gate_min_floor_minutes: 14,
    drop_to_stability_if_crashes_ge: 3,
    drop_to_stability_if_overshoots_ge_in7: 3,
    drop_to_stability_if_recent_iqr_widens_pct: 0.35,
    bucket_min_n: 3,
    bucket_full_n: 9,
    bucket_recency_days: 30,
    metrics_window_n: 21,
  },
  wave: {
    cycle_length: 5,
    start_goal_minutes: 25,
    min_goal_minutes: 25,
    absolute_min_minutes: 15,
    milestone_minutes: 25,
    adaptive_min_ratio: 0.90,
    start_goal_band_low_minutes: 20,
    start_goal_band_high_minutes: 30,
    // Push (single type, intensity scales with momentum)
    push_pct_high: 0.12,
    push_pct_mid: 0.08,
    push_pct_low: 0.05,
    consolidate_band_add_minutes: 4,
    target_band_add_minutes_wave: 6,
    push_cap_add_minutes: 10,
    easy_band_add_minutes: 4,
    wave_visibility: "Subtle",
    trend_points: 30,
    // Fatigue curve
    fatigue_rate_per_block: 0.06,
    fatigue_floor: 0.75,
    // Momentum thresholds (rolling win rate over last 5)
    momentum_window: 5,
    momentum_high_threshold: 0.80,
    momentum_low_threshold: 0.40,
    // Crash recovery
    forced_easy_mild_crash: 1,
    forced_easy_hard_crash: 2,
    hard_crash_fraction: 0.80,
    // Plateau detection
    plateau_eval_blocks: 10,
    plateau_fail_ge: 4,
    plateau_flat_improve_pct: 0.01,
    plateau_volatility_up_pct: 0.15,
    // Linear progression
    linear_window_blocks: 5,
    linear_success_needed: 3,
    linear_bump_tier1_sec: 120,
    linear_bump_tier2_sec: 60,
    linear_bump_tier3_sec: 30,
    linear_bump_tier4_sec: 15,
    // Training strategy
    training_strategy: "LINEAR_THEN_WAVE",
    // Floor milestones (minutes)
    floor_milestones: [15, 20, 25, 30, 40, 50, 60, 75, 90, 120],
  },
  debug: {
    goal_override_enabled: false,
    goal_override_minutes: 25,
  },
};

/** Deep clone via JSON round-trip. */
export function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Deep merge source into target (mutates target). */
export function deepMerge(target, source) {
  if (!source) return target;
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object"
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}