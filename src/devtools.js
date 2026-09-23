// Runs once per DevTools window: registers the Postcat panel and forwards DevTools' search bar to it.
let panelWindow = null;

chrome.devtools.panels.create('Postcat', 'icons/icon16.png', 'src/panel.html', (panel) => {
  panel.onShown.addListener((win) => {
    panelWindow = win;
  });
  // DevTools' own search bar (⌘/Ctrl+F) sends its queries to the shown extension panel.
  panel.onSearch.addListener((action, query) => {
    panelWindow?.postcatSearch?.(action, query);
  });
});
