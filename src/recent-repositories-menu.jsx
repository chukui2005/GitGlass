import { useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, Trash } from "@phosphor-icons/react";

const RECENT_LIMIT = 5;

// Windows paths are case-insensitive and Git may report either separator, so the
// current-repository check compares a normalised key instead of raw strings.
const pathKey = (value) =>
  String(value)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();

function repositoryName(value) {
  return value?.split(/[\\/]/).filter(Boolean).at(-1) || value;
}

/**
 * Turns the IPC payload (or bare path strings) into the rows the menu renders:
 * newest first, at most five, duplicates ignored and the current repository
 * flagged instead of reordered. Kept pure so it can be tested without Electron.
 */
export function buildRecentItems(repositories, currentPath) {
  const current =
    typeof currentPath === "string" && currentPath ? pathKey(currentPath) : null;
  const seen = new Set();
  const items = [];
  for (const entry of Array.isArray(repositories) ? repositories : []) {
    const repositoryPath = typeof entry === "string" ? entry : entry?.path;
    if (typeof repositoryPath !== "string" || !repositoryPath) continue;
    const key = pathKey(repositoryPath);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const described = typeof entry === "object" && entry !== null ? entry : {};
    items.push({
      path: repositoryPath,
      name: described.name || repositoryName(repositoryPath) || repositoryPath,
      exists: described.exists !== false,
      current: current !== null && key === current,
    });
    if (items.length === RECENT_LIMIT) break;
  }
  return items;
}

/**
 * Top-bar switcher for the last five opened repositories. Rendering nothing when
 * the list is empty keeps the welcome state clean; the trigger still works when
 * no repository is open yet.
 */
export function RecentRepositoriesMenu({
  repositories,
  currentPath,
  disabled = false,
  onOpen,
  onForget,
}) {
  const items = useMemo(
    () => buildRecentItems(repositories, currentPath),
    [repositories, currentPath],
  );
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const itemRefs = useRef([]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  useEffect(() => {
    setActiveIndex((value) =>
      Math.min(value, Math.max(0, items.length - 1)),
    );
    // A forgotten last entry must not leave an empty, focus-trapping menu open.
    if (open && !items.length) {
      setOpen(false);
      triggerRef.current?.focus();
    }
  }, [items.length, open]);

  if (!items.length) return null;

  const close = (restoreFocus) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const openMenu = (index) => {
    setActiveIndex(Math.max(0, Math.min(index, items.length - 1)));
    setOpen(true);
  };

  const activate = (item) => {
    setOpen(false);
    triggerRef.current?.focus();
    onOpen?.(item);
  };

  const move = (step) =>
    setActiveIndex((value) => (value + step + items.length) % items.length);

  function handleTriggerKeyDown(event) {
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      event.preventDefault();
      openMenu(0);
    }
  }

  function handleMenuKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(items.length - 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    // Enter/Space on the remove button belongs to that button, not the row.
    if (event.target.closest?.("button")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(items[activeIndex]);
    }
  }

  return (
    <div className="recent-repositories" ref={rootRef}>
      <button
        type="button"
        className="top-action recent-repositories-trigger"
        ref={triggerRef}
        aria-label="最近仓库"
        title="最近打开的仓库"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close(true) : openMenu(0))}
        onKeyDown={handleTriggerKeyDown}
      >
        <CaretDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="recent-repositories-menu"
          role="menu"
          aria-label="最近仓库"
          onKeyDown={handleMenuKeyDown}
        >
          {items.map((item, index) => (
            <div
              key={item.path}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              role="menuitem"
              tabIndex={-1}
              aria-current={item.current ? "true" : undefined}
              className={`recent-repository${item.current ? " current" : ""}${item.exists ? "" : " missing"}`}
              title={item.path}
              onClick={() => activate(item)}
              onFocus={() => setActiveIndex(index)}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <span className="recent-repository-main">
                <span className="recent-repository-name">
                  {item.name}
                  {item.current && (
                    <span className="recent-repository-badge">当前</span>
                  )}
                </span>
                <span className="recent-repository-path">{item.path}</span>
                {!item.exists && (
                  <span className="recent-repository-missing">路径不存在</span>
                )}
              </span>
              <button
                type="button"
                className="recent-repository-remove"
                aria-label={`从最近仓库移除 ${item.name}`}
                title="从最近仓库移除"
                onClick={(event) => {
                  event.stopPropagation();
                  onForget?.(item.path);
                }}
              >
                <Trash size={13} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
