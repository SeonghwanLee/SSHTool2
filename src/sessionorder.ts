// 세션 정렬·드롭 배치 — 순수 함수(상태 없음). main.ts 에서 분리(0.63.0).

import type { SessionInfo } from "./types";
import type { DropTarget } from "./sidebar";

/**
 * 같은 폴더 형제들 사이에서 위/아래로 한 칸 이동.
 * sortOrder 가 모두 같아(초기값 0) 순서가 이름순인 경우도 있으므로,
 * 현재 표시 순서대로 0..n-1 을 다시 매긴 뒤 이웃과 교환한다.
 */
export function reorderSession(all: SessionInfo[], target: SessionInfo, dir: -1 | 1): SessionInfo[] {
  const siblings = all
    .filter((s) => s.folder === target.folder)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ko"));

  const idx = siblings.findIndex((s) => s.id === target.id);
  const swapWith = idx + dir;
  if (idx < 0 || swapWith < 0 || swapWith >= siblings.length) return all;

  const order = new Map<string, number>();
  siblings.forEach((s, i) => order.set(s.id, i));
  order.set(siblings[idx].id, swapWith);
  order.set(siblings[swapWith].id, idx);

  return all.map((s) => (order.has(s.id) ? { ...s, sortOrder: order.get(s.id)! } : s));
}

/**
 * 드래그로 옮긴 결과를 세션 목록에 반영한다.
 * - 폴더에 드롭: 그 폴더로 이동(순서는 맨 뒤)
 * - 세션 위/아래에 드롭: 대상과 같은 폴더로 옮기고 그 앞/뒤에 끼운다
 */
export function applyDrop(all: SessionInfo[], sourceId: string, target: DropTarget): SessionInfo[] {
  const source = all.find((s) => s.id === sourceId);
  if (!source) return all;

  if (target.kind === "folder") {
    if (source.folder === target.path) return all;
    // 대상 폴더 형제들을 0..n-1 로 다시 매기고 source 를 맨 뒤에 붙인다
    // (그냥 folder 만 바꾸면 sortOrder 가 전부 0 으로 겹쳐 순서가 뒤죽박죽이 된다).
    const siblings = all
      .filter((s) => s.folder === target.path && s.id !== sourceId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ko"));
    const order = new Map(siblings.map((s, i) => [s.id, i]));
    order.set(sourceId, siblings.length);
    return all.map((s) =>
      order.has(s.id)
        ? { ...s, folder: target.path, sortOrder: order.get(s.id)! }
        : s,
    );
  }

  const dest = all.find((s) => s.id === target.id);
  if (!dest || dest.id === sourceId) return all;

  // 대상 폴더의 형제들을 현재 표시 순서대로 모아 source 를 원하는 자리에 끼운다.
  const siblings = all
    .filter((s) => s.folder === dest.folder && s.id !== sourceId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ko"));

  const at = siblings.findIndex((s) => s.id === dest.id);
  const insertAt = target.before ? at : at + 1;
  const ordered = [...siblings.slice(0, insertAt), source, ...siblings.slice(insertAt)];

  const order = new Map(ordered.map((s, i) => [s.id, i]));
  return all.map((s) =>
    order.has(s.id) ? { ...s, folder: dest.folder, sortOrder: order.get(s.id)! } : s,
  );
}

