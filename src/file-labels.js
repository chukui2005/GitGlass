// 文件路径的展示规则：主标签只显示 basename，完整相对路径留在 title / 可访问名称里。
// 同一分组出现同名文件时，补最短可区分的父目录尾段（例如 `configuration.ts  test/settings/`），
// 逐步加长父目录，必要时回退完整相对路径。纯函数，便于单测与两个栏位共用。

const separator = /[\\/]+/;

/** 把路径切成非空片段，同时接受 `\` 与 `/`。 */
export function pathSegments(value) {
  return String(value ?? '')
    .split(separator)
    .filter(Boolean);
}

/** 路径最后一段（文件名）。 */
export function basename(value) {
  return pathSegments(value).at(-1) || '';
}

/** 父目录片段（不含文件名）。 */
export function dirSegments(value) {
  return pathSegments(value).slice(0, -1);
}

/**
 * 批量暂存勾选的稳定键：区域 + 路径。
 * 同一个文件可以同时出现在未暂存与已暂存两个区域，只用路径会让两次命中互相污染。
 * @param {string} area
 * @param {string} path
 * @returns {string}
 */
export function stageSelectionKey(area, path) {
  return `${area}:${path}`;
}

/**
 * 左栏一行文件的显示名。
 * 路径按 Git 给出的原样保留：连续的空白属于文件名的一部分，
 * `new note.md` 与 `new  note.md` 必须仍是两个可区分、可准确命中的路径。
 * @param {string} path
 * @returns {{ name: string, dir: string, title: string }}
 */
export function fileLabel(path) {
  const title = String(path ?? '');
  return { name: basename(title), dir: dirSegments(title).join('/'), title };
}

/**
 * 为一组同区域的文件计算显示名，同名的按需补父目录尾段。
 * 返回数组与入参一一对应（调用方按下标取用，避免再来一层 Map 查找）。
 *
 * @param {Array<{ path?: string }>} files
 * @returns {Array<{ name: string, dir: string, title: string }>}
 */
export function labelFiles(files) {
  const entries = (Array.isArray(files) ? files : []).map((file, index) => {
    const label = fileLabel(file?.path);
    const segments = dirSegments(label.title);
    // 列表里默认不显示目录：只有同名冲突才补尾段，避免每一行都在重复路径。
    label.dir = '';
    return { index, label, segments };
  });

  const groups = new Map();
  for (const entry of entries) {
    const key = entry.label.name.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // 逐个加长父目录尾段，唯一就定下来；始终区分不开时退回完整相对路径。
    const unresolved = new Set(group);
    const longest = Math.max(...group.map((entry) => entry.segments.length));
    for (let depth = 1; depth <= longest && unresolved.size; depth += 1) {
      const buckets = new Map();
      for (const entry of unresolved) {
        const suffix = entry.segments.slice(-depth).join('/');
        const key = suffix || entry.label.title;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(entry);
      }
      for (const [suffix, bucket] of buckets) {
        if (bucket.length === 1) {
          const [entry] = bucket;
          // 目录尾段带上末尾 `/`，与「文件名 + 目录」的读法一致。
          entry.label.dir = suffix.endsWith('/') ? suffix : `${suffix}/`;
          unresolved.delete(entry);
        }
      }
    }
    for (const entry of unresolved) {
      const full = entry.segments.join('/');
      entry.label.dir = full ? `${full}/` : entry.label.title;
    }
  }

  return entries.map((entry) => entry.label);
}

/**
 * 面包屑片段：目录逐段显示，最后一段是文件名。
 * @param {string} path
 * @returns {string[]}
 */
export function breadcrumbSegments(path) {
  return pathSegments(path);
}
