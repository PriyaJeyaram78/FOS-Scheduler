// ---------------------------------------------------------------------------
// APP — top-level tab switching
//
// Each nav button's data-tab attribute names a view (e.g. data-tab="drill"
// matches the element with id="drill-view"). This just shows the matching
// view and hides the rest — no routing library needed for four tabs.
// ---------------------------------------------------------------------------

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;

    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));

    const targetId = `${btn.dataset.tab}-view`;
    document.querySelectorAll('.view').forEach((view) => {
      view.classList.toggle('active', view.id === targetId);
    });
  });
});
