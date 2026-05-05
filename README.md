用户交互技术（期末大作业）
整合眼动、手势与语音的网页插件原型

简介
- 目标：将眼动（eye-tracking）、手势（gesture）和语音（voice）三模态整合为一个可在网页中使用的插件，长期目标是扩展为手机应用。
- 当前状态：已有手势操作的初版网页。

文件结构（初始）
- src/                开发用网页和脚本
  - index.html        示例网页（打开即可测试或集成已有手势代码）
  - js/
    - gesture.js      现有手势代码（请将现有实现替换到此文件）
    - eye.js          眼动模块占位（后续填充）
    - voice.js        语音模块占位（后续填充）
- extension/          浏览器插件相关（manifest.json 占位）
- mobile/             手机端说明与原型建议
- docs/               架构和开发计划

开发说明
1. 本地快速预览：打开 src/index.html
2. 将现有手势代码合并到 src/js/gesture.js
3. 按模块实现 eye.js（WebGazer / WebGazer.js 等）与 voice.js（Web Speech API）

后续计划
- 集成三模态的交互融合策略
- 编写插件安装说明
- 开发 React Native / Flutter 手机原型

