// 样式语义断言的共用读取器。
// 断言"必须出现某个 CSS 片段"很容易被无关的排版改动打破，所以测试改成按
// 选择器读取声明再断言语义（字号、颜色、尺寸、类名集合），不依赖规则的书写顺序。
const fs = require('node:fs')
const path = require('node:path')

const stylesPath = path.join(__dirname, '..', '..', 'src', 'styles.css')

function readStyles() {
  return fs.readFileSync(stylesPath, 'utf8')
}

// 扫出所有声明块（含 @media/@container 里的一层规则），保留选择器原文。
function scanBlocks(styles) {
  const blocks = []
  let depth = 0
  let selectorStart = 0
  for (let index = 0; index < styles.length; index += 1) {
    const character = styles[index]
    if (character === '{') {
      const selector = styles
        .slice(selectorStart, index)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim()
      blocks.push({ depth, selector, open: index })
      depth += 1
      selectorStart = index + 1
    } else if (character === '}') {
      depth -= 1
      const block = blocks[blocks.length - 1]
      if (block && block.close === undefined && block.depth === depth) {
        block.close = index
        block.body = styles.slice(block.open + 1, index)
      }
      selectorStart = index + 1
    } else if (character === ';' && depth === 0) {
      selectorStart = index + 1
    }
  }
  return blocks.filter((block) => block.close !== undefined && block.body !== undefined)
}

// 选择器逐字匹配（不展开逗号列表），返回声明对象；不存在返回 null。
// 同一选择器出现多次时按层叠顺序合并，后面的覆盖前面的，和浏览器行为一致。
function declarations(styles, selector) {
  const matched = scanBlocks(styles).filter((entry) => entry.selector === selector)
  if (!matched.length) return null
  const result = {}
  for (const block of matched) {
    for (const entry of block.body.split(';')) {
      const text = entry.trim()
      if (!text) continue
      const at = text.indexOf(':')
      if (at < 0) continue
      result[text.slice(0, at).trim()] = text.slice(at + 1).trim()
    }
  }
  return result
}

// 字号（px 数值）；取 font-size 或 font 简写里的字号，读不到返回 null。
function fontSize(styles, selector) {
  const values = declarations(styles, selector)
  if (!values) return null
  const direct = /^(\d+(?:\.\d+)?)px$/.exec(values['font-size'] || '')
  if (direct) return Number(direct[1])
  const shorthand = /^(?:\d+\s+)?(\d+(?:\.\d+)?)px/.exec(values.font || '')
  return shorthand ? Number(shorthand[1]) : null
}

// styles.css 里所有小于 min 的字号取值（简写与 font-size 都算），便于断言"没有更小的字"。
function fontSizesBelow(styles, minimum) {
  const found = []
  const withoutComments = styles.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of withoutComments.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)) {
    if (Number(match[1]) < minimum) found.push(`font-size:${match[1]}px`)
  }
  for (const match of withoutComments.matchAll(/font:(?:\d+\s+)?(\d+(?:\.\d+)?)px/g)) {
    if (Number(match[1]) < minimum) found.push(`font:${match[1]}px`)
  }
  return found
}

module.exports = {
  readStyles,
  declarations,
  fontSize,
  fontSizesBelow,
}
