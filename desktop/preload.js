'use strict';
// The only bridge between the Arena page and the window: the title bar's buttons and the pin.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skillmeApp', {
  isApp: true,
  getPinned: () => ipcRenderer.invoke('skillme:get-pinned'),
  setPinned: (on) => ipcRenderer.invoke('skillme:set-pinned', !!on),
  minimize: () => ipcRenderer.invoke('skillme:window', 'minimize'),
  toggleMaximize: () => ipcRenderer.invoke('skillme:window', 'maximize'),
  close: () => ipcRenderer.invoke('skillme:window', 'close'),
  windowState: () => ipcRenderer.invoke('skillme:window', 'state'),
  onMaximized: (cb) => ipcRenderer.on('skillme:maximized', (_e, on) => cb(!!on)), // only the flag reaches the page
});
