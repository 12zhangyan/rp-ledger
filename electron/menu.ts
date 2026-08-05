import { Menu, BrowserWindow, app, shell } from 'electron'

export function setupChineseMenu(getMainWindow: () => BrowserWindow | null) {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '从旧 Excel 导入…',
          accelerator: 'CmdOrCtrl+I',
          click: () => {
            getMainWindow()?.webContents.send('menu:import-excel')
          },
        },
        {
          label: '按月导出 Excel…',
          accelerator: 'CmdOrCtrl+E',
          click: () => {
            getMainWindow()?.webContents.send('menu:export-month')
          },
        },
        {
          label: '导出票据文件夹…',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => {
            getMainWindow()?.webContents.send('menu:export-receipts')
          },
        },
        { type: 'separator' },
        {
          label: '打开数据文件夹',
          click: () => {
            getMainWindow()?.webContents.send('menu:open-data')
          },
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '查看',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制刷新', role: 'forceReload' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于印尼盾记账',
          click: () => {
            getMainWindow()?.webContents.send('menu:about')
          },
        },
        {
          label: `版本 ${app.getVersion()}`,
          enabled: false,
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

export function openPath(target: string) {
  return shell.openPath(target)
}
