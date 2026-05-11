import { NextResponse } from "next/server";
import type { Order, OrderInput } from "@/app/lib/orders";
import { migrateStatus } from "@/app/lib/orders";

export const dynamic = "force-dynamic";

function apiUrl(): string {
  const url = process.env.ORDERS_SHEET_API_URL;
  if (!url) {
    throw new Error("환경변수 ORDERS_SHEET_API_URL 가 설정되어 있지 않습니다.");
  }
  return url;
}

async function callAppsScript(method: "GET" | "POST", body?: unknown) {
  const init: RequestInit = {
    method,
    cache: "no-store",
    redirect: "follow",
  };
  if (body !== undefined) {
    // Apps Script Web App 은 application/json 본문도 e.postData.contents 로 받음
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }

  const res = await fetch(apiUrl(), init);
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Apps Script 응답 파싱 실패: ${text.slice(0, 200)}`);
  }
  return data as { ok: boolean; error?: string; orders?: Order[]; id?: string };
}

export async function GET() {
  try {
    const data = await callAppsScript("GET");
    if (!data.ok) {
      return NextResponse.json({ error: data.error || "조회 실패" }, { status: 500 });
    }
    const orders = (data.orders ?? []).map((o) => ({
      ...o,
      status: migrateStatus(o.status),
    }));
    return NextResponse.json({ orders });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "조회 중 오류" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const order = (await request.json()) as OrderInput;
    const data = await callAppsScript("POST", { action: "create", order });
    if (!data.ok) {
      return NextResponse.json({ error: data.error || "등록 실패" }, { status: 500 });
    }
    return NextResponse.json({ id: data.id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "등록 중 오류" },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  try {
    const order = (await request.json()) as Order;
    if (!order.id) {
      return NextResponse.json({ error: "id 누락" }, { status: 400 });
    }
    const data = await callAppsScript("POST", { action: "update", order });
    if (!data.ok) {
      return NextResponse.json({ error: data.error || "수정 실패" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "수정 중 오류" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 누락" }, { status: 400 });
    }
    const data = await callAppsScript("POST", { action: "delete", id });
    if (!data.ok) {
      return NextResponse.json({ error: data.error || "삭제 실패" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "삭제 중 오류" },
      { status: 500 }
    );
  }
}
