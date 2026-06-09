# Head Control Chrome Extension

这是一个基于 MediaPipe Face Landmarker 的 Chrome 扩展原型。当前版本使用“头部方向控制”为主：

- 头向左/右/上/下移动网页上的指示器。
- 指示器靠近页面边缘时触发方向滚动。
- 长眨眼或双眨眼触发点击。
- 控制窗口可以缩小放在右下角，摄像头追踪在隐藏 offscreen 页面里继续运行。

> 注意：这是 Chrome 扩展版本，只能控制浏览器网页里的 DOM 点击和滚动。它不能真正移动 Windows 系统鼠标。真正系统鼠标控制需要桌面版程序配合系统 API。

## 目录结构

```text
chrome-extension/
  manifest.json                     Chrome 扩展清单，声明权限、后台脚本和内容脚本
  popup.html / popup.css / popup.js 工具栏弹窗，只负责打开控制窗口
  app.html / app.css / app.js       控制窗口，负责启动、标定、参数调节和状态展示
  service-worker.js                 Manifest V3 后台调度中心
  offscreen.html / offscreen.js     隐藏摄像头和 MediaPipe 追踪页面
  content-script.js                 注入目标网页，绘制指示器并执行点击/滚动
  shared/gaze-engine.js             人脸模型、头部方向、标定、眨眼识别核心逻辑
  assets/face_landmarker.task       MediaPipe Face Landmarker 模型文件
  vendor/mediapipe/                 本地 MediaPipe runtime 和 wasm 文件
```

## 核心运行流程

1. 用户点击浏览器工具栏里的 Eye Control 图标。
2. `popup.js` 记录当前活动网页为控制目标，并打开右下角控制窗口 `app.html`。
3. 用户在控制窗口点击“启动”。
4. `app.js` 先在可见窗口里调用 `getUserMedia` 请求摄像头权限。
5. 用户点击 Chrome 权限弹窗里的“允许”后，`app.js` 释放临时摄像头流。
6. `app.js` 发送 `control-start` 给 `service-worker.js`。
7. `service-worker.js` 创建 `offscreen.html`，并发送 `tracker-start`。
8. `offscreen.js` 使用 `GazeEngine` 打开摄像头、加载模型、开始追踪。
9. `GazeEngine` 每帧输出标准化坐标、眨眼事件和状态。
10. `service-worker.js` 把坐标转换成 hover/click/scroll 消息，发给目标网页的 `content-script.js`。
11. `content-script.js` 在网页上显示指示器，并执行点击或滚动。

## 为什么使用 offscreen 页面

Manifest V3 的 service worker 不能长期持有摄像头，也不能稳定运行视频推理。Chrome 推荐把这类长期媒体任务放到 offscreen document。

本项目中：

- `service-worker.js` 只做消息调度。
- `offscreen.html` 持有隐藏的 `<video>`。
- `offscreen.js` 运行 MediaPipe 推理。

控制窗口里不显示摄像头预览是正常现象。控制窗口只显示状态、标定点和本地指示点。

## 安装方式

### 本机开发加载

1. 打开 Chrome。
2. 进入 `chrome://extensions`。
3. 打开右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择整个 `chrome-extension` 文件夹。
6. 点击扩展图标，打开控制窗口。
7. 点击“启动”，在摄像头权限弹窗中选择“允许”。

不要直接双击打开 `app.html`。必须作为 Chrome 扩展加载，否则 Chrome API 和摄像头权限逻辑都不会正常工作。

### 迁移到另一台电脑

必须复制整个 `chrome-extension` 文件夹，或者使用项目根目录生成的压缩包。

不能只复制下面这些单个文件：

- `app.html`
- `chrome-extension.crx`
- `face_landmarker.task`

原因是扩展运行依赖多个文件：

- `assets/face_landmarker.task`
- `vendor/mediapipe/vision_bundle.mjs`
- `vendor/mediapipe/wasm/*`
- `service-worker.js`
- `offscreen.js`
- `content-script.js`

推荐迁移步骤：

1. 复制 `Eye-Control-Chrome-Extension-current.zip` 到新电脑。
2. 解压。
3. 在 Chrome 的 `chrome://extensions` 中加载解压后的 `chrome-extension` 文件夹。
4. 首次启动时允许摄像头权限。

## 权限说明

`manifest.json` 里声明了以下权限：

- `activeTab`：读取当前活动标签页，作为默认控制目标。
- `scripting`：在目标网页中补注入 `content-script.js`。
- `storage`：保存目标标签页、开关状态和基础配置。
- `tabs`：监听页面切换和 URL 更新，让控制目标自动跟随新页面。
- `videoCapture`：允许扩展使用摄像头。
- `offscreen`：创建隐藏页面运行摄像头和模型。
- `host_permissions: ["<all_urls>"]`：允许内容脚本注入普通网页。

`manifest.json` 是标准 JSON，不能写注释。如果要解释字段，请写在 README，不要直接改成带 `//` 的 JSON。

## 控制参数

控制窗口中有以下参数：

- 指示点：是否在网页上显示眼控/头控指示器。
- 眨眼点击：是否允许眨眼触发点击。
- 方向滑动：指示点靠近页面边缘时是否滚动。
- 驻留点击：指示点停留一段时间后是否自动点击。
- 头部灵敏度：头部动作映射到屏幕坐标的放大倍数。
- 眨眼点击方式：长眨眼或双眨眼。
- 平滑：坐标低通平滑程度，越大越跟手但可能更抖。
- 移动速度：指示点向目标位置移动的速度。
- 驻留点击(ms)：驻留点击触发所需时间。
- 滑动速度：方向滚动的距离。

## 标定说明

点击“标定”后，系统会依次采集五个方向：

1. center
2. left
3. right
4. up
5. down

每个方向会采集若干帧 landmark，并取中位数作为该方向代表值。标定完成后，头部方向到屏幕坐标的映射会使用用户自己的活动范围。

如果没有标定，系统使用默认 fallback gain，也可以运行，但个人差异会更明显。

## 眨眼防误触

自然眨眼很容易误触，所以当前版本有两种方式：

- 长眨眼：闭眼时间超过 `longBlinkMs` 才点击。
- 双眨眼：两次自然短眨眼在 `doubleBlinkWindowMs` 内发生才点击。

相关逻辑在 `shared/gaze-engine.js` 的 `processBlink` 中。

## 常见错误

### NotAllowedError Permission dismissed

意思是摄像头权限弹窗被关闭，或者没有点击“允许”。

解决方法：

1. 重新点击“启动”。
2. 看到权限弹窗时点击“允许”。
3. 如果 Chrome 已经记住拒绝，打开 `chrome://settings/content/camera` 重置权限。
4. 检查 Windows 设置是否允许 Chrome 使用摄像头。

### NotReadableError

通常是摄像头被其它软件占用。

解决方法：

- 关闭微信视频、腾讯会议、OBS、其它浏览器摄像头页面。
- 重新插拔外接摄像头。
- 重启 Chrome。

### NotFoundError

Chrome 没找到可用摄像头。

解决方法：

- 检查电脑是否有摄像头。
- 检查设备管理器中摄像头是否启用。
- 在 Chrome 设置里选择正确摄像头。

### 启动后黑色区域没有视频

这是正常的。当前版本把摄像头画面放在隐藏 offscreen 页面中处理，控制窗口不会显示视频预览。

判断是否运行请看：

- 状态是否变成“后台追踪中”。
- “人脸”是否变成“已检测”。
- “水平/垂直”数值是否随头部动作变化。

### 指示点不动或只在切换页面时动

确认使用的是当前版本。当前版本已经把预测循环改成 `setTimeout`，避免隐藏页中的 `requestAnimationFrame` 被 Chrome 降频。

如果仍然不动：

- 重新加载扩展。
- 确认目标页面是普通 `http`、`https` 或 `file` 页面。
- Chrome 系统页、扩展商店、部分受保护页面不能被控制。

## 打包方式

开发阶段推荐加载解压目录。需要分发给队友时，可以压缩整个目录：

```powershell
Compress-Archive -Path chrome-extension -DestinationPath Eye-Control-Chrome-Extension-current.zip -Force
```

队友解压后，在 `chrome://extensions` 里选择解压出的 `chrome-extension` 文件夹。

如果要打包成 `.crx`，需要在 Chrome 扩展页使用“打包扩展程序”，并保留生成的 `.pem` 私钥。注意 `.crx` 可能是旧版本，修改源码后必须重新打包。

## 开发检查

修改 JS 后可以在项目根目录运行：

```powershell
node --check chrome-extension\app.js
node --check chrome-extension\popup.js
node --check chrome-extension\service-worker.js
node --check chrome-extension\offscreen.js
node --check chrome-extension\content-script.js
node --check chrome-extension\shared\gaze-engine.js
```

修改 `manifest.json` 后可以用 Node 验证 JSON：

```powershell
node -e "JSON.parse(require('fs').readFileSync('chrome-extension/manifest.json','utf8')); console.log('manifest ok')"
```

## 后续可改进方向

- 加入摄像头设备选择。
- 在控制窗口显示低分辨率预览，帮助用户确认取景。
- 保存每个用户的标定 profile。
- 增加暂停/继续按钮。
- 做桌面版，使用系统 API 真正控制 Windows 鼠标。
