// 「这条命令会怎么显示」的唯一实现：命令账本与界面预览都从这里取。
// 账本记录的是真实 argv（安全边界），显示层只是把这些参数按 shell 近似规则拼回一行；
// 含空格或引号的参数加双引号，避免 `git add -- guide for project.md` 这种看起来会
// 命中两个文件的假命令。两个进程共用一个文件，就不会再出现「预览与账本不一致」。
//
// 注意：这里只负责显示。执行永远走 argv，绝不用拼接出的字符串去 spawn。

/**
 * 单个参数在命令行里的写法：含空白或引号时用 JSON 字符串（双引号 + 转义）。
 * @param {unknown} value
 * @returns {string}
 */
function quoteForDisplay(value) {
  const text = String(value)
  return /[\s"']/.test(text) ? JSON.stringify(text) : text
}

/**
 * 把 `git <argv…>` 拼成账本与预览共用的单行命令。
 * @param {string[]} argv 不含 `git` 本身的参数列表
 * @returns {string}
 */
export function displayGitCommand(argv = []) {
  return ['git', ...(Array.isArray(argv) ? argv : [])].map(quoteForDisplay).join(' ')
}
