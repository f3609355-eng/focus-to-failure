export function bindChange(el, handler) {
  el?.addEventListener("change", handler);
}

export function bindInput(el, handler) {
  el?.addEventListener("input", handler);
}
