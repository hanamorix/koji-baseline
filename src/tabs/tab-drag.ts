// tab-drag.ts — Drag tabs to reorder them in the tab bar

export function enableTabDrag(
  tabsContainer: HTMLElement,
  onReorder: (fromIdx: number, toIdx: number) => void,
): void {
  let dragIdx = -1;
  let ghost: HTMLElement | null = null;
  let indicator: HTMLElement | null = null;
  let startX = 0;
  const DRAG_THRESHOLD = 5;

  tabsContainer.addEventListener("mousedown", (e) => {
    const tabEl = (e.target as HTMLElement).closest(".tabbar-tab") as HTMLElement | null;
    if (!tabEl) return;

    const tabs = Array.from(tabsContainer.querySelectorAll(".tabbar-tab"));
    dragIdx = tabs.indexOf(tabEl);
    if (dragIdx < 0) return;

    startX = e.clientX;
    let dragging = false;

    const onMove = (me: MouseEvent) => {
      if (!dragging && Math.abs(me.clientX - startX) > DRAG_THRESHOLD) {
        dragging = true;
        // Create ghost
        ghost = tabEl.cloneNode(true) as HTMLElement;
        ghost.className = "tab-drag-ghost";
        ghost.style.width = `${tabEl.offsetWidth}px`;
        document.body.appendChild(ghost);

        // Create drop indicator
        indicator = document.createElement("div");
        indicator.className = "tab-drop-indicator";
        tabsContainer.appendChild(indicator);
      }

      if (!dragging || !ghost || !indicator) return;

      ghost.style.left = `${me.clientX - 20}px`;
      ghost.style.top = `${me.clientY - 10}px`;

      // Find drop position
      const tabEls = Array.from(tabsContainer.querySelectorAll(".tabbar-tab"));
      let dropIdx = tabEls.length;
      for (let i = 0; i < tabEls.length; i++) {
        const rect = tabEls[i].getBoundingClientRect();
        if (me.clientX < rect.left + rect.width / 2) {
          dropIdx = i;
          break;
        }
      }

      // Position indicator
      if (dropIdx < tabEls.length) {
        const rect = tabEls[dropIdx].getBoundingClientRect();
        const containerRect = tabsContainer.getBoundingClientRect();
        indicator.style.left = `${rect.left - containerRect.left}px`;
        indicator.style.height = `${containerRect.height}px`;
      } else if (tabEls.length > 0) {
        const lastRect = tabEls[tabEls.length - 1].getBoundingClientRect();
        const containerRect = tabsContainer.getBoundingClientRect();
        indicator.style.left = `${lastRect.right - containerRect.left}px`;
        indicator.style.height = `${containerRect.height}px`;
      }
    };

    const onUp = (me: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);

      if (dragging) {
        // Calculate final drop position
        const tabEls = Array.from(tabsContainer.querySelectorAll(".tabbar-tab"));
        let dropIdx = tabEls.length;
        for (let i = 0; i < tabEls.length; i++) {
          const rect = tabEls[i].getBoundingClientRect();
          if (me.clientX < rect.left + rect.width / 2) {
            dropIdx = i;
            break;
          }
        }

        if (dropIdx !== dragIdx && dropIdx !== dragIdx + 1) {
          const adjustedDrop = dropIdx > dragIdx ? dropIdx - 1 : dropIdx;
          onReorder(dragIdx, adjustedDrop);
        }
      }

      ghost?.remove();
      indicator?.remove();
      ghost = null;
      indicator = null;
      dragIdx = -1;
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
