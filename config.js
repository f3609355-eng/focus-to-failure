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
    tau_blocks: 21,
    outlier_power: 2.0,
    outlier_epsilon: 1e-6,
    floor_percentile: 0.25,
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
    floor_raise_clean_streak: 5,
    floor_raise_increment_seconds: 45,
    push_a_pct_of_median: 0.10,
    push_b_pct_of_median: 0.07,
    target_band_add_minutes_stability: 4,
    target_band_add_minutes_wave: 6,
    push_cap_add_minutes: 10,
    forced_easy_consolidate_blocks_after_crash: 2,
    easy_consolidate_band_add_minutes: 4,
    wave_visibility: "Subtle",
    trend_points: 30,
  },
  ux: {
    prompt_on_target_reached: true,
    auto_stop_at_target_high: false,
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