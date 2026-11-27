import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AdminSnapshot, AuthStatus } from '../../../shared/types';
import { CelestialFieldBackdrop } from '../../components/CelestialFieldBackdrop';
import {
  AUTH_CHANGE_EVENT,
  AUTH_REQUIRED_EVENT,
  apiJson,
  notifyAuthChange,
  readAuthStatus,
} from '../../lib/api';
import { createCardPointerHandlers, createMagneticHandlers } from '../../lib/pointer-fx';
import { ArcadeAdminPanel } from './ArcadeAdminPanel';
import { AtlasAdminPanel } from './AtlasAdminPanel';
import { OpsAdminPanel } from './OpsAdminPanel';
import { ProjectsAdminPanel } from './ProjectsAdminPanel';
import { VaultAdminPanel } from './VaultAdminPanel';

type AdminTab = 'atlas' | 'vault' | 'projects' | 'usage' | 'security' | 'arcade';

export default function AdminPage() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTab>('atlas');
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const refreshAll = useCallback(async () => {
    const status = await readAuthStatus();
    setAuth(status);
    if (status.authenticated) {
      const snap = await apiJson<AdminSnapshot>('/api/admin');
      setSnapshot(snap);
    } else {
      setSnapshot(null);
    }
  }, []);

  useEffect(() => {
    refreshAll()
      .catch(() => {})
      .finally(() => setLoading(false));

    const onAuthRequired = () => {
      void refreshAll().catch(() => {});
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    window.addEventListener(AUTH_CHANGE_EVENT, onAuthRequired);
    return () => {
      window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
      window.removeEventListener(AUTH_CHANGE_EVENT, onAuthRequired);
    };
  }, [refreshAll]);

  const handleAuthSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setSubmitting(true);
    setErrorMsg('');
    try {
      const action = auth?.configured ? 'login' : 'setup';
      await apiJson<AuthStatus>('/api/security/auth', {
        method: 'POST',
        json: { action, password },
      });
      setPassword('');
      notifyAuthChange(action);
      await refreshAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '身份验证失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    setErrorMsg('');
    try {
      await apiJson('/api/security/auth', { method: 'POST', json: { action: 'logout' } });
      notifyAuthChange('logout');
      await refreshAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '退出失败');
    }
  };

  const cardHandlers = createCardPointerHandlers();
  const magneticHandlers = createMagneticHandlers(4);

  if (loading) {
    return (
      <div className="relative min-h-[calc(100dvh_-_var(--nav-height))] overflow-hidden">
        <CelestialFieldBackdrop variant="admin-login" />
        <div className="relative z-10 mx-auto max-w-[1280px] px-4 py-14 text-[14px] text-ink-muted sm:px-6">
          正在确认安全会话……
        </div>
      </div>
    );
  }

  if (!auth?.authenticated) {
    return (
      <div className="relative flex min-h-[calc(100dvh_-_var(--nav-height))] items-center justify-center overflow-hidden px-4 py-12 sm:px-6">
        <CelestialFieldBackdrop variant="admin-login" />

        <section
          {...cardHandlers}
          className="interactive-card relative z-10 w-full max-w-[440px] rounded-[24px] border border-hairline bg-surface/90 p-7 shadow-xl backdrop-blur-md sm:p-8"
        >
          <h1 tabIndex={-1} className="display-h1 text-[28px] text-ink">
            整理台
          </h1>
          {!auth?.configured && (
            <p className="mt-2 mb-0 text-[14.5px] text-ink-muted">
              请先通过初始化链接打开后，设置 8 位以上的管理员口令。
            </p>
          )}

          <form onSubmit={handleAuthSubmit} className="mt-6 space-y-4">
            <label className="block text-[13px] text-ink-muted">
              管理口令
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="输入管理口令"
                className="mt-1.5 block w-full rounded-[12px] border border-hairline bg-page/90 px-3.5 py-2.5 text-[14.5px] text-ink transition-colors focus:border-accent focus:outline-none"
              />
            </label>
            <button
              type="submit"
              disabled={submitting}
              {...magneticHandlers}
              className="pill-cta-primary w-full"
            >
              {submitting ? '正在校验…' : auth?.configured ? '登录整理台' : '设置管理口令'}
            </button>
          </form>

          {errorMsg && (
            <p role="alert" className="mt-4 mb-0 text-[13px] text-postmark">
              {errorMsg}
            </p>
          )}
        </section>
      </div>
    );
  }

  const publicJourneys = snapshot
    ? snapshot.library.journeys.filter((j) => j.visibility === 'public').length
    : 0;
  const totalJourneys = snapshot?.library.journeys.length ?? 0;
  const totalMedia = snapshot?.library.media.length ?? 0;
  const pendingMediaCount = snapshot
    ? snapshot.library.media.filter((m) => m.lat === null || m.lng === null || !m.confirmed).length
    : 0;
  const vaultFileCount = snapshot?.vaultFiles.length ?? 0;
  const projectsList = snapshot?.projects ?? [];
  const publishedProjects = projectsList.filter((p) => p.status === 'published').length;
  const trashCount = snapshot?.trash.length ?? 0;

  return (
    <div className="relative min-h-[calc(100dvh_-_var(--nav-height))] overflow-x-clip">
      <div className="pointer-events-none fixed inset-x-0 top-[var(--nav-height)] bottom-0 z-0 overflow-hidden">
        <CelestialFieldBackdrop variant="admin-workspace" />
      </div>
      <div className="relative z-10 mx-auto max-w-[1280px] px-4 py-8 sm:px-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h1 tabIndex={-1} className="display-h1 text-[28px] text-ink sm:text-[32px]">
            整理台
          </h1>

          <button
            type="button"
            onClick={() => void handleLogout()}
            {...magneticHandlers}
            className="pill-cta-secondary"
          >
            退出登录
          </button>
        </div>

        {/* Compact restrained status strip */}
        {snapshot && (
          <div
            aria-label="站点内容实时概览"
            className="mb-5 grid grid-cols-2 gap-2.5 rounded-[18px] border border-hairline bg-surface/85 p-3 sm:grid-cols-3 lg:grid-cols-5"
          >
            <div className="rounded-[12px] bg-paper px-3.5 py-2.5">
              <div className="text-[11.5px] text-ink-muted">公开 / 全部旅程</div>
              <div className="tabular-nums-mono mt-0.5 text-[16px] font-medium text-ink">
                {publicJourneys} / {totalJourneys}
              </div>
            </div>
            <div className="rounded-[12px] bg-paper px-3.5 py-2.5">
              <div className="text-[11.5px] text-ink-muted">影像库</div>
              <div className="tabular-nums-mono mt-0.5 flex items-baseline gap-1.5 text-[16px] font-medium text-ink">
                <span>{totalMedia}</span>
                {pendingMediaCount > 0 && (
                  <span className="text-[11.5px] font-normal text-postmark">
                    待定位 {pendingMediaCount}
                  </span>
                )}
              </div>
            </div>
            <div className="rounded-[12px] bg-paper px-3.5 py-2.5">
              <div className="text-[11.5px] text-ink-muted">密匣文件</div>
              <div className="tabular-nums-mono mt-0.5 text-[16px] font-medium text-ink">
                {vaultFileCount}
              </div>
            </div>
            <div className="rounded-[12px] bg-paper px-3.5 py-2.5">
              <div className="text-[11.5px] text-ink-muted">已发布项目</div>
              <div className="tabular-nums-mono mt-0.5 text-[16px] font-medium text-ink">
                {publishedProjects} / {projectsList.length}
              </div>
            </div>
            <div className="col-span-2 rounded-[12px] bg-paper px-3.5 py-2.5 sm:col-span-1">
              <div className="text-[11.5px] text-ink-muted">回收站</div>
              <div
                className={[
                  'tabular-nums-mono mt-0.5 text-[16px] font-medium',
                  trashCount > 0 ? 'text-postmark' : 'text-ink',
                ].join(' ')}
              >
                {trashCount} 项
              </div>
            </div>
          </div>
        )}

        <div
          role="tablist"
          aria-label="后台模块切换"
          className="mb-6 flex flex-wrap gap-2 border-b border-hairline pb-4"
        >
          {(
            [
              { id: 'atlas', label: '旅图整理' },
              { id: 'vault', label: '文件密匣' },
              { id: 'projects', label: '展柜与首页' },
              { id: 'usage', label: '用量与备份' },
              { id: 'security', label: '安全与会话' },
              { id: 'arcade', label: '竞技榜单' },
            ] as const
          ).map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActiveTab(tab.id)}
                className={[
                  'min-h-[38px] rounded-full px-4 text-[13.5px] transition-colors',
                  selected
                    ? 'bg-cta-bg font-medium text-cta-text'
                    : 'bg-surface text-ink-muted hover:bg-surface-hover hover:text-ink',
                ].join(' ')}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {statusMsg && (
          <p role="status" className="mb-4 rounded-[14px] bg-surface px-4 py-2.5 text-[13px] text-ink">
            {statusMsg}
          </p>
        )}
        {errorMsg && (
          <p role="alert" className="mb-4 rounded-[14px] bg-surface px-4 py-2.5 text-[13px] text-postmark">
            {errorMsg}
          </p>
        )}

        {snapshot && (
          <div key={activeTab} className="panel-fade-in">
            {activeTab === 'atlas' && (
              <AtlasAdminPanel
                snapshot={snapshot}
                onRefresh={refreshAll}
                onStatus={setStatusMsg}
                onError={setErrorMsg}
              />
            )}
            {activeTab === 'vault' && (
              <VaultAdminPanel
                files={snapshot.vaultFiles}
                onRefresh={refreshAll}
                onStatus={setStatusMsg}
                onError={setErrorMsg}
              />
            )}
            {activeTab === 'projects' && (
              <ProjectsAdminPanel
                snapshot={snapshot}
                onRefresh={refreshAll}
                onStatus={setStatusMsg}
                onError={setErrorMsg}
              />
            )}
            {(activeTab === 'usage' || activeTab === 'security') && (
              <OpsAdminPanel
                mode={activeTab}
                trash={snapshot.trash}
                onRefresh={refreshAll}
                onStatus={setStatusMsg}
                onError={setErrorMsg}
              />
            )}
            {activeTab === 'arcade' && (
              <ArcadeAdminPanel
                onStatus={setStatusMsg}
                onError={setErrorMsg}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
