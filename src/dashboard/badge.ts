// badge.ts — LLM badge update helper
// Centralizes the model name + dot color updates to avoid hardcoded theme colors.

/** Update the LLM badge in the dashboard with the model name and status dot. */
export function updateLlmBadge(modelName?: string, ready = true): void {
  const root = getComputedStyle(document.documentElement);
  const warm = root.getPropertyValue("--koji-warm").trim();
  const deep = root.getPropertyValue("--koji-deep").trim();

  const modelEl = document.getElementById("llm-model");
  const dotEl = document.getElementById("llm-dot");

  if (modelName && modelEl) modelEl.textContent = modelName;
  if (dotEl) dotEl.style.background = ready ? warm : deep;
}
