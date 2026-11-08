# 1➕衣 · 实时虚拟试衣

用浏览器摄像头实时试穿参考图中的服装。选择示例样衣或上传自己的服装图，试穿后可回看原视频和试穿成片，并生成分享链接。项目使用 TypeScript、Vite、Express、SQLite 和 FFmpeg。试穿效果由 Decart 通过 WebRTC 生成，本地无需下载推理模型或安装 GPU 环境。

- **体验端**支持单件试穿、五件样衣自动轮换、个人衣橱、双视频回放和分享。
- **管理端**可管理服装、视频、试衣次数、并发、Decart 密钥和推广代理。GLB 用于查看三维服装素材，云端试衣使用服装参考图。
- **无需密钥即可开始**体验相机预览、浏览样衣、上传和管理服装。实时换衣需要配置 Decart，按平台账户计费。

## 1. 在电脑上启动

安装 [Git](https://git-scm.com/downloads)、[Node.js 24 LTS](https://nodejs.org/) 和 [FFmpeg](https://ffmpeg.org/download.html)。将 `ffmpeg` 和 `ffprobe` 加入 `PATH`，视频转码需要 FFmpeg 的 `libx264` 编码器。运行 `node -v`、`ffmpeg -version` 和 `ffprobe -version` 检查安装。

```sh
git clone https://github.com/zhimingbd55-cpu/3dsy.git
cd 3dsy
npm ci
npm run demo:seed
npm run dev
```

用浏览器打开 **`http://127.0.0.1:8766`** 并允许相机权限。`demo:seed` 将五件示例服装导入本机数据库，一次即可。想用自己的服装，可以在首页点击「添加服装」。Windows 如果阻止 `npm.ps1` 执行，把命令中的 `npm` 换成 `npm.cmd`。

正式运行使用 `npm run build` 后执行 `npm start`。这两个启动方式都监听 `127.0.0.1`，默认 URL 请使用 `127.0.0.1`。手机使用 HTTPS 地址，配置见[部署指南](docs/部署指南.md)。

## 2. 开通后台和真实试衣

1. 在仓库根目录复制 `.env.example` 为 `.env`。PowerShell 用 `Copy-Item .env.example .env`，macOS / Linux 用 `cp .env.example .env`。
2. 在终端运行 `npm run admin:hash`，输入至少 12 字符的管理员密码。将输出的整行 `ADMIN_PASSWORD_HASH='…'` 替换到 `.env`，保留单引号。用户名由 `ADMIN_USER` 指定，示例值为 `admin`。
3. 重启服务，打开 **`http://127.0.0.1:8766/admin`**，使用刚才输入的原密码登录。在「API 密钥」中添加自己账户的 Decart API Key，再点「设为当前」。当前代码使用 `lucy-vton-3.6`，所用账户需具备该实时模型的访问权限与可用额度。[Decart 控制台](https://platform.decart.ai/)
4. 回到首页试穿。需要控制调用量时，在后台「次数与并发」设置每日次数和并发，也可以暂停接入。

也可以在第一次初始化时用 `.env` 的 `DECART_API_KEY` 导入密钥，此后可在后台管理。密钥仅配置在服务端。`npm run check:api` 可单独检查短期令牌能否签发，它会请求 Decart，验证范围是身份和令牌签发。

## 3. 试衣、保存和分享

1. **打开相机。** 推荐使用新版 Chrome、Edge 或 Safari。自动开启失败时，点「开启相机」。站在明亮处，让所选服装对应的身体区域完整入镜。
2. **挑选服装。** 点击样衣进入单件模式。自己的参考图支持 JPG、PNG 或 WebP，单文件最多 20 MB，优先选正面、轮廓清晰、没有人物遮挡的图片。上传后按提示选择上装、下装、整套或配饰。五件样衣都导入后，可以使用自动轮换模式，过程中点一件可固定试穿。
3. **开始试衣。** 点击「开始试衣」，按约 5 秒的倒计时站位。画面稳定后开始录制，单件模式最多录制 30 秒，也可主动点「结束」。仅打开相机预览时不会调用 Decart 或录制。
4. **查看结果。** 在「我的视频」查看上传和转码进度。建议保持页面开启直到保存完成。断网或切到后台后，可用原浏览器返回继续上传。成片就绪后可回看、分享，也可用首页「分享试衣」生成入口海报。

试衣会将摄像头画面发往 Decart。原视频和成片无音频，由当前站点保存，默认从拍摄日起保留 30 天。任何拿到视频分享链接的人都可以查看，管理员可以撤销链接。匿名衣橱依赖当前浏览器的 Cookie，更换浏览器或清除站点数据会失去原来的访问身份。站内 `/privacy` 提供保存与分享说明。

## 4. 排查常见问题

| 现象 | 检查方式 |
| --- | --- |
| 页面提示访问来源不受支持 | 使用完整的 `http://127.0.0.1:8766`。通过域名访问时，`PUBLIC_ORIGIN` 必须与浏览器地址的协议、域名和端口一致，末尾不加 `/`。 |
| 手机无法打开相机 | 使用可信证书的 HTTPS 地址，确认浏览器已授权相机。手机上的 `127.0.0.1` 指向手机自身。 |
| 有预览但不能开始试衣 | 检查是否选中服装，后台是否已设置当前密钥，账户是否有额度，以及本站是否暂停或达到限额。 |
| 视频处理失败或提示存储不足 | 检查 `ffmpeg`、`ffprobe`、`libx264`，以及数据目录可写、磁盘剩余空间是否满足 `MIN_FREE_BYTES`。默认至少保留 10 GiB。 |
| 看不到示例服装 | 停止服务，确认导入命令与服务使用同一份 `.env` 和数据目录，再执行 `npm run demo:seed`。 |

健康检查可访问 `http://127.0.0.1:8766/api/health`。生产配置、反向代理和数据备份见[部署指南](docs/部署指南.md)。

## 开发与测试

| 目录 | 内容 |
| --- | --- |
| `src/` | 相机、衣橱、录制与上传、分享页和管理后台 |
| `server/` | HTTP API、SQLite、会话队列、Decart 信令代理和媒体处理 |
| `assets/garments/` | 五件二维示例服装及 SHA-256 清单 |
| `public/brand/` | 界面品牌素材、分享封面和字体许可 |
| `tests/` | API、队列、权限、媒体和试衣流程回归测试 |

```sh
npm run build
npm test
```

测试使用临时数据库、生成的测试媒体和模拟云端响应。媒体测试需要带 `lavfi` 输入和 `libx264`、`libvpx`、`aac` 编码器的完整 FFmpeg。两项绑定原始 GLB 样衣的测试在公开克隆中自动跳过，GLB 文件校验仍有合成夹具覆盖。真实试衣画质、手机兼容性和网络连通性需要用自己的 Decart 账户及设备验收。后台中的「平行的我」是可选的独立服务入口，单独运行本仓不需要配置它。

## 许可与素材

本仓项目代码与文档采用 [MIT 许可证](LICENSE)。五件示例服装是项目生成的参考素材，来源与校验值见[样衣清单](assets/garments/manifest.json)。Noto Sans SC 字体子集沿用 [SIL Open Font License 1.1](public/brand/OFL-NotoSansSC.txt)。npm 依赖各自沿用其上游许可。Decart 模型由第三方提供，使用时遵循其 [API 服务条款](https://docs.platform.decart.ai/resources/api-terms)。
