import { Log } from '@microsoft/sp-core-library';
import { BaseApplicationCustomizer } from '@microsoft/sp-application-base';
import { MANUAL_CSS } from './manualStyleCss';

const LOG_SOURCE: string = 'ManualStyleApplicationCustomizer';
const STYLE_ID: string = 'sm-manual-style';

export interface IManualStyleApplicationCustomizerProperties {
  // 비워 둠 — 서식은 manualStyleCss.ts 에 고정
  placeholder?: string;
}

/** 씨몬스터 매뉴얼 사이트 읽기 서식 — 페이지에 <style> 하나를 끼워 넣는다(2026-10-26). */
export default class ManualStyleApplicationCustomizer
  extends BaseApplicationCustomizer<IManualStyleApplicationCustomizerProperties> {

  public onInit(): Promise<void> {
    this._inject();
    // SPA 전환(페이지 이동) 뒤에도 남아 있는지 확인
    this.context.application.navigatedEvent.add(this, () => this._inject());
    Log.info(LOG_SOURCE, 'manual style injected');
    return Promise.resolve();
  }

  private _inject(): void {
    if (document.getElementById(STYLE_ID)) { return; }
    const style: HTMLStyleElement = document.createElement('style');
    style.id = STYLE_ID;
    style.appendChild(document.createTextNode(MANUAL_CSS));
    document.head.appendChild(style);
  }
}
