import { Log } from '@microsoft/sp-core-library';
import { BaseApplicationCustomizer } from '@microsoft/sp-application-base';
import { MANUAL_CSS } from './manualStyleCss';

const LOG_SOURCE: string = 'ManualStyleApplicationCustomizer';
const STYLE_ID: string = 'sm-manual-style';
const TOC_ID: string = 'sm-manual-toc';
const CONTENT_SEL: string = '.ck-content, [data-automation-id="textBox"], [data-sp-feature-tag="Rich Text Editor"], .rte--read';

export interface IManualStyleApplicationCustomizerProperties {
  placeholder?: string;
}

/** 씨몬스터 매뉴얼 사이트 — 읽기 서식(<style>) + 오른쪽 페이지 목차(TOC) + 홈 표시(2026-10-26). */
export default class ManualStyleApplicationCustomizer
  extends BaseApplicationCustomizer<IManualStyleApplicationCustomizerProperties> {

  private _observer: MutationObserver | undefined;
  private _timer: number | undefined;

  public onInit(): Promise<void> {
    this._injectStyle();
    this._markHome();
    this._scheduleToc();
    this.context.application.navigatedEvent.add(this, () => { this._markHome(); this._scheduleToc(); });
    // 본문은 늦게 렌더되므로 DOM 변화를 보고 목차를 다시 만든다(디바운스)
    this._observer = new MutationObserver(() => this._scheduleToc());
    this._observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('scroll', () => this._spy(), { passive: true });
    Log.info(LOG_SOURCE, 'ready');
    return Promise.resolve();
  }

  private _injectStyle(): void {
    if (document.getElementById(STYLE_ID)) { return; }
    const style: HTMLStyleElement = document.createElement('style');
    style.id = STYLE_ID;
    style.appendChild(document.createTextNode(MANUAL_CSS));
    document.head.appendChild(style);
  }

  // 홈(Manual-Home.aspx)이면 body 에 표시 → CSS 가 카드 모양 등 홈 전용 서식을 건다
  private _markHome(): void {
    const isHome: boolean = /\/SitePages\/Manual-Home\.aspx$/i.test(location.pathname) || /\/sites\/manual\/?$/i.test(location.pathname);
    document.body.setAttribute('data-sm-home', isHome ? '1' : '0');
  }

  private _scheduleToc(): void {
    if (this._timer) { window.clearTimeout(this._timer); }
    this._timer = window.setTimeout(() => this._buildToc(), 400);
  }

  private _buildToc(): void {
    const existing: HTMLElement | null = document.getElementById(TOC_ID);
    if (document.body.getAttribute('data-sm-home') === '1') { if (existing) { existing.remove(); } return; }
    const content: HTMLElement | null = document.querySelector(CONTENT_SEL);
    if (!content) { if (existing) { existing.remove(); } return; }
    const heads: HTMLElement[] = Array.prototype.slice.call(content.querySelectorAll('h2, h3'));
    if (heads.length < 2) { if (existing) { existing.remove(); } return; }

    // 제목마다 id — 같은 글이면 번호 붙임
    const seen: { [k: string]: number } = {};
    const items: string[] = [];
    heads.forEach((h: HTMLElement, i: number) => {
      const text: string = (h.textContent || '').trim();
      if (!text) { return; }
      let id: string = 'smh-' + text.replace(/[^\w가-힣]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60);
      if (seen[id] !== undefined) { seen[id]++; id += '-' + seen[id]; } else { seen[id] = 0; }
      h.id = id;
      items.push(`<li class="smt-${h.tagName.toLowerCase()}"><a href="#${id}" data-i="${i}">${this._esc(text)}</a></li>`);
    });
    const sig: string = items.join('|');
    if (existing && existing.getAttribute('data-sig') === sig) { this._spy(); return; }
    if (existing) { existing.remove(); }
    const nav: HTMLElement = document.createElement('nav');
    nav.id = TOC_ID;
    nav.setAttribute('data-sig', sig);
    nav.setAttribute('aria-label', '이 페이지의 목차');
    nav.innerHTML = `<div class="smt-title">이 페이지</div><ul>${items.join('')}</ul>`;
    nav.addEventListener('click', (e: Event) => {
      const a: HTMLElement | null = (e.target as HTMLElement).closest('a');
      if (!a) { return; }
      e.preventDefault();
      const target: HTMLElement | null = document.getElementById((a.getAttribute('href') || '').slice(1));
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', a.getAttribute('href') || ''); }
    });
    document.body.appendChild(nav);
    this._spy();
  }

  // 스크롤 위치에 맞춰 현재 항목 강조
  private _spy(): void {
    const nav: HTMLElement | null = document.getElementById(TOC_ID);
    if (!nav) { return; }
    const links: HTMLAnchorElement[] = Array.prototype.slice.call(nav.querySelectorAll('a'));
    let current: HTMLAnchorElement | undefined;
    for (const a of links) {
      const h: HTMLElement | null = document.getElementById((a.getAttribute('href') || '').slice(1));
      if (h && h.getBoundingClientRect().top <= 140) { current = a; }
    }
    links.forEach((a: HTMLAnchorElement) => a.classList.toggle('is-active', a === current));
  }

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
