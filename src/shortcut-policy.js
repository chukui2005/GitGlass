export function isMacPlatform(platform = '') {
  return /mac|iphone|ipad|ipod/i.test(String(platform))
}

export function shortcutLabel(key, platform = '') {
  return `${isMacPlatform(platform) ? '⌘' : 'Ctrl'} ${key}`
}

export function isTextEditingTarget(target) {
  if (!target) return false
  const tag = String(target.tagName || '').toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true || target.getAttribute?.('contenteditable') === 'true'
}

export function isCommitMessageTarget(target) {
  return target?.id === 'commit-message'
}

export function resolveShortcut(event, context = {}) {
  if (event?.isComposing) return null
  const key = String(event?.key || '').toLowerCase()
  const editing = isTextEditingTarget(event?.target)
  const commandModifier = Boolean(event?.ctrlKey || event?.metaKey)

  if (context.paletteOpen) return key === 'escape' ? 'close-palette' : null
  if (key === 'escape') {
    if (context.loading) return null
    if (!editing || event?.target?.id === 'history-search') return 'escape'
    return null
  }
  if (event?.altKey || !commandModifier) return null
  if (key === 'enter') {
    return editing && isCommitMessageTarget(event.target) && context.hasStaged && context.hasMessage && !context.loading ? 'commit' : null
  }
  if (editing) return null
  if (key === 'k') return 'open-palette'
  if (key === 'f') return context.historyMode ? 'focus-history-search' : null
  if (key === 'j') return 'toggle-ledger'
  return null
}
