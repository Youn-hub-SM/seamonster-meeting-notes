"use client";

// 사업장 직인 — 증명서를 인쇄할 때 대표자 이름 옆에 찍히는 그림. 사업장 수정 창 안에서 바로 올리고 지운다(창의 [변경 저장]과 따로).
//  고른 그림은 브라우저에서 긴 변 600px 의 PNG 로 줄여 올린다(휴대폰으로 찍은 큰 사진도 올라가게).

import { useEffect, useState } from "react";
import { useToast } from "@/app/components/Feedback";
import { isStampDataUrl } from "@/app/lib/hr-docs";
import { HrApiError, errText, hrApi } from "../api";

const MAX_SIDE = 600;

function shrink(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("그림 파일을 읽지 못했습니다.")); };
    img.src = url;
  });
}

export default function StampField({ workplaceId }: { workplaceId: string }) {
  const toast = useToast();
  const [image, setImage] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "pending" | "error">("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    hrApi<{ image: string | null; pending: boolean }>(`/api/hr/stamp?workplace=${workplaceId}`)
      .then((j) => { if (alive) { setImage(j.image); setState(j.pending ? "pending" : "ready"); } })
      .catch((err) => { if (alive) setState(err instanceof HrApiError && err.pending ? "pending" : "error"); });
    return () => { alive = false; };
  }, [workplaceId]);

  async function pick(file: File | null) {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) { toast.error("PNG·JPG 그림 파일을 고르세요"); return; }
    setBusy(true);
    try {
      const data = await shrink(file);
      if (!isStampDataUrl(data)) throw new Error("그림이 너무 큽니다. 더 작은 파일을 고르세요.");
      await hrApi("/api/hr/stamp", "PUT", { workplace_id: workplaceId, image: data });
      setImage(data);
      toast.success("직인을 올렸습니다");
    } catch (err) { toast.error(errText(err, "직인을 올리지 못했습니다.")); }
    setBusy(false);
  }
  async function remove() {
    setBusy(true);
    try {
      await hrApi(`/api/hr/stamp?workplace=${workplaceId}`, "DELETE");
      setImage(null);
      toast.success("직인을 지웠습니다");
    } catch (err) { toast.error(errText(err, "직인을 지우지 못했습니다.")); }
    setBusy(false);
  }

  return (
    <section className="hr-form-sec">
      <h3>직인</h3>
      {state === "pending" ? (
        <div className="sm-warn hr-wide">DB 준비 전입니다. supabase/migrations/hr/005_stamps_links.sql 을 적용하세요.</div>
      ) : state === "error" ? (
        <div className="b2b-error hr-wide">직인을 불러오지 못했습니다.</div>
      ) : (
        <div className="hr-stamp hr-wide">
          <div className="hr-stamp-box">{state === "loading" ? "" : image ? <img src={image} alt="직인" /> : <span>직인 없음</span>}</div>
          <div className="hr-stamp-actions">
            <label className="b2b-btn-secondary">
              {image ? "직인 바꾸기" : "직인 올리기"}
              <input type="file" accept="image/png,image/jpeg" hidden disabled={busy || state !== "ready"} onChange={(e) => { pick(e.target.files?.[0] || null); e.target.value = ""; }} />
            </label>
            {image && <button type="button" className="b2b-btn-secondary" onClick={remove} disabled={busy}>직인 지우기</button>}
          </div>
        </div>
      )}
    </section>
  );
}
