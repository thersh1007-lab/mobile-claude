// Preload script — runs in renderer context before page loads
// Currently minimal — can add IPC bridges here later
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  platform: process.platform,
});
