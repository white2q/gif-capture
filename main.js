const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

let mainWindow;
let overlayWindow;
let isRecording = false;
let recordingProcess = null;

// 自动复制到剪贴板的辅助函数
function autoCopyToClipboard(filePath) {
  // 添加延迟确保文件完全写入
  setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        
        if (ext === '.gif') {
          // 对于GIF文件，尝试复制为图片
          try {
            const image = fs.readFileSync(filePath);
            clipboard.writeImage(image);
            console.log('已复制GIF图片到剪贴板:', filePath);
          } catch (error) {
            // 如果writeImage失败，尝试复制文件路径
            console.log('GIF图片复制失败，复制文件路径:', error.message);
            clipboard.writeText(filePath);
            console.log('已复制GIF文件路径到剪贴板:', filePath);
          }
        } else {
          // 对于其他图片文件，直接复制图片数据
          const image = fs.readFileSync(filePath);
          clipboard.writeImage(image);
          console.log('已复制图片到剪贴板:', filePath);
        }
        return true;
      } else {
        console.log('文件不存在，无法复制:', filePath);
      }
    } catch (error) {
      console.error('复制到剪贴板失败:', error);
    }
    return false;
  }, 1000); // 延迟1秒
}

// 转换格式函数
function convertToFormat(inputFile, outputFile, format, width, fps, duration) {
  return new Promise((resolve, reject) => {
    let convertArgs = ['-i', inputFile];
    
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
            stderr += data.toString();
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
      convertArgs.push(
        '-c:v', 'libvpx-vp9',
        '-crf', '30',
        '-b:v', '0',
        '-vf', `scale=${width}:-1`,
        '-y', outputFile
      );
      
      console.log('转换WebM命令:', ffmpegPath, convertArgs.join(' '));
      
      const convertProcess = spawn(ffmpegPath, convertArgs);
      let stderr = '';
      
      convertProcess.stderr.on('data', (data) => {
        stderr += data.toString();
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
    width: 400,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    resizable: false,
    title: 'GIF Capture Tool',
    icon: path.join(__dirname, 'assets/icon.png')
  });

  mainWindow.loadFile('index.html');

  // 开发模式下打开开发者工具
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
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
}

// 应用准备就绪
app.whenReady().then(() => {
  createMainWindow();

  // 注册全局快捷键 Ctrl+Shift+G
  globalShortcut.register('CommandOrControl+Shift+G', () => {
    if (mainWindow) {
      mainWindow.webContents.send('start-recording');
    }
  });

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
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 应用即将退出时注销快捷键
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// IPC 事件处理
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

  const {
    duration = 1,
    fps = 15,
    width = 640,
    format = 'gif',
    region = null // {x, y, width, height}
  } = options;

  try {
    isRecording = true;
    mainWindow.webContents.send('recording-started');

    const desktopPath = path.join(os.homedir(), 'Desktop');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tempFile = path.join(desktopPath, `temp-capture-${timestamp}.mp4`);
    const outputFile = path.join(desktopPath, `capture-${timestamp}.${format}`);

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
    recordArgs.push('-t', duration.toString());
    recordArgs.push('-c:v', 'libx264');
    recordArgs.push('-preset', 'ultrafast');
    recordArgs.push('-crf', '18');
    recordArgs.push('-y', tempFile);

    console.log('FFmpeg 录制命令:', ffmpegPath, recordArgs.join(' '));

    // 执行录制
    return new Promise((resolve, reject) => {
      // 第一步：录制MP4
      recordingProcess = spawn(ffmpegPath, recordArgs);
      
      let stderr = '';
      
      recordingProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        console.log('FFmpeg stderr:', data.toString());
        
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
          if (format === 'mp4') {
            // 直接重命名MP4文件
            fs.renameSync(tempFile, outputFile);
            isRecording = false;
            mainWindow.webContents.send('recording-completed', { filePath: outputFile });
            // 自动复制到剪贴板
            autoCopyToClipboard(outputFile);
            resolve({ success: true, filePath: outputFile });
          } else {
            // 转换为GIF或WebM
            convertToFormat(tempFile, outputFile, format, width, fps, duration)
              .then(() => {
                // 删除临时文件
                if (fs.existsSync(tempFile)) {
                  fs.unlinkSync(tempFile);
                }
                isRecording = false;
                mainWindow.webContents.send('recording-completed', { filePath: outputFile });
                // 自动复制到剪贴板
                autoCopyToClipboard(outputFile);
                resolve({ success: true, filePath: outputFile });
              })
              .catch((err) => {
                isRecording = false;
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
    mainWindow.webContents.send('recording-error', error.message);
    return { success: false, message: error.message };
  }
});

// 停止录制
ipcMain.handle('stop-recording', () => {
  if (recordingProcess && isRecording) {
    recordingProcess.kill('SIGTERM');
    isRecording = false;
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
      
      if (ext === '.gif') {
        // 对于GIF文件，尝试复制为图片
        try {
          const image = fs.readFileSync(filePath);
          clipboard.writeImage(image);
          console.log('手动复制GIF图片成功:', filePath);
        } catch (error) {
          // 如果writeImage失败，尝试复制文件路径
          console.log('GIF图片复制失败，复制文件路径:', error.message);
          clipboard.writeText(filePath);
          console.log('手动复制GIF文件路径成功:', filePath);
        }
      } else {
        // 对于其他图片文件，直接复制图片数据
        const image = fs.readFileSync(filePath);
        clipboard.writeImage(image);
        console.log('手动复制图片成功:', filePath);
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
  
  console.log('校正后的区域坐标:', correctedRegion);

  const options = {
    duration: 1,
    fps: 15,
    width: 640,
    format: 'gif',
    region: correctedRegion
  };

  try {
    isRecording = true;
    mainWindow.webContents.send('recording-started');

    const desktopPath = path.join(os.homedir(), 'Desktop');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tempFile = path.join(desktopPath, `temp-capture-${timestamp}.mp4`);
    const outputFile = path.join(desktopPath, `capture-${timestamp}.${options.format}`);

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
    recordArgs.push('-crf', '18');
    recordArgs.push('-y', tempFile);

    console.log('FFmpeg 区域录制命令:', ffmpegPath, recordArgs.join(' '));

    // 执行录制
    return new Promise((resolve, reject) => {
      // 第一步：录制MP4
      recordingProcess = spawn(ffmpegPath, recordArgs);
      
      let stderr = '';
      
      recordingProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        console.log('FFmpeg stderr:', data.toString());
        
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
            mainWindow.webContents.send('recording-completed', { filePath: outputFile });
            // 自动复制到剪贴板
            autoCopyToClipboard(outputFile);
            resolve({ success: true, filePath: outputFile });
          } else {
            // 转换为GIF或WebM
            convertToFormat(tempFile, outputFile, options.format, options.width, options.fps, options.duration)
              .then(() => {
                // 删除临时文件
                if (fs.existsSync(tempFile)) {
                  fs.unlinkSync(tempFile);
                }
                isRecording = false;
                mainWindow.webContents.send('recording-completed', { filePath: outputFile });
                // 自动复制到剪贴板
                autoCopyToClipboard(outputFile);
                resolve({ success: true, filePath: outputFile });
              })
              .catch((err) => {
                isRecording = false;
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
