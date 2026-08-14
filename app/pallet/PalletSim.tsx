"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// 파렛트 적재 시뮬레이터 — 박스·파렛트 치수를 넣고 3D 화면에서 드래그로 쌓아 본다.
//  실물을 쌓아 보거나 종이에 그리던 것을 대신하는 화면 전용 도구: DB 없음, 브라우저(localStorage)에만 보관.
//  좌표계: 씬 1단위 = 100mm. 파렛트 상판 중심이 원점, Y 위.
//  물리 규칙: 박스는 항상 '지지면'(파렛트 상판 또는 XZ가 겹치는 박스들의 최고 윗면)에 내려앉는다 —
//  이 규칙 하나로 겹침이 원천 차단되고(겹치면 위로 올라감), 아래 박스를 빼면 settle()이 위 박스를 다시 떨어뜨린다.

const MM = 0.01; // mm → 씬 단위(1단위=100mm)
const SNAP = 10; // 배치 스냅(mm)
const PALLET_H = 150; // 파렛트 자체 높이(mm)

type BoxType = { id: string; name: string; w: number; d: number; h: number; color: string };
type Placed = { id: string; typeId: string; x: number; z: number; y: number; rot: boolean }; // x,z = 중심(mm, 파렛트 중심 기준), y = 바닥(mm, 상판=0), rot = 90도 회전(w↔d)
type PalletCfg = { w: number; d: number; maxH: number };

const PRESETS: { label: string; w: number; d: number }[] = [
  { label: "T11 (1100×1100)", w: 1100, d: 1100 },
  { label: "T12 (1200×1000)", w: 1200, d: 1000 },
  { label: "EU (1200×800)", w: 1200, d: 800 },
];
const COLORS = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#b07aa1", "#76b7b2", "#edc948"];
const LS_KEY = "pallet_sim_v1";
const uid = () => Math.random().toString(36).slice(2, 9);

// 박스의 실제 가로/세로(mm) — 회전 반영
const dims = (t: BoxType, rot: boolean) => ({ w: rot ? t.d : t.w, d: rot ? t.w : t.d, h: t.h });

// XZ 사각형 겹침 (중심+치수, 1mm 미만 접촉은 무시)
function overlapXZ(ax: number, az: number, aw: number, ad: number, bx: number, bz: number, bw: number, bd: number): boolean {
  return Math.abs(ax - bx) < (aw + bw) / 2 - 1 && Math.abs(az - bz) < (ad + bd) / 2 - 1;
}

export default function PalletSim() {
  // ── 설정 상태 (React) ──
  const [pallet, setPallet] = useState<PalletCfg>({ w: 1100, d: 1100, maxH: 1800 });
  const [types, setTypes] = useState<BoxType[]>([
    { id: "t1", name: "아이스박스 대", w: 520, d: 360, h: 280, color: COLORS[0] },
  ]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [version, setVersion] = useState(0); // boxesRef 변경 알림(통계 재계산용)
  const [loaded, setLoaded] = useState(false);

  // 새 박스 종류 입력
  const [nName, setNName] = useState("");
  const [nW, setNW] = useState("");
  const [nD, setND] = useState("");
  const [nH, setNH] = useState("");

  // ── 3D 쪽 참조 ──
  const mountRef = useRef<HTMLDivElement>(null);
  const boxesRef = useRef<Placed[]>([]);
  const typesRef = useRef<BoxType[]>(types);
  const palletRef = useRef<PalletCfg>(pallet);
  const selectedRef = useRef<string | null>(null);
  const rebuildRef = useRef<() => void>(() => {});
  typesRef.current = types;
  palletRef.current = pallet;
  selectedRef.current = selectedId;

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // 지지면 높이(mm) — XZ 가 겹치는 박스들의 최고 윗면, 없으면 상판(0). self 는 제외.
  const supportY = useCallback((x: number, z: number, w: number, d: number, selfId?: string): number => {
    let top = 0;
    for (const b of boxesRef.current) {
      if (b.id === selfId) continue;
      const t = typesRef.current.find((tt) => tt.id === b.typeId);
      if (!t) continue;
      const bd = dims(t, b.rot);
      if (overlapXZ(x, z, w, d, b.x, b.z, bd.w, bd.d)) top = Math.max(top, b.y + bd.h);
    }
    return top;
  }, []);

  // 아래가 빠진 박스를 다시 내려앉힘 — 바닥 낮은 것부터 정착시켜야 연쇄 낙하가 맞게 계산된다
  const settle = useCallback(() => {
    const sorted = [...boxesRef.current].sort((a, b) => a.y - b.y);
    const done: Placed[] = [];
    for (const b of sorted) {
      const t = typesRef.current.find((tt) => tt.id === b.typeId);
      if (!t) continue;
      const bd = dims(t, b.rot);
      let top = 0;
      for (const o of done) {
        const ot = typesRef.current.find((tt) => tt.id === o.typeId);
        if (!ot) continue;
        const od = dims(ot, o.rot);
        if (overlapXZ(b.x, b.z, bd.w, bd.d, o.x, o.z, od.w, od.d)) top = Math.max(top, o.y + od.h);
      }
      done.push({ ...b, y: top });
    }
    boxesRef.current = done;
  }, []);

  const persist = useCallback(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ pallet: palletRef.current, types: typesRef.current, boxes: boxesRef.current }));
    } catch { /* 보관 실패는 치명적이지 않음 */ }
  }, []);

  // 저장본 복원
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const d = JSON.parse(raw) as { pallet?: PalletCfg; types?: BoxType[]; boxes?: Placed[] };
        if (d.pallet?.w) setPallet(d.pallet);
        if (d.types?.length) setTypes(d.types);
        if (d.boxes) boxesRef.current = d.boxes;
      }
    } catch { /* 손상된 저장본 무시 */ }
    setLoaded(true);
  }, []);

  // ── three 씬 구성 ──
  useEffect(() => {
    if (!loaded) return;
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f1ec);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = "none"; // 모바일에서 드래그가 스크롤로 새지 않게

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(8, 14, 6);
    scene.add(sun);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;

    // 파렛트·바닥 — 설정이 바뀌면 다시 그린다
    const staticGroup = new THREE.Group();
    scene.add(staticGroup);
    function buildStatic() {
      staticGroup.clear();
      const P = palletRef.current;
      const pw = P.w * MM, pd = P.d * MM, ph = PALLET_H * MM;
      const wood = new THREE.MeshLambertMaterial({ color: 0xc89b5f });
      // 상판 + 굄목 3개(파렛트 느낌만)
      const deck = new THREE.Mesh(new THREE.BoxGeometry(pw, ph * 0.35, pd), wood);
      deck.position.y = -ph * 0.175;
      staticGroup.add(deck);
      for (let i = -1; i <= 1; i++) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(pw, ph * 0.65, 0.9), wood);
        leg.position.set(0, -ph * 0.35 - ph * 0.325, i * (pd / 2 - 0.55));
        staticGroup.add(leg);
      }
      const grid = new THREE.GridHelper(Math.max(pw, pd), Math.round(Math.max(P.w, P.d) / 100), 0xb0a695, 0xd8cfc0);
      grid.position.y = 0.002;
      staticGroup.add(grid);
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshLambertMaterial({ color: 0xe9e4db }));
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -ph;
      staticGroup.add(ground);
      // 카메라 초기 위치도 파렛트 크기에 맞춤
      const r = Math.max(pw, pd);
      camera.position.set(r * 1.5, r * 1.35, r * 1.8);
      controls.target.set(0, r * 0.35, 0);
    }
    buildStatic();

    // 박스 메시 — 구조 변경 시 통째로 재구성(수십 개 수준이라 충분)
    const boxGroup = new THREE.Group();
    scene.add(boxGroup);
    const meshById = new Map<string, THREE.Mesh>();
    function rebuild() {
      boxGroup.clear();
      meshById.clear();
      for (const b of boxesRef.current) {
        const t = typesRef.current.find((tt) => tt.id === b.typeId);
        if (!t) continue;
        const bd = dims(t, b.rot);
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(bd.w * MM, bd.h * MM, bd.d * MM),
          new THREE.MeshLambertMaterial({ color: t.color })
        );
        mesh.position.set(b.x * MM, (b.y + bd.h / 2) * MM, b.z * MM);
        mesh.userData.id = b.id;
        const edge = new THREE.LineSegments(
          new THREE.EdgesGeometry(mesh.geometry),
          new THREE.LineBasicMaterial({ color: 0x2f2a24, transparent: true, opacity: 0.35 })
        );
        mesh.add(edge);
        if (b.id === selectedRef.current) {
          (mesh.material as THREE.MeshLambertMaterial).emissive = new THREE.Color(0x7a4a00);
          (mesh.material as THREE.MeshLambertMaterial).emissiveIntensity = 0.55;
        }
        meshById.set(b.id, mesh);
        boxGroup.add(mesh);
      }
    }
    rebuildRef.current = () => { buildStatic(); rebuild(); };
    rebuild();

    // ── 드래그 ──
    const ray = new THREE.Raycaster();
    const ptr = new THREE.Vector2();
    let dragging: { id: string; offX: number; offZ: number; startX: number; startZ: number } | null = null;
    const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    function pointerToScene(e: PointerEvent): THREE.Vector3 | null {
      const rect = renderer.domElement.getBoundingClientRect();
      ptr.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ptr, camera);
      const hit = new THREE.Vector3();
      return ray.ray.intersectPlane(dragPlane, hit) ? hit : null;
    }

    function onDown(e: PointerEvent) {
      if (e.button !== 0) return;
      const rect = renderer.domElement.getBoundingClientRect();
      ptr.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ptr, camera);
      const hits = ray.intersectObjects(boxGroup.children, false);
      const mesh = hits[0]?.object as THREE.Mesh | undefined;
      if (!mesh) { setSelectedId(null); return; }
      const id = mesh.userData.id as string;
      const box = boxesRef.current.find((b) => b.id === id);
      if (!box) return;
      const t = typesRef.current.find((tt) => tt.id === box.typeId);
      if (!t) return;
      setSelectedId(id);
      // 드래그 평면을 잡은 박스의 바닥 높이에 깔고, 잡은 지점과 중심의 차이를 기억한다
      dragPlane.constant = -box.y * MM;
      const hit = pointerToScene(e);
      if (!hit) return;
      dragging = { id, offX: box.x - hit.x / MM, offZ: box.z - hit.z / MM, startX: box.x, startZ: box.z };
      controls.enabled = false;
      renderer.domElement.setPointerCapture(e.pointerId);
    }

    function onMove(e: PointerEvent) {
      if (!dragging) return;
      const box = boxesRef.current.find((b) => b.id === dragging!.id);
      const t = box && typesRef.current.find((tt) => tt.id === box.typeId);
      if (!box || !t) return;
      const hit = pointerToScene(e);
      if (!hit) return;
      const bd = dims(t, box.rot);
      const P = palletRef.current;
      // 스냅 + 파렛트 안쪽으로 클램프
      let x = Math.round((hit.x / MM + dragging.offX) / SNAP) * SNAP;
      let z = Math.round((hit.z / MM + dragging.offZ) / SNAP) * SNAP;
      x = Math.min(P.w / 2 - bd.w / 2, Math.max(-P.w / 2 + bd.w / 2, x));
      z = Math.min(P.d / 2 - bd.d / 2, Math.max(-P.d / 2 + bd.d / 2, z));
      box.x = x; box.z = z;
      box.y = supportY(x, z, bd.w, bd.d, box.id);
      dragPlane.constant = -box.y * MM; // 층이 바뀌어도 손끝을 따라오게
      const mesh = meshById.get(box.id);
      if (mesh) mesh.position.set(x * MM, (box.y + bd.h / 2) * MM, z * MM);
    }

    function onUp(e: PointerEvent) {
      if (!dragging) { controls.enabled = true; return; }
      settle();
      rebuild();
      persist();
      bump();
      dragging = null;
      controls.enabled = true;
      try { renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* 이미 해제됨 */ }
    }

    const dom = renderer.domElement;
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerup", onUp);

    // 리사이즈
    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth, h = mount.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(mount);

    let raf = 0;
    const loop = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerup", onUp);
      controls.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm.dispose());
      });
      mount.removeChild(dom);
      rebuildRef.current = () => {};
    };
    // 씬은 한 번만 만들고, 설정 변경은 rebuildRef 로 반영한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // 설정·선택 변경 → 씬 갱신
  useEffect(() => { rebuildRef.current(); }, [pallet, types, selectedId, version]);

  // ── 조작 (React 쪽) ──
  const addBox = useCallback((typeId: string) => {
    const t = typesRef.current.find((tt) => tt.id === typeId);
    if (!t) return;
    const P = palletRef.current;
    const bd = dims(t, false);
    if (bd.w > P.w || bd.d > P.d) { window.alert("박스가 파렛트보다 큽니다."); return; }
    // 왼쪽 앞 구석부터 스냅 격자로 훑어 가장 낮게 놓이는 첫 자리를 찾는다
    let best: { x: number; z: number; y: number } | null = null;
    for (let z = -P.d / 2 + bd.d / 2; z <= P.d / 2 - bd.d / 2 + 0.5; z += SNAP * 2) {
      for (let x = -P.w / 2 + bd.w / 2; x <= P.w / 2 - bd.w / 2 + 0.5; x += SNAP * 2) {
        const sx = Math.round(x / SNAP) * SNAP, sz = Math.round(z / SNAP) * SNAP;
        const y = supportY(sx, sz, bd.w, bd.d);
        if (!best || y < best.y) best = { x: sx, z: sz, y };
        if (y === 0) { best = { x: sx, z: sz, y: 0 }; break; }
      }
      if (best && best.y === 0) break;
    }
    if (!best) return;
    const box: Placed = { id: uid(), typeId, x: best.x, z: best.z, y: best.y, rot: false };
    boxesRef.current = [...boxesRef.current, box];
    setSelectedId(box.id);
    persist(); bump();
  }, [supportY, persist, bump]);

  const rotateSelected = useCallback(() => {
    const box = boxesRef.current.find((b) => b.id === selectedRef.current);
    const t = box && typesRef.current.find((tt) => tt.id === box.typeId);
    if (!box || !t) return;
    const P = palletRef.current;
    const nd = dims(t, !box.rot);
    if (nd.w > P.w || nd.d > P.d) return;
    box.rot = !box.rot;
    // 회전으로 경계를 벗어나면 안으로 당기고, 지지면 다시 계산
    box.x = Math.min(P.w / 2 - nd.w / 2, Math.max(-P.w / 2 + nd.w / 2, box.x));
    box.z = Math.min(P.d / 2 - nd.d / 2, Math.max(-P.d / 2 + nd.d / 2, box.z));
    box.y = supportY(box.x, box.z, nd.w, nd.d, box.id);
    settle();
    persist(); bump();
  }, [supportY, settle, persist, bump]);

  const removeSelected = useCallback(() => {
    if (!selectedRef.current) return;
    boxesRef.current = boxesRef.current.filter((b) => b.id !== selectedRef.current);
    setSelectedId(null);
    settle();
    persist(); bump();
  }, [settle, persist, bump]);

  // 키보드: R 회전 · Delete 삭제 (입력칸에 포커스가 있으면 무시)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "r" || e.key === "R" || e.key === "ㄱ") { e.preventDefault(); rotateSelected(); }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSelected(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rotateSelected, removeSelected]);

  // 1층 자동 채우기 — 0도/90도 격자 중 더 많이 들어가는 방향으로
  const autoFill = useCallback((typeId: string) => {
    const t = typesRef.current.find((tt) => tt.id === typeId);
    if (!t) return;
    const P = palletRef.current;
    const a = { rot: false, nx: Math.floor(P.w / t.w), nz: Math.floor(P.d / t.d) };
    const b = { rot: true, nx: Math.floor(P.w / t.d), nz: Math.floor(P.d / t.w) };
    const pick = a.nx * a.nz >= b.nx * b.nz ? a : b;
    if (pick.nx * pick.nz === 0) { window.alert("이 방향으로는 1개도 들어가지 않습니다."); return; }
    if (boxesRef.current.length && !window.confirm("지금 쌓인 박스를 비우고 1층을 자동으로 채울까요?")) return;
    const bd = dims(t, pick.rot);
    const startX = -(pick.nx * bd.w) / 2 + bd.w / 2;
    const startZ = -(pick.nz * bd.d) / 2 + bd.d / 2;
    const out: Placed[] = [];
    for (let i = 0; i < pick.nx; i++)
      for (let j = 0; j < pick.nz; j++)
        out.push({ id: uid(), typeId, x: Math.round((startX + i * bd.w) / SNAP) * SNAP, z: Math.round((startZ + j * bd.d) / SNAP) * SNAP, y: 0, rot: pick.rot });
    boxesRef.current = out;
    setSelectedId(null);
    persist(); bump();
  }, [persist, bump]);

  // 현재 배치를 통째로 한 층 위에 복제 — 1층을 손으로 짜고 이 버튼으로 2·3층을 만든다
  const duplicateUp = useCallback(() => {
    if (!boxesRef.current.length) return;
    let maxTop = 0;
    for (const b of boxesRef.current) {
      const t = typesRef.current.find((tt) => tt.id === b.typeId);
      if (t) maxTop = Math.max(maxTop, b.y + dims(t, b.rot).h);
    }
    boxesRef.current = [
      ...boxesRef.current,
      ...boxesRef.current.map((b) => ({ ...b, id: uid(), y: b.y + maxTop })),
    ];
    persist(); bump();
  }, [persist, bump]);

  const clearAll = useCallback(() => {
    if (!boxesRef.current.length) return;
    if (!window.confirm("쌓인 박스를 모두 지울까요?")) return;
    boxesRef.current = [];
    setSelectedId(null);
    persist(); bump();
  }, [persist, bump]);

  // ── 통계 ──
  const stats = useMemo(() => {
    void version;
    const byType = new Map<string, number>();
    let maxTop = 0, floorArea = 0;
    for (const b of boxesRef.current) {
      const t = types.find((tt) => tt.id === b.typeId);
      if (!t) continue;
      byType.set(t.id, (byType.get(t.id) || 0) + 1);
      const bd = dims(t, b.rot);
      maxTop = Math.max(maxTop, b.y + bd.h);
      if (b.y === 0) floorArea += bd.w * bd.d;
    }
    const totalH = maxTop + PALLET_H;
    return {
      total: boxesRef.current.length,
      byType,
      totalH,
      overLimit: totalH > pallet.maxH,
      floorPct: Math.min(100, Math.round((floorArea / (pallet.w * pallet.d)) * 100)),
    };
  }, [version, types, pallet]);

  const selectedBox = selectedId ? boxesRef.current.find((b) => b.id === selectedId) : null;
  const selectedType = selectedBox ? types.find((t) => t.id === selectedBox.typeId) : null;

  function addType() {
    const w = Number(nW), d = Number(nD), h = Number(nH);
    if (!nName.trim() || !(w > 0) || !(d > 0) || !(h > 0)) return;
    setTypes((p) => [...p, { id: uid(), name: nName.trim(), w, d, h, color: COLORS[p.length % COLORS.length] }]);
    setNName(""); setNW(""); setND(""); setNH("");
  }
  function removeType(id: string) {
    const used = boxesRef.current.some((b) => b.typeId === id);
    if (used && !window.confirm("이 종류로 쌓인 박스도 함께 지워집니다. 계속할까요?")) return;
    boxesRef.current = boxesRef.current.filter((b) => b.typeId !== id);
    setTypes((p) => p.filter((t) => t.id !== id));
    settle(); persist(); bump();
  }
  function updatePallet(patch: Partial<PalletCfg>) {
    setPallet((p) => {
      const next = { ...p, ...patch };
      // 파렛트가 줄면 밖으로 나간 박스를 안으로 당기고 다시 정착
      for (const b of boxesRef.current) {
        const t = typesRef.current.find((tt) => tt.id === b.typeId);
        if (!t) continue;
        const bd = dims(t, b.rot);
        b.x = Math.min(next.w / 2 - bd.w / 2, Math.max(-next.w / 2 + bd.w / 2, b.x));
        b.z = Math.min(next.d / 2 - bd.d / 2, Math.max(-next.d / 2 + bd.d / 2, b.z));
      }
      palletRef.current = next;
      settle(); persist(); bump();
      return next;
    });
  }

  return (
    <div className="b2b-container">
      <header className="b2b-page-head">
        <div>
          <h1 className="b2b-page-title">파렛트 적재 시뮬레이터</h1>
          <span style={{ fontSize: 13, color: "var(--sm-text-mid)" }}>
            박스를 드래그해 쌓아 보세요 — 빈 곳 드래그 = 화면 회전 · 휠 = 확대 · R = 박스 회전 · Delete = 삭제
          </span>
        </div>
        <div className="b2b-page-actions">
          <button className="b2b-btn-secondary" onClick={duplicateUp} disabled={stats.total === 0} title="지금 쌓인 모양 그대로 한 층 위에 복제">한 층 복제</button>
          <button className="b2b-btn-secondary" onClick={clearAll} disabled={stats.total === 0}>전체 비우기</button>
        </div>
      </header>

      <div style={{ display: "flex", gap: 16, alignItems: "stretch", flexWrap: "wrap" }}>
        {/* ── 좌측 패널 ── */}
        <div style={{ flex: "0 0 320px", minWidth: 280, display: "flex", flexDirection: "column", gap: 12 }}>
          <section className="b2b-card">
            <div className="b2b-card-head"><span className="b2b-card-title">파렛트</span></div>
            <div className="sm-row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              {PRESETS.map((p) => (
                <button key={p.label} className={pallet.w === p.w && pallet.d === p.d ? "b2b-btn-primary" : "b2b-btn-secondary"}
                  style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => updatePallet({ w: p.w, d: p.d })}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="sm-row" style={{ gap: 8, flexWrap: "wrap" }}>
              <label className="b2b-field" style={{ width: 88 }}><span className="b2b-field-label">가로(mm)</span>
                <input className="b2b-input" type="number" min={100} value={pallet.w} onChange={(e) => updatePallet({ w: Number(e.target.value) || pallet.w })} /></label>
              <label className="b2b-field" style={{ width: 88 }}><span className="b2b-field-label">세로(mm)</span>
                <input className="b2b-input" type="number" min={100} value={pallet.d} onChange={(e) => updatePallet({ d: Number(e.target.value) || pallet.d })} /></label>
              <label className="b2b-field" style={{ width: 100 }}><span className="b2b-field-label">높이 제한(mm)</span>
                <input className="b2b-input" type="number" min={PALLET_H} value={pallet.maxH} onChange={(e) => updatePallet({ maxH: Number(e.target.value) || pallet.maxH })} /></label>
            </div>
            <p className="sm-faint" style={{ fontSize: 12, margin: "8px 0 0" }}>높이 제한은 파렛트(150mm) 포함 총 높이입니다.</p>
          </section>

          <section className="b2b-card">
            <div className="b2b-card-head"><span className="b2b-card-title">박스 종류</span></div>
            <div className="sm-col" style={{ gap: 8 }}>
              {types.map((t) => (
                <div key={t.id} style={{ border: "1px solid var(--sm-border)", borderRadius: 8, padding: "8px 10px" }}>
                  <div className="sm-between" style={{ gap: 8 }}>
                    <span className="sm-row" style={{ gap: 7, minWidth: 0 }}>
                      <span style={{ width: 12, height: 12, borderRadius: 3, background: t.color, flex: "0 0 auto" }} />
                      <strong style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</strong>
                    </span>
                    <button type="button" className="b2b-icon-btn is-danger" aria-label="종류 삭제" onClick={() => removeType(t.id)}>✕</button>
                  </div>
                  <div className="sm-between" style={{ marginTop: 6, gap: 8, flexWrap: "wrap" }}>
                    <span className="sm-faint" style={{ fontSize: 12 }}>{t.w}×{t.d}×{t.h}mm{stats.byType.get(t.id) ? ` · ${stats.byType.get(t.id)}개` : ""}</span>
                    <span className="sm-row" style={{ gap: 6 }}>
                      <button className="b2b-btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => autoFill(t.id)} title="0도/90도 중 더 많이 들어가는 방향으로 1층을 채웁니다">1층 자동</button>
                      <button className="b2b-btn-primary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => addBox(t.id)}>+ 올리기</button>
                    </span>
                  </div>
                </div>
              ))}
              <div style={{ border: "1px dashed var(--sm-border)", borderRadius: 8, padding: "8px 10px" }}>
                <input className="b2b-input" placeholder="박스 이름 (예: 아이스박스 소)" value={nName} onChange={(e) => setNName(e.target.value)} style={{ marginBottom: 6 }} />
                <div className="sm-row" style={{ gap: 6 }}>
                  <input className="b2b-input" type="number" placeholder="가로" value={nW} onChange={(e) => setNW(e.target.value)} style={{ width: 0, flex: 1 }} />
                  <input className="b2b-input" type="number" placeholder="세로" value={nD} onChange={(e) => setND(e.target.value)} style={{ width: 0, flex: 1 }} />
                  <input className="b2b-input" type="number" placeholder="높이" value={nH} onChange={(e) => setNH(e.target.value)} style={{ width: 0, flex: 1 }} />
                  <button className="b2b-btn-secondary" onClick={addType} style={{ flex: "0 0 auto" }}>추가</button>
                </div>
              </div>
            </div>
          </section>

          <section className="b2b-card">
            <div className="b2b-card-head"><span className="b2b-card-title">현황</span></div>
            <div className="sm-col" style={{ gap: 5, fontSize: 14 }}>
              <div className="sm-between"><span>박스</span><strong>{stats.total}개</strong></div>
              <div className="sm-between"><span>총 높이 (파렛트 포함)</span>
                <strong style={{ color: stats.overLimit ? "var(--sm-danger)" : undefined }}>{stats.totalH.toLocaleString()}mm</strong></div>
              <div className="sm-between"><span>1층 면적 사용률</span><strong>{stats.floorPct}%</strong></div>
              {stats.overLimit && <div className="b2b-error" style={{ marginTop: 4 }}>높이 제한({pallet.maxH.toLocaleString()}mm)을 넘었습니다.</div>}
            </div>
            {selectedBox && selectedType && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--sm-border)" }}>
                <div className="sm-between" style={{ gap: 8 }}>
                  <span style={{ fontSize: 13 }}>
                    선택: <strong>{selectedType.name}</strong>
                    <span className="sm-faint" style={{ marginLeft: 6, fontSize: 12 }}>{selectedBox.y === 0 ? "1층" : `바닥 ${selectedBox.y}mm`}</span>
                  </span>
                  <span className="sm-row" style={{ gap: 6 }}>
                    <button className="b2b-btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={rotateSelected}>회전 (R)</button>
                    <button className="b2b-btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={removeSelected}>삭제</button>
                  </span>
                </div>
              </div>
            )}
          </section>
        </div>

        {/* ── 3D 캔버스 ── */}
        <div ref={mountRef} style={{ flex: "1 1 480px", minHeight: 560, borderRadius: 12, overflow: "hidden", border: "1px solid var(--sm-border)" }} />
      </div>
    </div>
  );
}
