# Startup Tray Manager

一个专注 Windows 10/11 的启动项托盘管理器。

## 功能

- 开机静默启动并常驻系统托盘
- 扫描 `HKCU/HKLM Run` 与用户 / 公共 `Startup` 文件夹
- 默认按名称升序排序
- 支持模糊搜索程序名、命令行和目标路径
- 支持启用 / 禁用启动项
- 系统级启动项修改时自动走管理员提权

## 项目结构

- `src/main`：Electron 主进程、托盘、窗口、启动项扫描与切换
- `src/preload`：安全 IPC 暴露层
- `src/renderer`：Vue 界面
- `src/shared`：共享类型
- `build`：图标源资源

## 开发

```bash
npm install
npm run dev
```

## 打包 Windows 安装版

```bash
npm run dist
```

打包产物会输出到 `release/`，建议上传源码到 GitHub，把 `release/*.exe` 作为 GitHub Release 附件分发。
