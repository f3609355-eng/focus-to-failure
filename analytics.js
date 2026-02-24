import { computePlanningMetrics } from "./engine/metricsEngine.js";

/**
 * computeMetrics(blocks, cfgAnalytics)
 * Backwards-compatible wrapper used by app.js and charts.js.
 *
 * IMPORTANT: Metrics are now computed via engine/metricsEngine.js to ensure
 * consistency with the floor engine validity rules (<50% goal blocks ignored).
 *
 * NOTE: Because metricsEngine needs both floor_engine and analytics config,
 * the caller should pass the full app config. For compatibility, we accept
 * either:
 *  - cfg = full DEFAULT_CONFIG-like object (preferred)
 *  - cfg = analytics-only object (legacy), in which case we assume default floor rules
 */
export function computeMetrics(blocks, cfg){
  // If cfg looks like the full config, use it directly.
  const hasFloor = cfg && typeof cfg === "object" && cfg.floor_engine;
  const fullCfg = hasFloor ? cfg : { floor_engine: { window_n: 11, percentile: 0.35, min_frac_goal: 0.5, up_rate:0.35, down_rate:0.10, max_daily_drop_frac:0.02 }, analytics: (cfg||{}) };
  return computePlanningMetrics(blocks, fullCfg);
}
