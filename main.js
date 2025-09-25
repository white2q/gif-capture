const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, clipboard, shell, nativeImage, dialog, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

// 获取FFmpeg路径，优先使用 @ffmpeg-installer 提供的路径，并兼容 asar.unpacked
function getFFmpegPath() {
  try {
    let installerPath = require('@ffmpeg-installer/ffmpeg').path;
    // 打包后把 app.asar 替换为 app.asar.unpacked，确保可执行文件在解压目录
    if (app.isPackaged && typeof installerPath === 'string') {
      installerPath = installerPath.replace('app.asar', 'app.asar.unpacked');
    }
    if (installerPath && fs.existsSync(installerPath)) {
      return installerPath;
    }

    // 回退到 extraResources 路径（若配置了额外拷贝）
    const resPath = path.join(process.resourcesPath || path.dirname(process.execPath), 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(resPath)) return resPath;

    // 最后回退系统 PATH
    return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  } catch (error) {
    console.error('获取FFmpeg路径失败:', error);
    return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  }
}

const ffmpegPath = getFFmpegPath();

// 检测FFmpeg是否可用
function checkFFmpegAvailability() {
  try {
    // 如果路径不是系统PATH，检查文件是否存在
    if (ffmpegPath !== 'ffmpeg.exe' && !fs.existsSync(ffmpegPath)) {
      return false;
    }
    
    const result = spawnSync(ffmpegPath, ['-version'], { 
      stdio: 'pipe',
      timeout: 5000 
    });
    
    return result.status === 0;
  } catch (error) {
    console.error('FFmpeg检测失败:', error);
    return false;
  }
}

// 确保日志在 Windows 上不会出现 GBK/ANSI 的乱码
const iconv = require('iconv-lite');

// 尝试将 Buffer 解码为 UTF-8，若包含非 UTF-8 字节（如 GBK/CP936）则使用 GBK 解码后返回 UTF-8 字符串
function decodeBuffer(buf) {
  // 在 Windows 上 FFmpeg 等外部程序经常使用 GBK/CP936 输出，直接用 gbk 解码更稳妥
  if (process.platform === 'win32') {
    try {
      return iconv.decode(buf, 'gbk');
    } catch (e) {
      return buf.toString('utf8');
    }
  }

  // 非 Windows 平台仍优先尝试 UTF-8，若含替换字符则回退到 GBK
  try {
    const utf8 = buf.toString('utf8');
    if (utf8.includes('\uFFFD')) {
      return iconv.decode(buf, 'gbk');
    }
    return utf8;
  } catch (e) {
    try {
      return iconv.decode(buf, 'gbk');
    } catch (e2) {
      return buf.toString();
    }
  }
}

// 可选：将日志写入 UTF-8 文件以避免控制台编码导致的显示问题
const LOG_TO_FILE = (process.env.LOG_TO_FILE === '1' || process.env.LOG_TO_FILE === 'true');
const logFilePath = path.join(os.homedir(), 'gif-capture.log');
// 保留原始 console 方法（备用）
const _origConsoleLog = console.log.bind(console);
const _origConsoleError = console.error.bind(console);

function writeLogToFile(line) {
  if (!LOG_TO_FILE) return;
  try {
    // 确保以 UTF-8 写入
    fs.appendFileSync(logFilePath, line + '\n', { encoding: 'utf8' });
  } catch (e) {
    // 如果文件写入失败，退回到原始错误输出（这可能再次乱码，但会显示错误）
    _origConsoleError('写入日志文件失败:', e.message || e);
  }
}

// 控制台输出编码：在 Windows 上默认将 UTF-8 字符串编码为 GBK 再写入 stdout/stderr，
// 以便在未切换到 UTF-8 代码页的 cmd/PowerShell 中正确显示中文。
// 可通过环境变量 `CONSOLE_ENCODING=utf8` 强制输出 UTF-8（例如在 chcp 65001 的终端中）。
const CONSOLE_ENCODING = (process.env.CONSOLE_ENCODING || (process.platform === 'win32' ? 'gbk' : 'utf8')).toLowerCase();

function formatArgs(args) {
  return args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}

console.log = (...args) => {
  const line = formatArgs(args);
  writeLogToFile(line);

  if (process.platform === 'win32' && CONSOLE_ENCODING === 'gbk') {
    try {
      const buf = iconv.encode(line + '\n', 'gbk');
      process.stdout.write(buf);
      return;
    } catch (e) {
      // 回退到原始方法
      _origConsoleLog(line);
      return;
    }
  }

  // 非 Windows 或显式要求 utf8：使用原始 console 输出
  _origConsoleLog(line);
};

console.error = (...args) => {
  const line = formatArgs(args);
  writeLogToFile('[ERROR] ' + line);

  if (process.platform === 'win32' && CONSOLE_ENCODING === 'gbk') {
    try {
      const buf = iconv.encode('[ERROR] ' + line + '\n', 'gbk');
      process.stderr.write(buf);
      return;
    } catch (e) {
      _origConsoleError(line);
      return;
    }
  }

  _origConsoleError(line);
};

let mainWindow;
let overlayWindow;
let tray = null;
let isQuitting = false;
let isRecording = false;
let recordingProcess = null;
let registeredShortcuts = {};
let currentTempFile = null;
let cachedSettings = null;

const DEFAULT_SHORTCUTS = {
  fullscreen: 'CommandOrControl+Shift+G',
  region: 'CommandOrControl+Shift+R'
};

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      cachedSettings = data || {};
      return cachedSettings;
    }
  } catch (e) {
    console.error('加载设置失败，将使用默认值:', e && e.message ? e.message : e);
  }
  cachedSettings = {};
  return cachedSettings;
}

function saveSettings(next) {
  try {
    const settingsPath = getSettingsPath();
    let data = loadSettings();
    data = { ...(data || {}), ...(next || {}) };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf8');
    cachedSettings = data;
  } catch (e) {
    console.error('保存设置失败:', e && e.message ? e.message : e);
  }
}

function loadShortcuts() {
  const settings = loadSettings();
  const fromFile = (settings && settings.shortcuts) ? settings.shortcuts : {};
  return { ...DEFAULT_SHORTCUTS, ...fromFile };
}

function saveShortcuts(shortcuts) {
  const merged = { ...(cachedSettings || loadSettings()) };
  merged.shortcuts = shortcuts;
  saveSettings(merged);
}

function getSavePath() {
  const settings = cachedSettings || loadSettings();
  return settings && settings.savePath ? settings.savePath : null;
}

function setSavePath(dir) {
  const next = { ...(cachedSettings || loadSettings()), savePath: dir };
  saveSettings(next);
}

function unregisterShortcut(name) {
  try {
    if (registeredShortcuts[name]) {
      globalShortcut.unregister(registeredShortcuts[name]);
      delete registeredShortcuts[name];
    }
  } catch (e) {
    // ignore
  }
}

function registerAllShortcuts(shortcuts) {
  // 清理旧的
  try { globalShortcut.unregisterAll(); } catch (_) {}
  registeredShortcuts = {};

  // 全屏录制
  if (shortcuts.fullscreen) {
    const ok = globalShortcut.register(shortcuts.fullscreen, () => {
      if (mainWindow) {
        mainWindow.webContents.send('hotkey-fullscreen');
      }
    });
    if (ok) registeredShortcuts.fullscreen = shortcuts.fullscreen; else console.error('注册全屏快捷键失败:', shortcuts.fullscreen);
  }

  // 区域录制
  if (shortcuts.region) {
    const ok2 = globalShortcut.register(shortcuts.region, () => {
      if (mainWindow) {
        mainWindow.webContents.send('hotkey-region');
      }
    });
    if (ok2) registeredShortcuts.region = shortcuts.region; else console.error('注册区域快捷键失败:', shortcuts.region);
  }
}

// 尝试把图片文件复制到剪贴板，优先使用 nativeImage.createFromPath，回退 createFromBuffer，最后尝试用 FFmpeg 提取第一帧为 PNG 再复制
function copyImageFileToClipboard(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const ext = path.extname(filePath).toLowerCase();

    // 如果是 GIF，优先尝试把原始 GIF bytes 写入 clipboard 的 image/gif 格式
    if (ext === '.gif') {
      try {
        const buf = fs.readFileSync(filePath);
        try {
          clipboard.writeBuffer('image/gif', buf);
          console.log('已将原始 GIF bytes 写入剪贴板 (image/gif):', filePath);
        } catch (e) {
          console.error('写入 image/gif 失败:', e && e.message ? e.message : e);
        }

        // 尝试把文件名写入 Windows 的 FileNameW（UCS-2 little endian）以支持文件粘贴的应用
        try {
          if (process.platform === 'win32') {
            // UTF-16LE (ucs2) with double null termination for FileNameW
            const ucs2 = Buffer.from(filePath + '\u0000', 'ucs2');
            clipboard.writeBuffer('FileNameW', ucs2);
            console.log('已写入 FileNameW 到剪贴板以支持文件粘贴:', filePath);
          }
          if (process.platform === 'darwin') {
            // public.file-url with file:// URL
            const fileUrl = 'file://' + filePath;
            clipboard.writeBuffer('public.file-url', Buffer.from(fileUrl, 'utf8'));
            console.log('已写入 public.file-url 到剪贴板以支持文件粘贴:', fileUrl);
          }
        } catch (e) {
          console.error('写入文件名相关剪贴板格式失败:', e && e.message ? e.message : e);
        }

        // 如果至少写入 image/gif 成功，我们认为复制成功（即使某些目标应用可能不读取该格式）
        return true;
      } catch (e) {
        console.error('读取 GIF 文件失败:', e && e.message ? e.message : e);
      }
    }

    // 1) 尝试 createFromPath（有时更可靠）
    try {
      const img = nativeImage.createFromPath(filePath);
      if (img && !img.isEmpty()) {
        try {
          clipboard.writeImage(img);
          console.log('已使用 nativeImage.createFromPath 复制图片到剪贴板:', filePath);
          return true;
        } catch (e) {
          console.error('clipboard.writeImage(createFromPath) 失败:', e && e.message ? e.message : e);
        }
      }
    } catch (e) {
      console.error('nativeImage.createFromPath 失败:', e && e.message ? e.message : e);
    }

    // 2) 尝试从 Buffer 创建
    try {
      const buf = fs.readFileSync(filePath);
      const img = nativeImage.createFromBuffer(buf);
      if (img && !img.isEmpty()) {
        try {
          clipboard.writeImage(img);
          console.log('已使用 nativeImage.createFromBuffer 复制图片到剪贴板:', filePath);
          return true;
        } catch (e) {
          console.error('clipboard.writeImage(createFromBuffer) 失败:', e && e.message ? e.message : e);
        }
      }
    } catch (e) {
      console.error('从文件读取或 createFromBuffer 失败:', e && e.message ? e.message : e);
    }

    // 3) 最后尝试用 FFmpeg 提取第一帧为 PNG（需要 ffmpeg 可用）
    try {
      const tmpPng = path.join(os.tmpdir(), `gif-frame-${Date.now()}.png`);
      const args = ['-y', '-i', filePath, '-vframes', '1', tmpPng];
      console.log('尝试用 FFmpeg 提取第一帧为 PNG:', ffmpegPath, args.join(' '));
      const res = spawnSync(ffmpegPath, args, { stdio: 'inherit' });
      if (res && res.error) {
        console.error('FFmpeg 提取帧失败:', res.error && res.error.message ? res.error.message : res.error);
      }
      if (fs.existsSync(tmpPng)) {
        try {
          const img2 = nativeImage.createFromPath(tmpPng);
          if (img2 && !img2.isEmpty()) {
            clipboard.writeImage(img2);
            console.log('已复制从 GIF 提取的 PNG 到剪贴板:', tmpPng);
            try { fs.unlinkSync(tmpPng); } catch (_) {}
            return true;
          }
        } catch (e) {
          console.error('处理提取的 PNG 失败:', e && e.message ? e.message : e);
        }
        try { fs.unlinkSync(tmpPng); } catch (_) {}
      }
    } catch (e) {
      console.error('用 FFmpeg 提取帧并复制失败:', e && e.message ? e.message : e);
    }
  } catch (e) {
    console.error('copyImageFileToClipboard 整体失败:', e && e.message ? e.message : e);
  }
  return false;
}

// 自动复制到剪贴板的辅助函数
function autoCopyToClipboard(filePath) {
  // 添加延迟确保文件完全写入
  setTimeout(() => {
    try {
      if (!fs.existsSync(filePath)) {
        console.log('文件不存在，无法复制:', filePath);
        return false;
      }

      const ok = copyImageFileToClipboard(filePath);
      if (!ok) {
        try { clipboard.writeText(filePath); } catch (e) { console.error('回退写入路径失败:', e && e.message ? e.message : e); }
        console.log('已复制文件路径到剪贴板:', filePath);
      }
      return ok;
    } catch (error) {
      console.error('自动复制到剪贴板失败:', error && error.message ? error.message : error);
      try { clipboard.writeText(filePath); } catch (_) {}
    }
    return false;
  }, 1000); // 延迟1秒
}

// 转换格式函数
function convertToFormat(inputFile, outputFile, format, width, fps, duration) {
  return new Promise((resolve, reject) => {
    let convertArgs = [];
    
    if (format === 'gif') {
      // 生成调色板
      const paletteFile = inputFile.replace('.mp4', '-palette.png');
      const paletteArgs = ['-i', inputFile, '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,palettegen`, '-y', paletteFile];
      
      console.log('生成调色板命令:', ffmpegPath, paletteArgs.join(' '));
      
      const paletteProcess = spawn(ffmpegPath, paletteArgs);
      
      paletteProcess.on('close', (code) => {
        if (code === 0) {
          // 使用调色板生成GIF
          convertArgs = [
            '-i', inputFile,
            '-i', paletteFile,
            '-filter_complex', `fps=${fps},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse`,
            '-y', outputFile
          ];
          
          console.log('转换GIF命令:', ffmpegPath, convertArgs.join(' '));
          
          const gifProcess = spawn(ffmpegPath, convertArgs);
          let stderr = '';
          
          gifProcess.stderr.on('data', (data) => {
            const chunk = Buffer.isBuffer(data) ? decodeBuffer(data) : String(data);
            stderr += chunk;
            const progressMatch = stderr.match(/time=(\d+):(\d+):(\d+\.\d+)/);
            if (progressMatch) {
              const hours = parseInt(progressMatch[1]);
              const minutes = parseInt(progressMatch[2]);
              const seconds = parseFloat(progressMatch[3]);
              const totalSeconds = hours * 3600 + minutes * 60 + seconds;
              const percent = 50 + Math.min(Math.round((totalSeconds / duration) * 50), 50); // 转换占50%
              mainWindow.webContents.send('recording-progress', percent);
            }
          });
          
          gifProcess.on('close', (code) => {
            // 清理调色板文件
            if (fs.existsSync(paletteFile)) {
              fs.unlinkSync(paletteFile);
            }
            
            if (code === 0) {
              console.log('GIF转换完成');
              resolve();
            } else {
              reject(new Error(`GIF转换失败，退出码: ${code}`));
            }
          });
          
          gifProcess.on('error', (err) => {
            reject(err);
          });
        } else {
          reject(new Error(`调色板生成失败，退出码: ${code}`));
        }
      });
      
      paletteProcess.on('error', (err) => {
        reject(err);
      });
      
    } else if (format === 'webm') {
      convertArgs = [
        '-i', inputFile,
        '-c:v', 'libvpx-vp9',
        '-crf', '10',
        '-b:v', '0',
        '-vf', `scale=${width}:-1`,
        '-pix_fmt', 'yuva420p',
        '-y', outputFile
      ];
      
      console.log('转换WebM命令:', ffmpegPath, convertArgs.join(' '));
      
      const convertProcess = spawn(ffmpegPath, convertArgs);
      let stderr = '';
      
      convertProcess.stderr.on('data', (data) => {
        const chunk = Buffer.isBuffer(data) ? decodeBuffer(data) : String(data);
        stderr += chunk;
        const progressMatch = stderr.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (progressMatch) {
          const hours = parseInt(progressMatch[1]);
          const minutes = parseInt(progressMatch[2]);
          const seconds = parseFloat(progressMatch[3]);
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;
          const percent = 50 + Math.min(Math.round((totalSeconds / duration) * 50), 50);
          mainWindow.webContents.send('recording-progress', percent);
        }
      });
      
      convertProcess.on('close', (code) => {
        if (code === 0) {
          console.log('WebM转换完成');
          resolve();
        } else {
          reject(new Error(`WebM转换失败，退出码: ${code}`));
        }
      });
      
      convertProcess.on('error', (err) => {
        reject(err);
      });
    } else {
      reject(new Error(`不支持的格式: ${format}`));
    }
  });
}

// 创建主窗口
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 680,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    resizable: true,
    minWidth: 420,
    minHeight: 600,
    title: 'GIF Capture Tool',
    icon: path.join(__dirname, 'assets/tray-icon.png')
  });

  mainWindow.setMenu( null);

  mainWindow.loadFile('index.html');

  // 开发模式下打开开发者工具
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // 处理窗口关闭事件，隐藏到托盘而不是真正关闭
  mainWindow.on('close', (event) => {
    // 在Windows和Linux上，关闭窗口时隐藏到托盘；若是用户选择退出，则允许关闭
    if (process.platform !== 'darwin' && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

// 创建区域选择覆盖窗口
function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  
  overlayWindow = new BrowserWindow({
    width: width,
    height: height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  overlayWindow.loadFile('overlay.html');
  overlayWindow.setFullScreen(true);
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    try {
      if (mainWindow && !isRecording) {
        mainWindow.show();
        mainWindow.focus();
      }
    } catch (_) {}
  });
}

// 更新托盘菜单
function updateTrayMenu() {
  if (!tray) return;
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: '隐藏窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.hide();
        }
      }
    },
    { type: 'separator' },
    {
      label: isRecording ? '正在录制中...' : '开始录制全屏',
      enabled: !isRecording,
      click: () => {
        if (mainWindow && !isRecording) {
          mainWindow.webContents.send('hotkey-fullscreen');
        }
      }
    },
    {
      label: '选择区域录制',
      enabled: !isRecording,
      click: () => {
        if (mainWindow && !isRecording) {
          mainWindow.webContents.send('hotkey-region');
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出应用',
      click: () => {
        console.log('用户点击退出应用');
        isQuitting = true;
        // 清理资源
        try {
          if (recordingProcess) {
            recordingProcess.kill('SIGTERM');
          }
        } catch (e) {
          console.error('清理录制进程失败:', e);
        }
        
        try {
          if (currentTempFile && fs.existsSync(currentTempFile)) {
            fs.unlinkSync(currentTempFile);
          }
        } catch (e) {
          console.error('清理临时文件失败:', e);
        }
        
        // 注销快捷键
        try {
          globalShortcut.unregisterAll();
        } catch (e) {
          console.error('注销快捷键失败:', e);
        }
        
        // 销毁托盘
        try {
          if (tray) {
            tray.destroy();
            tray = null;
          }
        } catch (e) {
          console.error('销毁托盘失败:', e);
        }
        
        // 退出应用
        try { app.quit(); } catch (_) {}
      }
    }
  ]);
  
  tray.setContextMenu(contextMenu);
}

// 创建托盘
function createTray() {
  const trayIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  tray = new Tray(trayIconPath);
  
  updateTrayMenu();
  tray.setToolTip('GIF Capture Tool');
  
  // 双击托盘图标显示/隐藏窗口
  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

// 应用准备就绪
app.whenReady().then(() => {
  createMainWindow();
  createTray();

  // 加载并注册全局快捷键
  const shortcuts = loadShortcuts();
  registerAllShortcuts(shortcuts);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

// 添加错误处理
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', reason);
});

// 所有窗口关闭时退出应用
app.on('window-all-closed', () => {
  // 在Windows和Linux上，当所有窗口关闭时不退出应用，而是隐藏到托盘
  // 在macOS上保持原有行为
  if (process.platform === 'darwin') {
    app.quit();
  }
  // 其他平台不退出，应用继续在托盘中运行
});
// 选择保存路径
ipcMain.handle('choose-save-path', async () => {
  try {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) {
      return { success: false, message: '已取消选择' };
    }
    const dir = res.filePaths[0];
    setSavePath(dir);
    return { success: true, path: dir };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : String(e) };
  }
});

// 获取保存路径
ipcMain.handle('get-save-path', () => {
  try {
    const p = getSavePath();
    return { success: true, path: p };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : String(e) };
  }
});

// 应用即将退出时注销快捷键
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try {
    if (recordingProcess) {
      recordingProcess.kill('SIGTERM');
    }
  } catch (_) {}
  try {
    if (currentTempFile && fs.existsSync(currentTempFile)) {
      fs.unlinkSync(currentTempFile);
    }
  } catch (_) {}
  try { currentTempFile = null; } catch (_) {}
});

// IPC 事件处理
ipcMain.handle('get-shortcuts', () => {
  try {
    const s = loadShortcuts();
    return { success: true, shortcuts: s };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('set-shortcuts', (event, next) => {
  try {
    const merged = { ...DEFAULT_SHORTCUTS, ...next };
    // 尝试注册新快捷键
    registerAllShortcuts(merged);
    // 持久化
    saveShortcuts(merged);
    return { success: true, shortcuts: merged };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('reset-shortcuts', () => {
  try {
    registerAllShortcuts(DEFAULT_SHORTCUTS);
    saveShortcuts(DEFAULT_SHORTCUTS);
    return { success: true, shortcuts: { ...DEFAULT_SHORTCUTS } };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : String(e) };
  }
});
// 暂停/恢复全局快捷键（用于在录入快捷键时避免冲突）
ipcMain.handle('pause-shortcuts', () => {
  try {
    globalShortcut.unregisterAll();
    return { success: true };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('resume-shortcuts', () => {
  try {
    const s = loadShortcuts();
    registerAllShortcuts(s);
    return { success: true };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle('get-screen-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen']
    });
    return sources;
  } catch (error) {
    console.error('获取屏幕源失败:', error);
    return [];
  }
});

// 开始录制
ipcMain.handle('start-recording', async (event, options = {}) => {
  if (isRecording) {
    return { success: false, message: '正在录制中...' };
  }

  // 检查FFmpeg是否可用
  if (!checkFFmpegAvailability()) {
    return { 
      success: false, 
      message: `FFmpeg不可用，请检查安装。路径: ${ffmpegPath}` 
    };
  }

  const {
    duration = 1,
    fps = 15,
    width = 640,
    format = 'gif',
    region = null // {x, y, width, height}
  } = options;

  try {
    // 先隐藏窗口，而不是最小化，避免缩放过程被录制
    mainWindow.hide();
    
    // 等待一小段时间确保窗口完全隐藏
    await new Promise(resolve => setTimeout(resolve, 300));
    
    isRecording = true;
    mainWindow.webContents.send('recording-started');
    updateTrayMenu();
    const preferredDir = getSavePath();
    const saveDir = (preferredDir && fs.existsSync(preferredDir)) ? preferredDir : path.join(os.homedir(), 'Desktop');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tempFile = path.join(saveDir, `temp-capture-${timestamp}.mp4`);
    currentTempFile = tempFile;
    const outputFile = path.join(saveDir, `capture-${timestamp}.${format}`);

    // 构建FFmpeg录制命令参数
    let recordArgs = [];
    
    if (process.platform === 'win32') {
      // Windows: 使用 gdigrab
      recordArgs.push('-f', 'gdigrab');
      if (region) {
        recordArgs.push('-offset_x', region.x.toString());
        recordArgs.push('-offset_y', region.y.toString());
        recordArgs.push('-video_size', `${region.width}x${region.height}`);
        // 添加显示偏移参数以确保坐标正确
        recordArgs.push('-show_region', '1');
      }
      recordArgs.push('-framerate', fps.toString());
      recordArgs.push('-i', 'desktop');
    } else if (process.platform === 'darwin') {
      // macOS: 使用 avfoundation
      recordArgs.push('-f', 'avfoundation');
      recordArgs.push('-framerate', fps.toString());
      if (region) {
        recordArgs.push('-video_size', `${region.width}x${region.height}`);
      }
      recordArgs.push('-i', '1:0');
    } else {
      // Linux: 使用 x11grab
      recordArgs.push('-f', 'x11grab');
      recordArgs.push('-framerate', fps.toString());
      if (region) {
        recordArgs.push('-video_size', `${region.width}x${region.height}`);
        recordArgs.push('-i', `:0.0+${region.x},${region.y}`);
      } else {
        recordArgs.push('-i', ':0.0');
      }
    }

    // 添加录制参数
    recordArgs.push('-t', options.duration.toString());
    recordArgs.push('-c:v', 'libx264');
    recordArgs.push('-preset', 'ultrafast');
    recordArgs.push('-pix_fmt', 'yuv420p');
    recordArgs.push('-crf', '18');
    recordArgs.push('-y', tempFile);

    console.log('FFmpeg 录制命令:', ffmpegPath, recordArgs.join(' '));

    // 执行录制
    return new Promise((resolve, reject) => {
      // 第一步：录制MP4
      recordingProcess = spawn(ffmpegPath, recordArgs);
      
      let stderr = '';
      
      recordingProcess.stderr.on('data', (data) => {
        const chunk = Buffer.isBuffer(data) ? decodeBuffer(data) : String(data);
        stderr += chunk;
        console.log('FFmpeg stderr:', chunk);
        
        // 解析进度信息
        const progressMatch = stderr.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (progressMatch) {
          const hours = parseInt(progressMatch[1]);
          const minutes = parseInt(progressMatch[2]);
          const seconds = parseFloat(progressMatch[3]);
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;
          const percent = Math.min(Math.round((totalSeconds / duration) * 50), 50); // 录制占50%
          console.log(`录制进度: ${percent}% (${totalSeconds.toFixed(1)}s / ${duration}s)`);
          mainWindow.webContents.send('recording-progress', percent);
        }
      });

      recordingProcess.on('close', (code) => {
        if (code === 0) {
          console.log('录制完成，开始转换...');
          mainWindow.webContents.send('recording-progress', 50);
          
          // 第二步：根据格式转换
          if (options.format === 'mp4') {
            // 直接重命名MP4文件
            fs.renameSync(tempFile, outputFile);
            isRecording = false;
            updateTrayMenu();
            try { currentTempFile = null; } catch (_) {}
            try { mainWindow.show(); mainWindow.focus(); } catch (_) {}
            mainWindow.webContents.send('recording-completed', { filePath: outputFile });
            // 对于非GIF格式，不需要复制到剪贴板，而是直接打开保存地址
            try { shell.showItemInFolder(outputFile); } catch (e) { console.error('打开文件位置失败:', e && e.message ? e.message : e); }
            resolve({ success: true, filePath: outputFile });
          } else if (options.format === 'webm') {
            // 转换为WebM
            convertToFormat(tempFile, outputFile, options.format, options.width, options.fps, options.duration)
              .then(() => {
                // 删除临时文件
                if (fs.existsSync(tempFile)) {
                  try { fs.unlinkSync(tempFile); } catch (_) {}
                }
                isRecording = false;
                updateTrayMenu();
                try { currentTempFile = null; } catch (_) {}
                // 录制结束后显示窗口
                mainWindow.show();
                mainWindow.focus();
                mainWindow.webContents.send('recording-completed', { filePath: outputFile });
                // 对于非GIF格式，不需要复制到剪贴板，而是直接打开保存地址
                try { shell.showItemInFolder(outputFile); } catch (e) { console.error('打开文件位置失败:', e && e.message ? e.message : e); }
                resolve({ success: true, filePath: outputFile });
              })
              .catch((err) => {
                isRecording = false;
                updateTrayMenu();
                try {
                  if (currentTempFile && fs.existsSync(currentTempFile)) {
                    fs.unlinkSync(currentTempFile);
                  }
                } catch (_) {}
                try { currentTempFile = null; } catch (_) {}
                mainWindow.webContents.send('recording-error', err.message);
                reject({ success: false, message: err.message });
              });
          } else {
            // 转换为GIF
            convertToFormat(tempFile, outputFile, options.format, options.width, options.fps, options.duration)
              .then(() => {
                // 删除临时文件
                if (fs.existsSync(tempFile)) {
                  try { fs.unlinkSync(tempFile); } catch (_) {}
                }
                isRecording = false;
                updateTrayMenu();
                try { currentTempFile = null; } catch (_) {}
                // 录制结束后显示窗口
                mainWindow.show();
                mainWindow.focus();
                mainWindow.webContents.send('recording-completed', { filePath: outputFile });
                // 自动复制到剪贴板（保护性 try/catch）
                try { autoCopyToClipboard(outputFile); } catch (e) { console.error('自动复制到剪贴板失败:', e && e.message ? e.message : e); }
                resolve({ success: true, filePath: outputFile });
              })
              .catch((err) => {
                isRecording = false;
                updateTrayMenu();
                try {
                  if (currentTempFile && fs.existsSync(currentTempFile)) {
                    fs.unlinkSync(currentTempFile);
                  }
                } catch (_) {}
                try { currentTempFile = null; } catch (_) {}
                mainWindow.webContents.send('recording-error', err.message);
                reject({ success: false, message: err.message });
              });
          }
        } else {
          isRecording = false;
          mainWindow.webContents.send('recording-error', `录制失败，FFmpeg 退出码: ${code}`);
          reject({ success: false, message: `录制失败，FFmpeg 退出码: ${code}` });
        }
      });

      recordingProcess.on('error', (err) => {
        isRecording = false;
        mainWindow.webContents.send('recording-error', err.message);
        reject({ success: false, message: err.message });
      });
    });

  } catch (error) {
    isRecording = false;
    updateTrayMenu();
    mainWindow.webContents.send('recording-error', error.message);
    return { success: false, message: error.message };
  }
});

// 停止录制
ipcMain.handle('stop-recording', () => {
  if (recordingProcess && isRecording) {
    recordingProcess.kill('SIGTERM');
    isRecording = false;
    updateTrayMenu();
    try {
      if (currentTempFile && fs.existsSync(currentTempFile)) {
        fs.unlinkSync(currentTempFile);
      }
    } catch (_) {}
    try { currentTempFile = null; } catch (_) {}
    return { success: true };
  }
  return { success: false, message: '没有正在进行的录制' };
});

// 复制文件到剪贴板
ipcMain.handle('copy-to-clipboard', async (event, filePath) => {
  try {
    console.log('手动复制到剪贴板:', filePath);
    if (fs.existsSync(filePath)) {
      // 对于图片文件，直接复制到剪贴板
      const ext = path.extname(filePath).toLowerCase();
      
      // 尝试把图片文件复制到剪贴板，失败回退为复制路径
      try {
        const ok = copyImageFileToClipboard(filePath);
        if (!ok) {
          try { clipboard.writeText(filePath); } catch (e) { console.error('回退写入路径失败:', e && e.message ? e.message : e); }
          console.log('手动复制文件路径成功:', filePath);
        } else {
          console.log('手动复制图片成功:', filePath);
        }
      } catch (error) {
        console.error('手动复制失败:', error && error.message ? error.message : error);
        try { clipboard.writeText(filePath); } catch (_) {}
        console.log('手动复制文件路径成功:', filePath);
      }
      return { success: true };
    }
    console.log('文件不存在:', filePath);
    return { success: false, message: '文件不存在' };
  } catch (error) {
    console.error('手动复制失败:', error);
    return { success: false, message: error.message };
  }
});

// 打开文件所在目录
ipcMain.handle('open-file-location', async (event, filePath) => {
  try {
    const directory = path.dirname(filePath);
    shell.showItemInFolder(filePath);
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// 显示区域选择窗口
ipcMain.handle('show-region-selector', () => {
  // 录制开始时最小化主窗口
  mainWindow.hide();
  createOverlayWindow();
  return { success: true };
});

// 处理区域选择结果
ipcMain.handle('region-selected', async (event, region) => {
  console.log('收到区域选择结果:', region);
  
  // 获取屏幕信息进行坐标校正
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  const scaleFactor = primaryDisplay.scaleFactor || 1;
  
  console.log('屏幕信息:', {
    scaleFactor,
    workArea: primaryDisplay.workArea,
    bounds: primaryDisplay.bounds
  });
  
  // 关闭区域选择窗口
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
  // 此处立即开始录制，不显示主窗口，避免遮挡
  
  // 直接调用录制函数
  if (isRecording) {
    return { success: false, message: '正在录制中...' };
  }

  // 坐标校正 - 考虑DPI缩放
  const correctedRegion = {
    x: Math.round(region.x * scaleFactor),
    y: Math.round(region.y * scaleFactor),
    width: Math.round(region.width * scaleFactor),
    height: Math.round(region.height * scaleFactor)
  };
  
  // 确保宽度和高度是2的倍数，以满足libx264编码器要求
  if (correctedRegion.width % 2 !== 0) {
    correctedRegion.width += 1;
  }
  if (correctedRegion.height % 2 !== 0) {
    correctedRegion.height += 1;
  }
  
  console.log('校正后的区域坐标:', correctedRegion);

  // 使用从页面获取的设置参数
  const pageData = currentPageData || {};
  const options = {
    duration: pageData.duration || 1,
    fps: pageData.fps || 15,
    width: pageData.width || 640,
    format: pageData.format || 'gif',
    region: correctedRegion
  };

  try {
    isRecording = true;
    mainWindow.webContents.send('recording-started');
    updateTrayMenu();

    const preferredDir = getSavePath();
    const saveDir = (preferredDir && fs.existsSync(preferredDir)) ? preferredDir : path.join(os.homedir(), 'Desktop');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tempFile = path.join(saveDir, `temp-capture-${timestamp}.mp4`);
    currentTempFile = tempFile;
    const outputFile = path.join(saveDir, `capture-${timestamp}.${options.format}`);

    // 构建FFmpeg录制命令参数
    let recordArgs = [];
    
    if (process.platform === 'win32') {
      // Windows: 使用 gdigrab
      recordArgs.push('-f', 'gdigrab');
      recordArgs.push('-offset_x', correctedRegion.x.toString());
      recordArgs.push('-offset_y', correctedRegion.y.toString());
      recordArgs.push('-video_size', `${correctedRegion.width}x${correctedRegion.height}`);
      recordArgs.push('-framerate', options.fps.toString());
      recordArgs.push('-i', 'desktop');
      // 添加显示偏移参数以确保坐标正确
      recordArgs.push('-show_region', '1');
    } else if (process.platform === 'darwin') {
      // macOS: 使用 avfoundation
      recordArgs.push('-f', 'avfoundation');
      recordArgs.push('-framerate', options.fps.toString());
      recordArgs.push('-video_size', `${correctedRegion.width}x${correctedRegion.height}`);
      recordArgs.push('-i', '1:0');
    } else {
      // Linux: 使用 x11grab
      recordArgs.push('-f', 'x11grab');
      recordArgs.push('-framerate', options.fps.toString());
      recordArgs.push('-video_size', `${correctedRegion.width}x${correctedRegion.height}`);
      recordArgs.push('-i', `:0.0+${correctedRegion.x},${correctedRegion.y}`);
    }

    // 添加录制参数
    recordArgs.push('-t', options.duration.toString());
    recordArgs.push('-c:v', 'libx264');
    recordArgs.push('-preset', 'ultrafast');
    recordArgs.push('-pix_fmt', 'yuv420p');
    recordArgs.push('-crf', '18');
    recordArgs.push('-y', tempFile);

    console.log('FFmpeg 区域录制命令:', ffmpegPath, recordArgs.join(' '));

    // 执行录制
    return new Promise((resolve, reject) => {
      // 第一步：录制MP4
      recordingProcess = spawn(ffmpegPath, recordArgs);
      
      let stderr = '';
      
      recordingProcess.stderr.on('data', (data) => {
        const chunk = Buffer.isBuffer(data) ? decodeBuffer(data) : String(data);
        stderr += chunk;
        console.log('FFmpeg stderr:', chunk);
        
        // 解析进度信息
        const progressMatch = stderr.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (progressMatch) {
          const hours = parseInt(progressMatch[1]);
          const minutes = parseInt(progressMatch[2]);
          const seconds = parseFloat(progressMatch[3]);
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;
          const percent = Math.min(Math.round((totalSeconds / options.duration) * 50), 50); // 录制占50%
          console.log(`录制进度: ${percent}% (${totalSeconds.toFixed(1)}s / ${options.duration}s)`);
          mainWindow.webContents.send('recording-progress', percent);
        }
      });

      recordingProcess.on('close', (code) => {
        if (code === 0) {
          console.log('录制完成，开始转换...');
          mainWindow.webContents.send('recording-progress', 50);
          
          // 第二步：根据格式转换
          if (options.format === 'mp4') {
            // 直接重命名MP4文件
            fs.renameSync(tempFile, outputFile);
            isRecording = false;
            updateTrayMenu();
            try { currentTempFile = null; } catch (_) {}
            try { mainWindow.show(); mainWindow.focus(); } catch (_) {}
            mainWindow.webContents.send('recording-completed', { filePath: outputFile });
            // 对于非GIF格式，不需要复制到剪贴板，而是直接打开保存地址
            try { shell.showItemInFolder(outputFile); } catch (e) { console.error('打开文件位置失败:', e && e.message ? e.message : e); }
            resolve({ success: true, filePath: outputFile });
          } else if (options.format === 'webm') {
            // 转换为WebM
            convertToFormat(tempFile, outputFile, options.format, options.width, options.fps, options.duration)
              .then(() => {
                // 删除临时文件
                if (fs.existsSync(tempFile)) {
                  try { fs.unlinkSync(tempFile); } catch (_) {}
                }
                isRecording = false;
                updateTrayMenu();
                try { currentTempFile = null; } catch (_) {}
                // 录制结束后显示窗口
                mainWindow.show();
                mainWindow.focus();
                mainWindow.webContents.send('recording-completed', { filePath: outputFile });
                // 对于非GIF格式，不需要复制到剪贴板，而是直接打开保存地址
                try { shell.showItemInFolder(outputFile); } catch (e) { console.error('打开文件位置失败:', e && e.message ? e.message : e); }
                resolve({ success: true, filePath: outputFile });
              })
              .catch((err) => {
                isRecording = false;
                updateTrayMenu();
                try {
                  if (currentTempFile && fs.existsSync(currentTempFile)) {
                    fs.unlinkSync(currentTempFile);
                  }
                } catch (_) {}
                try { currentTempFile = null; } catch (_) {}
                mainWindow.webContents.send('recording-error', err.message);
                reject({ success: false, message: err.message });
              });
          } else {
            // 转换为GIF
            convertToFormat(tempFile, outputFile, options.format, options.width, options.fps, options.duration)
              .then(() => {
                // 删除临时文件
                if (fs.existsSync(tempFile)) {
                  try { fs.unlinkSync(tempFile); } catch (_) {}
                }
                isRecording = false;
                updateTrayMenu();
                try { currentTempFile = null; } catch (_) {}
                // 录制结束后显示窗口
                mainWindow.show();
                mainWindow.focus();
                mainWindow.webContents.send('recording-completed', { filePath: outputFile });
                // 自动复制到剪贴板（保护性 try/catch）
                try { autoCopyToClipboard(outputFile); } catch (e) { console.error('自动复制到剪贴板失败:', e && e.message ? e.message : e); }
                resolve({ success: true, filePath: outputFile });
              })
              .catch((err) => {
                isRecording = false;
                updateTrayMenu();
                try {
                  if (currentTempFile && fs.existsSync(currentTempFile)) {
                    fs.unlinkSync(currentTempFile);
                  }
                } catch (_) {}
                try { currentTempFile = null; } catch (_) {}
                mainWindow.webContents.send('recording-error', err.message);
                reject({ success: false, message: err.message });
              });
          }
        } else {
          isRecording = false;
          mainWindow.webContents.send('recording-error', `录制失败，FFmpeg 退出码: ${code}`);
          reject({ success: false, message: `录制失败，FFmpeg 退出码: ${code}` });
        }
      });

      recordingProcess.on('error', (err) => {
        isRecording = false;
        mainWindow.webContents.send('recording-error', err.message);
        reject({ success: false, message: err.message });
      });
    });

  } catch (error) {
    isRecording = false;
    updateTrayMenu();
    mainWindow.webContents.send('recording-error', error.message);
    return { success: false, message: error.message };
  }
});

// 关闭区域选择窗口
ipcMain.handle('close-region-selector', () => {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
  // 仅在未录制时显示主窗口，避免遮挡录屏
  try {
    if (mainWindow && !isRecording) {
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (_) {}
  return { success: true };
});

// 添加获取页面数据的处理程序
let currentPageData = {};
ipcMain.handle('set-page-data', (event, data) => {
  currentPageData = data;
  return { success: true };
});

// 获取屏幕信息
ipcMain.handle('get-screen-info', () => {
  const displays = screen.getAllDisplays();
  return {
    primary: screen.getPrimaryDisplay(),
    all: displays
  };
});

// 获取FFmpeg状态
ipcMain.handle('get-ffmpeg-status', () => {
  const isAvailable = checkFFmpegAvailability();
  return {
    available: isAvailable,
    path: ffmpegPath,
    message: isAvailable ? 'FFmpeg可用' : `FFmpeg不可用，路径: ${ffmpegPath}`,
    debug: {
      platform: process.platform,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      dirname: __dirname
    }
  };
});

// 打开FFmpeg下载页面
ipcMain.handle('open-ffmpeg-download', () => {
  try {
    shell.openExternal('https://ffmpeg.org/download.html');
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// 调试FFmpeg路径的IPC处理器
ipcMain.handle('debug-ffmpeg-paths', () => {
  const debugInfo = {
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    dirname: __dirname,
    currentPath: ffmpegPath,
    paths: []
  };
  
  // 检查所有可能的路径
  const possiblePaths = [
    path.join(process.resourcesPath, 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    path.join(__dirname, '..', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    path.join(__dirname, 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    path.join(process.resourcesPath, 'app', 'node_modules', '@ffmpeg-installer', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    path.join(__dirname, 'node_modules', '@ffmpeg-installer', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  ];
  
  possiblePaths.forEach((testPath, index) => {
    debugInfo.paths.push({
      index: index + 1,
      path: testPath,
      exists: fs.existsSync(testPath)
    });
  });
  
  return debugInfo;
});
