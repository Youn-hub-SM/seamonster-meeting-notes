"use client";

import { useRouter } from "next/navigation";

export default function DeleteButton({ meetingId }: { meetingId: string }) {
  const router = useRouter();

  async function handleDelete() {
    if (!confirm("이 회의록을 삭제하시겠습니까?")) return;

    const res = await fetch(`/api/meetings/${meetingId}`, {
      method: "DELETE",
    });

    if (res.ok) {
      router.push("/");
      router.refresh();
    }
  }

  return (
    <button className="btn-danger" onClick={handleDelete}>
      삭제
    </button>
  );
}
