// 命令行的显示格式：账本（主进程）与界面预览（渲染层）共用 Electron 侧那一份实现，
// 这样「预览里写的命令」与「账本里记录的命令」永远逐字一致。
export { displayGitCommand } from "../electron/command-display.mjs";
