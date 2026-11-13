// GitGlass 品牌标志：一条克制的 Git 分支路径穿过圆角方形"观察窗"。
// 主色 #2F6FED，墨色 #1F2937，节点留白 #F7F8FA。默认渲染为 20px 顶栏尺寸。
export function BrandMark({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true" focusable="false">
      <rect x="14" y="14" width="100" height="100" rx="26" fill="none" stroke="#2F6FED" strokeWidth="10" />
      <path d="M46 104V24" fill="none" stroke="#1F2937" strokeWidth="9" strokeLinecap="round" />
      <path d="M46 88C46 66 82 74 82 44" fill="none" stroke="#2F6FED" strokeWidth="9" strokeLinecap="round" />
      <circle cx="46" cy="88" r="9" fill="#F7F8FA" stroke="#1F2937" strokeWidth="8" />
      <circle cx="46" cy="44" r="9" fill="#F7F8FA" stroke="#1F2937" strokeWidth="8" />
      <circle cx="82" cy="44" r="9" fill="#F7F8FA" stroke="#2F6FED" strokeWidth="8" />
    </svg>
  )
}
