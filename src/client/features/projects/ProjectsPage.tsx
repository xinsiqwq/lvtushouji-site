import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Download,
  ExternalLink,
  KeyRound,
  Layers,
  RefreshCw,
} from 'lucide-react';
import { formatDay } from '../../../shared/dates';
import type { ProjectItem, ProjectLink } from '../../../shared/types';
import { CelestialFieldBackdrop } from '../../components/CelestialFieldBackdrop';
import { createCardPointerHandlers, createMagneticHandlers } from '../../lib/pointer-fx';
import { useRouter } from '../../lib/router';

function formatVersionBadge(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return /^v/i.test(trimmed) ? trimmed : `v${trimmed}`;
}

function buildVaultHref(link: ProjectLink): string {
  const code = link.vaultCode?.trim();
  if (code) {
    return `/vault?code=${encodeURIComponent(code)}`;
  }
  const href = link.href.trim();
  if (href && href.startsWith('/')) {
    return href;
  }
  return '/vault';
}

function isInternalHref(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//');
}

export default function ProjectsPage() {
  const { navigate } = useRouter();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('全部');

  const cardHandlers = createCardPointerHandlers();
  const magneticHandlers = createMagneticHandlers(4);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/projects', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        throw new Error(`无法读取展柜记录（${res.status}）`);
      }
      const data = (await res.json()) as { projects?: ProjectItem[] };
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '作品展柜暂时无法展开，请稍后重试。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const p of projects) {
      const cat = p.category?.trim();
      if (cat && !seen.has(cat)) {
        seen.add(cat);
        list.push(cat);
      }
    }
    return list;
  }, [projects]);

  const filteredProjects = useMemo(() => {
    if (activeCategory === '全部') return projects;
    return projects.filter((p) => p.category?.trim() === activeCategory);
  }, [activeCategory, projects]);

  const handleSpaLink = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    navigate(href);
  };

  const renderActionLink = (link: ProjectLink, index: number) => {
    const primary = index === 0;
    const baseClass = primary
      ? 'pill-cta-primary min-h-[40px] px-5 text-[13.5px]'
      : 'pill-cta-secondary min-h-[40px] px-5 text-[13.5px]';

    if (link.kind === 'vault') {
      const targetHref = buildVaultHref(link);
      return (
        <a
          key={`${link.label}-${index}`}
          href={targetHref}
          onClick={handleSpaLink(targetHref)}
          {...magneticHandlers}
          className={baseClass}
        >
          <KeyRound className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{link.label}</span>
        </a>
      );
    }

    if (link.kind === 'download') {
      const internal = isInternalHref(link.href);
      return (
        <a
          key={`${link.label}-${index}`}
          href={link.href}
          download={internal ? '' : undefined}
          target={internal ? undefined : '_blank'}
          rel={internal ? undefined : 'noopener noreferrer'}
          {...magneticHandlers}
          className={baseClass}
        >
          <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{link.label}</span>
        </a>
      );
    }

    if (link.kind === 'demo' && isInternalHref(link.href)) {
      return (
        <a
          key={`${link.label}-${index}`}
          href={link.href}
          onClick={handleSpaLink(link.href)}
          {...magneticHandlers}
          className={baseClass}
        >
          <span>{link.label}</span>
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </a>
      );
    }

    return (
      <a
        key={`${link.label}-${index}`}
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        {...magneticHandlers}
        className={baseClass}
      >
        <span>{link.label}</span>
        <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </a>
    );
  };

  return (
    <div className="relative min-h-[calc(100dvh_-_var(--nav-height))] overflow-x-clip">
      <CelestialFieldBackdrop variant="subtle-header" />

      <div className="relative z-10 mx-auto max-w-[1160px] px-4 py-8 sm:px-6 sm:py-12">
        {/* Editorial Header */}
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="tabular-nums-mono text-[12px] tracking-[0.08em] text-ink-muted">
              木星轨道 · Jupiter · 5.20 AU
            </div>
            <h1 tabIndex={-1} className="display-h1 mt-2 text-[30px] text-ink sm:text-[40px]">
              作品展柜
            </h1>
            <p className="font-editorial-serif mt-3 mb-0 max-w-[660px] text-[15px] leading-relaxed text-ink-muted sm:text-[15.5px]">
              独立构思、编码并经实测验收的桌面工具与云端系统，按版本架构、核心指标与分发方式归档陈列。
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <a
              href="/vault"
              onClick={handleSpaLink('/vault')}
              className="pill-cta-secondary min-h-[38px] px-4 text-[13px]"
            >
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              <span>前往密匣取件</span>
            </a>
          </div>
        </header>

        {/* Quiet Category Filter Bar */}
        {!loading && !error && categories.length > 1 && (
          <div
            role="group"
            aria-label="按作品类别筛选"
            className="mt-7 flex flex-wrap items-center gap-2"
          >
            {['全部', ...categories].map((cat) => {
              const selected = activeCategory === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setActiveCategory(cat)}
                  className={[
                    'min-h-[34px] rounded-full border px-3.5 text-[13px] transition-colors',
                    selected
                      ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                      : 'border-hairline bg-surface text-ink-muted hover:border-hairline-strong hover:bg-surface-hover hover:text-ink',
                  ].join(' ')}
                >
                  {cat}
                </button>
              );
            })}
            <span className="tabular-nums-mono ml-auto text-[12px] text-ink-muted">
              共 {filteredProjects.length} 项作品
            </span>
          </div>
        )}

        {/* Main Showcase Content */}
        <div className="mt-8 space-y-6">
          {loading ? (
            <div aria-busy="true" aria-label="正在读取作品展柜" className="space-y-6">
              {[0, 1].map((idx) => (
                <div
                  key={idx}
                  className="rounded-[28px] border border-hairline bg-surface p-6 sm:p-8"
                >
                  <div className="flex gap-2">
                    <div className="h-6 w-28 rounded-full bg-paper" />
                    <div className="h-6 w-16 rounded-full bg-paper" />
                  </div>
                  <div className="mt-4 h-7 w-64 max-w-full rounded-[10px] bg-paper" />
                  <div className="mt-3 h-4 w-full max-w-[560px] rounded-[8px] bg-paper" />
                  <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[0, 1, 2, 3].map((m) => (
                      <div key={m} className="h-16 rounded-[16px] bg-paper" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : error ? (
            <section
              role="alert"
              className="rounded-[24px] border border-hairline bg-surface p-8 text-center"
            >
              <p className="m-0 text-[15px] text-ink">{error}</p>
              <div className="mt-5 flex justify-center gap-3">
                <button
                  type="button"
                  onClick={() => void loadProjects()}
                  className="pill-cta-primary min-h-[40px] px-5 text-[13.5px]"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>重新读取</span>
                </button>
              </div>
            </section>
          ) : filteredProjects.length === 0 ? (
            <section className="rounded-[24px] border border-hairline bg-surface p-8 text-center sm:p-12">
              <h2 className="m-0 text-[19px] font-medium text-ink">展柜暂未陈列公开作品</h2>
              <p className="font-editorial-serif mx-auto mt-2.5 mb-0 max-w-[460px] text-[14.5px] text-ink-muted">
                在整理台的「展柜与首页」发布作品后，会在这里以版本卡片形式自动呈现。
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <a
                  href="/"
                  onClick={handleSpaLink('/')}
                  className="pill-cta-secondary min-h-[40px] px-5 text-[13.5px]"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  <span>返回太阳系</span>
                </a>
                <a
                  href="/admin"
                  onClick={handleSpaLink('/admin')}
                  className="pill-cta-primary min-h-[40px] px-5 text-[13.5px]"
                >
                  <span>前往整理台</span>
                </a>
              </div>
            </section>
          ) : (
            filteredProjects.map((project) => {
              const versionText = formatVersionBadge(project.version);
              const updatedDay = formatDay(project.updatedAt);
              const linkNotes = project.links
                .map((item) => item.note?.trim())
                .filter((note): note is string => Boolean(note));

              return (
                <article
                  key={project.id}
                  {...cardHandlers}
                  className="interactive-card rounded-[28px] border border-hairline bg-surface p-6 shadow-xs sm:p-8 lg:p-9"
                >
                  {/* Top Badge Row */}
                  <div className="flex flex-wrap items-center justify-between gap-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      {project.category && (
                        <span className="inline-flex items-center rounded-full border border-hairline bg-paper px-3 py-1 text-[12px] font-medium text-postmark">
                          {project.category}
                        </span>
                      )}
                      {versionText && (
                        <span className="tabular-nums-mono inline-flex items-center rounded-full border border-hairline bg-page/75 px-3 py-1 text-[12px] text-ink-muted">
                          {versionText}
                        </span>
                      )}
                    </div>

                    {updatedDay && (
                      <span className="tabular-nums-mono text-[12px] text-ink-muted">
                        更新于 {updatedDay}
                      </span>
                    )}
                  </div>

                  {/* Title, Subtitle & Editorial Summary */}
                  <div className="mt-4">
                    <h2 className="m-0 text-[23px] font-medium tracking-[-0.02em] text-ink sm:text-[28px]">
                      {project.title}
                    </h2>
                    {project.subtitle && (
                      <p className="mt-1.5 mb-0 text-[14.5px] text-ink-muted">
                        {project.subtitle}
                      </p>
                    )}
                    {project.summary && (
                      <p className="font-editorial-serif mt-4 mb-0 max-w-[820px] text-[15px] leading-[1.82] text-ink sm:text-[15.5px]">
                        {project.summary}
                      </p>
                    )}
                  </div>

                  {/* Optional Cover Preview (preserves natural aspect ratio) */}
                  {project.coverUrl && (
                    <div className="mt-6 overflow-hidden rounded-[18px] border border-hairline bg-paper p-2">
                      <img
                        src={project.coverUrl}
                        alt={project.title}
                        loading="lazy"
                        className="block h-auto w-full rounded-[12px]"
                      />
                    </div>
                  )}

                  {/* Verification Metrics Strip */}
                  {project.metrics.length > 0 && (
                    <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {project.metrics.map((metric, mIdx) => (
                        <div
                          key={`${metric.label}-${mIdx}`}
                          className="rounded-[16px] border border-hairline bg-paper px-4 py-3.5"
                        >
                          <div className="text-[11.5px] text-ink-muted">{metric.label}</div>
                          <div className="tabular-nums-mono mt-1 break-words text-[14.5px] font-medium text-ink sm:text-[15px]">
                            {metric.value}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Architecture Highlights & Tech Stack */}
                  <div className="mt-7 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
                    {project.highlights.length > 0 && (
                      <div>
                        <h3 className="m-0 text-[13px] font-medium text-ink-muted">
                          架构与实测要点
                        </h3>
                        <ul className="mt-3 mb-0 list-none space-y-2.5 p-0">
                          {project.highlights.map((item, hIdx) => (
                            <li
                              key={hIdx}
                              className="flex items-start gap-2.5 text-[14px] leading-relaxed text-ink"
                            >
                              <Check
                                className="mt-1 h-4 w-4 shrink-0 text-accent"
                                aria-hidden="true"
                              />
                              <span className="min-w-0 break-words">{item}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="flex flex-col gap-4">
                      {project.stack.length > 0 && (
                        <div>
                          <h3 className="m-0 text-[13px] font-medium text-ink-muted">技术栈</h3>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {project.stack.map((tech, sIdx) => (
                              <span
                                key={`${tech}-${sIdx}`}
                                className="tabular-nums-mono inline-flex items-center rounded-full border border-hairline bg-page/70 px-3 py-1 text-[12px] text-ink"
                              >
                                {tech}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {project.requirements && (
                        <div className="rounded-[16px] border border-hairline bg-paper/80 px-4 py-3">
                          <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-muted">
                            <Layers className="h-3.5 w-3.5 text-postmark" aria-hidden="true" />
                            <span>运行环境要求</span>
                          </div>
                          <p className="mt-1.5 mb-0 text-[13px] leading-relaxed text-ink">
                            {project.requirements}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Actions & Distribution Notes */}
                  {(project.links.length > 0 || linkNotes.length > 0) && (
                    <div className="mt-7 flex flex-col gap-3 border-t border-hairline pt-5 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex flex-wrap items-center gap-2.5">
                        {project.links.map((link, lIdx) => renderActionLink(link, lIdx))}
                      </div>

                      {linkNotes.length > 0 && (
                        <div className="min-w-0 space-y-1 text-[12.5px] text-ink-muted sm:text-right">
                          {linkNotes.map((note, nIdx) => (
                            <p key={nIdx} className="m-0 leading-relaxed">
                              {note}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>

        {/* Calm Bottom Return Bar */}
        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-6 text-[13px] text-ink-muted">
          <a
            href="/"
            onClick={handleSpaLink('/')}
            className="inline-flex items-center gap-1.5 text-ink-muted no-underline transition-colors hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>返回太阳系首页</span>
          </a>
          <a
            href="/gallery"
            onClick={handleSpaLink('/gallery')}
            className="inline-flex items-center gap-1 text-accent no-underline hover:underline"
          >
            <span>前往金星暗房影集</span>
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  );
}
