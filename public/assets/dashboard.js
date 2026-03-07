import { initDashboardPage } from './dashboard.page.js';

initDashboardPage().catch((error) => {
  const stateNode = document.getElementById('tracksState');
  if (stateNode) {
    stateNode.textContent = `Fehler: ${error.message}`;
  }
});
