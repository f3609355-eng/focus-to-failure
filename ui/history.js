export function createHistoryUI(deps) {
  const { $, $set, getBlocks, getFilters, setFilters, fmtHHMMSS, escHTML } = deps;

  function yesNo(v) { return v ? "Yes" : "No"; }

  function rowHTML(b) {
    const focus = fmtHHMMSS(Number(b.focus_seconds || 0));
    const goal  = fmtHHMMSS(Number(b.goal_seconds || 0));
    const brk   = fmtHHMMSS(Number(b.break_seconds || 0));
    const tl    = fmtHHMMSS(Number(b.target_low_seconds || 0));
    const th    = fmtHHMMSS(Number(b.target_high_seconds || 0));
    const push  = b.push_target_seconds ? fmtHHMMSS(Number(b.push_target_seconds)) : "--";
    const pauses = b.pause_count > 0 ? `${b.pause_count}` : "--";
    return `<tr>
      <td>${escHTML(b.idx)}</td>
      <td>${escHTML(b.phase || "--")}</td>
      <td>${escHTML(b.block_type || "--")}</td>
      <td>${focus}</td><td>${goal}</td><td>${brk}</td>
      <td>${tl}</td><td>${th}</td><td>${push}</td>
      <td>${yesNo(b.crash)}</td>
      <td>${b.overshoot ? fmtHHMMSS(Number(b.overshoot)) : "--"}</td>
      <td>${escHTML(b.stop_reason || "--")}</td>
      <td>${pauses}</td>
      <td>${escHTML(b.bucket || "--")}</td>
      <td>${escHTML(b.timestamp || "--")}</td>
    </tr>`;
  }

  function uniqueSortedValues(values) {
    return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
  }

  function syncFilterOptions() {
    const blocks = getBlocks();
    const filters = getFilters();
    const bindOptions = (id, label, values, current) => {
      const el = $(id);
      if (!el) return;
      const options = [`<option value="ALL">${label}</option>`]
        .concat(values.map(v => `<option value="${escHTML(String(v))}">${escHTML(String(v))}</option>`));
      el.innerHTML = options.join("");
      el.value = values.includes(current) ? current : "ALL";
    };

    bindOptions("historyPhaseFilter", "All phases", uniqueSortedValues(blocks.map(b => b.phase || "--")), filters.phase);
    bindOptions("historyTypeFilter", "All types", uniqueSortedValues(blocks.map(b => b.block_type || "--")), filters.blockType);
    bindOptions("historyStopFilter", "All outcomes", uniqueSortedValues(blocks.map(b => b.stop_reason || "--")), filters.stopReason);
  }

  function getVisibleBlocks() {
    const blocks = getBlocks();
    const filters = getFilters();
    const q = filters.query.trim().toLowerCase();
    let visible = blocks.filter((b) => {
      if (filters.phase !== "ALL" && (b.phase || "--") !== filters.phase) return false;
      if (filters.blockType !== "ALL" && (b.block_type || "--") !== filters.blockType) return false;
      if (filters.stopReason !== "ALL" && (b.stop_reason || "--") !== filters.stopReason) return false;
      if (!q) return true;
      const haystack = [
        b.idx,
        b.phase,
        b.block_type,
        b.stop_reason,
        b.bucket,
        b.timestamp,
        b.validity,
      ].map(v => String(v || "").toLowerCase()).join(" ");
      return haystack.includes(q);
    });

    if (filters.newestFirst) visible = [...visible].reverse();
    return visible;
  }

  function renderSummary(visibleBlocks) {
    const el = $("historySummary");
    if (!el) return;
    if (!visibleBlocks.length) {
      el.textContent = "No blocks match the current filters.";
      return;
    }

    const totalFocus = visibleBlocks.reduce((sum, b) => sum + Number(b.focus_seconds || 0), 0);
    const wins = visibleBlocks.filter(b => Number(b.goal_seconds || 0) > 0 && Number(b.focus_seconds || 0) >= Number(b.goal_seconds || 0)).length;
    const avgFocus = Math.round(totalFocus / visibleBlocks.length);
    el.textContent = `${visibleBlocks.length} block${visibleBlocks.length === 1 ? "" : "s"} · ${fmtHHMMSS(totalFocus)} focus · avg ${fmtHHMMSS(avgFocus)} · ${wins} goal hit${wins === 1 ? "" : "s"}`;
  }

  function render() {
    syncFilterOptions();
    const visibleBlocks = getVisibleBlocks();
    $set("historyBody", "innerHTML", visibleBlocks.map(rowHTML).join(""));
    renderSummary(visibleBlocks);
  }

  function patchFilters(patch) {
    setFilters({ ...getFilters(), ...patch });
    render();
  }

  function wire() {
    $("historySearch")?.addEventListener("input", (e) => patchFilters({ query: e.target.value || "" }));
    $("historyPhaseFilter")?.addEventListener("change", (e) => patchFilters({ phase: e.target.value || "ALL" }));
    $("historyTypeFilter")?.addEventListener("change", (e) => patchFilters({ blockType: e.target.value || "ALL" }));
    $("historyStopFilter")?.addEventListener("change", (e) => patchFilters({ stopReason: e.target.value || "ALL" }));
    $("historyReverseToggle")?.addEventListener("change", (e) => patchFilters({ newestFirst: !!e.target.checked }));
  }

  return { render, wire, getVisibleBlocks };
}
