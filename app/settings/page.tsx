"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface Member {
  name: string;
  role: string;
}

interface Settings {
  model: string;
  members: Member[];
  context: string;
}

const DEFAULT_SETTINGS: Settings = {
  model: "sonnet",
  members: [],
  context: "",
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("meeting-settings");
    if (stored) {
      setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(stored) });
    }
  }, []);

  function handleSave() {
    localStorage.setItem("meeting-settings", JSON.stringify(settings));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function addMember() {
    if (!newName.trim()) return;
    setSettings({
      ...settings,
      members: [...settings.members, { name: newName.trim(), role: newRole.trim() }],
    });
    setNewName("");
    setNewRole("");
  }

  function removeMember(index: number) {
    setSettings({
      ...settings,
      members: settings.members.filter((_, i) => i !== index),
    });
  }

  return (
    <div className="container">
      <Link href="/" className="btn-secondary" style={{ marginBottom: 24, display: "inline-flex" }}>
        &larr; 돌아가기
      </Link>

      <h1 className="page-title">설정</h1>
      <p className="page-subtitle">모델 선택 및 프롬프트 보강 설정</p>

      {/* 모델 선택 */}
      <div className="settings-section">
        <h2 className="settings-section-title">AI 모델</h2>
        <div className="model-options">
          <label className={`model-option ${settings.model === "sonnet" ? "model-option--active" : ""}`}>
            <input
              type="radio"
              name="model"
              value="sonnet"
              checked={settings.model === "sonnet"}
              onChange={() => setSettings({ ...settings, model: "sonnet" })}
            />
            <div className="model-option-content">
              <span className="model-option-name">Sonnet</span>
              <span className="model-option-badge">권장</span>
            </div>
            <span className="model-option-desc">정확한 분석, 맥락 파악 우수</span>
          </label>
          <label className={`model-option ${settings.model === "haiku" ? "model-option--active" : ""}`}>
            <input
              type="radio"
              name="model"
              value="haiku"
              checked={settings.model === "haiku"}
              onChange={() => setSettings({ ...settings, model: "haiku" })}
            />
            <div className="model-option-content">
              <span className="model-option-name">Haiku</span>
              <span className="model-option-badge model-option-badge--secondary">저렴</span>
            </div>
            <span className="model-option-desc">빠른 처리, 비용 절약</span>
          </label>
        </div>
      </div>

      {/* 팀원 정보 */}
      <div className="settings-section">
        <h2 className="settings-section-title">팀원 정보</h2>
        <p className="settings-hint">
          자주 등장하는 팀원을 등록하면 담당자 지정이 정확해집니다
        </p>

        {settings.members.length > 0 && (
          <div className="member-list">
            {settings.members.map((m, i) => (
              <div key={i} className="member-item">
                <span className="member-name">{m.name}</span>
                {m.role && <span className="member-role">{m.role}</span>}
                <button className="member-remove" onClick={() => removeMember(i)}>
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="member-add">
          <input
            className="member-input"
            placeholder="이름"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addMember())}
          />
          <input
            className="member-input member-input--wide"
            placeholder="역할 (예: 퍼포먼스 마케터)"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addMember())}
          />
          <button type="button" className="btn-secondary" onClick={addMember} disabled={!newName.trim()}>
            추가
          </button>
        </div>
      </div>

      {/* 추가 맥락 */}
      <div className="settings-section">
        <h2 className="settings-section-title">추가 맥락</h2>
        <p className="settings-hint">
          자주 논의되는 주제, 사내 용어, 프로젝트명 등을 자유롭게 작성하세요
        </p>
        <textarea
          className="form-textarea"
          style={{ minHeight: 120 }}
          value={settings.context}
          onChange={(e) => setSettings({ ...settings, context: e.target.value })}
          placeholder={`예시:\n- 메타/구글 광고 캠페인 운영 중\n- CRM은 카카오 알림톡 + 자체 문자 발송\n- 제주 배송은 별도 택배사 사용\n- "씨푸드박스"는 자사 정기배송 상품명`}
        />
      </div>

      <button className="btn-primary" onClick={handleSave}>
        {saved ? "저장 완료!" : "설정 저장"}
      </button>
    </div>
  );
}
