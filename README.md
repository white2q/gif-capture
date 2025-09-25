# 🎬 GIF Capture Tool

一款跨平台的桌面GIF录制工具，能够快速录制屏幕区域并导出为GIF、MP4或WebM格式。

## ✨ 功能特性

- 🖥️ **跨平台支持** - Windows、macOS、Linux
- 📐 **区域选择** - 支持框选特定屏幕区域录制
- ⚡ **快速录制** - 1-N秒快速录制，文件小巧
- 🎨 **多格式导出** - 支持GIF、MP4、WebM格式
- ⌨️ **快捷键支持** - 默认 Ctrl+Shift+G 全屏、Ctrl+Shift+R 区域（可自定义）
- 📋 **剪贴板集成** - 录制完成后可直接复制到剪贴板
- 🎛️ **参数调节** - 可调节帧率、分辨率、录制时长、输出宽度
- 📂 **自定义保存路径** - 可选择输出目录并持久化
 - 🪟 **可调整窗口大小** - 窗口可缩放，布局自适应

## 🚀 快速开始

### 环境要求

- Node.js 16+ 
- FFmpeg (自动安装)

### 安装运行

1. **克隆项目**
   ```bash
   git clone <repository-url>
   cd gif-capture
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **启动应用**
   ```bash
   npm start
   ```

4. **打包发布** (可选)
   ```bash
   npm run build
   ```

## 📖 使用说明

### 基本操作

1. **全屏录制**
   - 点击 "📺 录制全屏" 按钮
   - 或使用快捷键 `Ctrl+Shift+G`
   - 应用将录制整个屏幕设置秒数

2. **区域录制**
   - 点击 "📐 选择区域" 按钮
   - 在弹出的半透明窗口中拖拽选择区域
   - 按 `Enter` 确认或 `Esc` 取消

3. **参数设置**
   - **录制时长**: 1-N秒可选
   - **帧率**: 10-60 FPS可选
   - **输出宽度**: 320-1920px可选
   - **输出格式**: GIF/MP4/WebM可选

### 快捷键

- `Ctrl+Shift+G` - 默认：开始/停止全屏录制（可在界面自定义）
- `Ctrl+Shift+R` - 默认：打开区域选择（可在界面自定义）
- `Esc` - 停止录制/取消区域选择
- `Enter` - 确认区域选择

在主界面底部可直接查看和编辑快捷键，支持即时保存与恢复默认。更改后会自动生效并全局注册。

### 录制完成后

- 📁 **打开位置** - 在文件管理器中打开文件
- 📋 **复制到剪贴板** - 将文件复制到系统剪贴板
 - 📂 **自定义保存目录** - 在主界面选择保存目录，后续录制将保存至该目录（若未设置或目录无效，回退到桌面）

## 🔧 技术实现

### 核心技术栈

- **Electron** - 跨平台桌面应用框架
- **@ffmpeg-installer/ffmpeg** - FFmpeg二进制文件管理
- **原生child_process** - 直接调用FFmpeg，避免过时依赖

### 平台适配

| 平台 | 录制方式 | 说明 |
|------|----------|------|
| Windows | gdigrab | 使用Windows GDI抓取 |
| macOS | avfoundation | 使用AVFoundation框架 |
| Linux | x11grab | 使用X11抓取 |

### FFmpeg参数说明

**Windows (gdigrab)**
```bash
ffmpeg -f gdigrab -offset_x X -offset_y Y -video_size WxH -framerate FPS -i desktop -t DURATION output.gif
```

**macOS (avfoundation)**
```bash
ffmpeg -f avfoundation -framerate FPS -video_size WxH -i 1:0 -t DURATION output.gif
```

**Linux (x11grab)**
```bash
ffmpeg -f x11grab -video_size WxH -framerate FPS -i :0.0+X,Y -t DURATION output.gif
```

## 📁 项目结构

```
gif-capture/
├── main.js          # Electron主进程
├── index.html       # 主界面
├── overlay.html     # 区域选择覆盖窗口
├── package.json     # 项目配置
├── assets/          # 资源文件
└── README.md        # 项目说明
```

## 🛠️ 开发说明

### 开发模式

```bash
npm run dev
```

### 构建发布

```bash
npm run build
```

### 依赖说明

- `electron` - 桌面应用框架
- `@ffmpeg-installer/ffmpeg` - FFmpeg二进制文件
- `electron-builder` - 应用打包工具

## ⚠️ 注意事项

1. **权限要求**
   - macOS: 需要屏幕录制权限
   - Linux: 需要X11访问权限

2. **性能优化**
   - 录制时长建议不超过10秒
   - 高帧率会增加文件大小
   - GIF格式文件较大，建议使用MP4格式

3. **兼容性**
   - Windows 10+
   - macOS 10.14+
   - Linux (Ubuntu 18.04+)

## 日志与终端编码（Windows）

在 Windows 控制台（尤其是 cmd.exe / PowerShell）中，默认代码页可能不是 UTF-8，导致控制台输出中文出现乱码。运行应用或调试时，如遇到日志乱码，可在启动前在 PowerShell 中执行：

```powershell
chcp 65001
```

或者在支持 UTF-8 的终端（例如 Windows Terminal）中运行应用。我们在 `main.js` 中已加入对 FFmpeg 输出用 `iconv-lite` 的自动解码，以降低乱码概率，但仍建议将终端设置为 UTF-8 以获得最佳效果。

## 🤝 贡献

欢迎提交Issue和Pull Request来改进这个项目！

## 📄 许可证

MIT License
