import React, { useEffect, useRef, useState } from 'react';
import { DownloadSimple, X } from '@phosphor-icons/react';

export function useAppUpdates() {
  const [state, setState] = useState({ phase: 'loading', supported: false, automatic: true });
  const [open, setOpen] = useState(false);
  const [requestingInstall, setRequestingInstall] = useState(false);
  useEffect(() => {
    let disposed = false;
    let changed = false;
    const unsubscribe = window.gitglass.onUpdateState((next) => {
      changed = true;
      if (!disposed) setState(next);
    });
    window.gitglass.getUpdateState().then((next) => {
      if (!disposed && !changed) setState(next);
    }).catch(() => {
      if (!disposed) setState((previous) => ({ ...previous, phase: 'error', error: '无法读取更新状态，请重新启动应用后重试。' }));
    });
    return () => { disposed = true; unsubscribe(); };
  }, []);
  const invoke = async (action, ...args) => {
    try { return await window.gitglass[action](...args); }
    catch {
      setState((previous) => ({ ...previous, error: '更新请求失败，请稍后重试。' }));
      return { ok: false };
    }
  };
  const install = async (session) => {
    if (requestingInstall) return;
    setRequestingInstall(true);
    const result = await invoke('installUpdate', session);
    if (!result?.ok) setRequestingInstall(false);
  };
  return { state, open, setOpen, invoke, install, installing: requestingInstall || state.phase === 'installing' };
}

export function UpdateButton({ updates, disabled }) {
  const ready = updates.state.phase === 'ready';
  return <button type="button" className="top-action update-trigger" aria-label={ready ? '更新已就绪' : '软件更新'} title={ready ? `GitGlass ${updates.state.latestVersion} 已就绪，点击更新` : '软件更新'} aria-haspopup="dialog" disabled={disabled} onClick={() => updates.setOpen(true)}>
    <DownloadSimple size={15} aria-hidden="true" />
    {ready && <span className="update-dot" aria-hidden="true" />}
  </button>;
}

function notesText(notes) {
  if (!notes) return '';
  return /<[^>]+>/.test(notes) ? new DOMParser().parseFromString(notes, 'text/html').body.textContent : notes;
}

export function UpdateDialog({ updates, blockedReason, onInstall }) {
  const ref = useRef(null);
  const { state, installing } = updates;
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  const close = () => { if (!installing) updates.setOpen(false); };
  const working = ['loading', 'checking', 'downloading', 'installing'].includes(state.phase) || installing;
  const status = installing ? '正在保存草稿并准备重启…' : {
    loading: '正在读取更新状态…',
    idle: '检查是否有新版本。',
    checking: '正在检查更新…',
    current: '当前已是最新版本。',
    available: '发现新版本，可以开始下载。',
    downloading: '正在下载更新，关闭此面板后仍会继续。',
    ready: '更新已下载并校验，准备好后即可重启更新。',
    unsupported: state.reason,
    error: '暂时无法完成更新，可以稍后重试。',
  }[state.phase];
  return <dialog ref={ref} className="update-dialog" aria-labelledby="update-title" onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === ref.current) close(); }} onKeyDown={(event) => event.stopPropagation()}>
    <div className="update-heading">
      <div><span>GitGlass</span><h2 id="update-title">软件更新</h2></div>
      <button type="button" className="icon-button" aria-label="关闭软件更新" title="关闭（Esc）" disabled={installing} onClick={close} autoFocus><X size={17} /></button>
    </div>
    <div className="update-body">
      <div className="update-version"><strong>当前版本 {state.currentVersion || '—'}</strong><span>{state.channel === 'beta' ? 'Beta 通道' : '正式版通道'}</span></div>
      {state.latestVersion && <p className="update-latest">新版本 {state.latestVersion}</p>}
      <p className="update-status" role="status" aria-live="polite">{status}</p>
      {state.phase === 'downloading' && <div className="update-progress"><progress max="100" value={state.progress ?? 0} aria-label="更新下载进度" /><span>{Math.floor(state.progress || 0)}%</span></div>}
      {state.notes && <details className="update-notes" open><summary>更新说明</summary><pre>{notesText(state.notes)}</pre></details>}
      {state.error && <p className="update-error" role="alert">{state.error}</p>}
      {blockedReason && state.phase === 'ready' && <p className="update-warning">{blockedReason}</p>}
      {state.supported && <label className="update-preference"><input type="checkbox" checked={state.automatic} disabled={installing} onChange={(event) => updates.invoke('setAutomaticUpdates', event.target.checked)} /><span>自动检查并在后台下载更新<small>下载完成后提醒；仅在你点击时重启安装。</small></span></label>}
    </div>
    <div className="update-footer">
      <button type="button" className="secondary-action" disabled={installing} onClick={close}>{state.phase === 'ready' ? '稍后' : '关闭'}</button>
      {state.supported && <button type="button" className="secondary-action" disabled={working} onClick={() => updates.invoke('checkForUpdates')}>检查更新</button>}
      {state.supported && ['available', 'error'].includes(state.phase) && state.latestVersion && <button type="button" className="primary-action" disabled={working} onClick={() => updates.invoke('downloadUpdate')}>下载更新</button>}
      {(state.phase === 'ready' || installing) && <button type="button" className="primary-action" disabled={installing || Boolean(blockedReason)} onClick={onInstall}>{installing ? '正在准备…' : '重启并更新'}</button>}
    </div>
  </dialog>;
}
