import { Log } from '@microsoft/sp-core-library';
import { BaseApplicationCustomizer, PlaceholderContent, PlaceholderName } from '@microsoft/sp-application-base';
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
    this._placeBar();
    this.context.application.navigatedEvent.add(this, () => { this._markHome(); this._scheduleToc(); this._placeBar(); });
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

  // 목차 세로 위치 — 본문(텍스트 웹 파트) 윗선에 맞추되, 스크롤하면 위쪽 고정 막대(명령 모음·Teams 머리) 아래에서 멈춘다(겹침 방지, 2026-10-26)
  private _placeToc(nav: HTMLElement): void {
    const content: HTMLElement | null = document.querySelector(CONTENT_SEL);
    let floor: number = 120;
    const bars: HTMLElement[] = Array.prototype.slice.call(document.querySelectorAll('[data-automation-id="pageCommandBar"], [data-automation-id="pageHeader"], #spCommandBar, [role="menubar"]'));
    for (const b of bars) { const r: DOMRect = b.getBoundingClientRect(); if (r.height > 0 && r.top < 200 && r.bottom > floor) { floor = r.bottom; } }
    floor += 16;
    const contentTop: number = content ? content.getBoundingClientRect().top : floor;
    nav.style.top = `${Math.max(floor, contentTop)}px`;
  }

  // 스크롤 위치에 맞춰 현재 항목 강조 + 위치 보정
  private _spy(): void {
    const nav: HTMLElement | null = document.getElementById(TOC_ID);
    if (!nav) { return; }
    this._placeToc(nav);
    const links: HTMLAnchorElement[] = Array.prototype.slice.call(nav.querySelectorAll('a'));
    let current: HTMLAnchorElement | undefined;
    for (const a of links) {
      const h: HTMLElement | null = document.getElementById((a.getAttribute('href') || '').slice(1));
      if (h && h.getBoundingClientRect().top <= 140) { current = a; }
    }
    links.forEach((a: HTMLAnchorElement) => a.classList.toggle('is-active', a === current));
  }

  // 위쪽 '← 뒤로 · 홈' 줄 — Teams 탭처럼 브라우저 뒤로가기가 없는 곳을 위해(2026-10-26). 홈에서는 '뒤로'만 숨긴다
  private _placeBar(): void {
    const BAR_ID: string = 'sm-manual-bar';
    let bar: HTMLElement | null = document.getElementById(BAR_ID);
    if (!bar) {
      const top: PlaceholderContent | undefined = this.context.placeholderProvider.tryCreateContent(PlaceholderName.Top, { onDispose: () => { /* noop */ } });
      if (!top) { return; }
      bar = document.createElement('div');
      bar.id = BAR_ID;
      bar.innerHTML = `<a href="#" class="smb-back" aria-label="이전 페이지로">← 뒤로</a><span class="smb-sep">·</span><a class="smb-home" href="${this.context.pageContext.web.absoluteUrl}/SitePages/Manual-Home.aspx">홈</a><span class="smb-sep">·</span><a class="smb-open" href="#" aria-label="새 창에서 열기">새 창</a>`;
      bar.querySelector('.smb-back')!.addEventListener('click', (e: Event) => { e.preventDefault(); if (history.length > 1) { history.back(); } else { location.href = `${this.context.pageContext.web.absoluteUrl}/SitePages/Manual-Home.aspx`; } });
      bar.querySelector('.smb-open')!.addEventListener('click', (e: Event) => { e.preventDefault(); window.open(location.href, '_blank'); });
      top.domElement.appendChild(bar);
    }
    bar.setAttribute('data-home', document.body.getAttribute('data-sm-home') || '0');
    bar.setAttribute('data-framed', window.self !== window.top ? '1' : '0');
  }

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
