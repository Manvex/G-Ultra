const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gultraNative', {
  rpc: (method, params) => ipcRenderer.invoke('rpc', method, params),
  window: (action) => ipcRenderer.invoke('window', action),
  elevate: () => ipcRenderer.invoke('elevate'),
  installDriver: () => ipcRenderer.invoke('installDriver'),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  trash: (p) => ipcRenderer.invoke('trash', p),
  openLink: (url) => ipcRenderer.invoke('openLink', url),
  fileIcon: (p) => ipcRenderer.invoke('fileIcon', p),
  setProgress: (value) => ipcRenderer.invoke('setProgress', value),
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),
  onEvent: (cb) => {
    const fn = (_e, name, data) => cb(name, data);
    ipcRenderer.on('helper-event', fn);
    return () => ipcRenderer.removeListener('helper-event', fn);
  },
});
