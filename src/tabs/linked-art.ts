// linked-art.ts — "LINKED" animation for new tab creation

export function playLinkedAnimation(container: HTMLElement): void {
  const overlay = document.createElement("div");
  overlay.className = "linked-overlay";

  const text = document.createElement("div");
  text.className = "linked-text";
  text.textContent = "L I N K E D";
  overlay.appendChild(text);

  container.appendChild(overlay);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      text.classList.add("fade-out");
    });
  });

  setTimeout(() => { overlay.remove(); }, 1800);
}
