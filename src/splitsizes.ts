// 분할 칸 크기 계산(0.92.0) — 칸 사이 경계선을 끌어 줄·칸 폭을 조절한다.
//
// 분할은 CSS 격자다. 격자라서 세로 경계선 하나를 끌면 **그 열 전체**가 함께 움직인다
// (SFTP 창의 로컬/리모트 경계선과 같은 방식). 칸 하나만 따로 키우려면 격자를 버리고
// 중첩 구조로 다시 짜야 하는데, 분할 만들기·순서·저장·재계측이 모두 격자에 얹혀
// 있어 그쪽은 건드리지 않았다(사용자와 A안으로 합의).
//
// 여기 있는 것은 전부 순수 함수다 — 화면 없이 시험할 수 있게 DOM 을 만지지 않는다.

/** 한 격자의 줄·칸 비중. 값은 상대 비중이라 합이 얼마든 상관없다. */
export interface SplitSizes {
  cols: number[];
  rows: number[];
}

/** 경계선 두께(px). 이 폭이 곧 칸 사이 간격이자 끌 수 있는 영역이다. */
export const GUTTER_PX = 6;

/** 칸이 이보다 좁아지지는 않는다 — 끌다가 칸이 사라져 버리는 것을 막는다. */
export const MIN_PANE_PX = 80;

/**
 * 저장·조회에 쓰는 격자 모양 이름.
 *
 * 크기를 분할 그룹이 아니라 **격자 모양**에 매어 둔다. 그룹에 매면 그때그때 만든
 * 분할(저장하지 않은 것)은 크기를 잃고, 같은 2×3 을 다시 만들 때마다 처음부터
 * 맞춰야 한다. 모양에 매어 두면 같은 배치로 돌아올 때 늘 그대로다.
 */
export const shapeKey = (mode: string, cols: number, rows: number): string =>
  `${mode}-${cols}x${rows}`;

/** 균등 분할 — 모든 칸이 같은 비중. */
export const evenSizes = (cols: number, rows: number): SplitSizes => ({
  cols: Array<number>(Math.max(1, cols)).fill(1),
  rows: Array<number>(Math.max(1, rows)).fill(1),
});

/** 비중이 모두 같은지(= 손대지 않은 균등 상태인지). */
export const isEven = (w: readonly number[]): boolean =>
  w.length === 0 || w.every((x) => Math.abs(x - w[0]) < 1e-6);

/**
 * 저장된 크기를 지금 격자에 맞춰 손질한다.
 *
 * 저장해 둔 뒤 칸 수가 달라졌거나(세션을 더 올림), 파일이 손상돼 이상한 값이 들어
 * 있을 수 있다. 그대로 쓰면 격자가 무너지므로 개수·값이 성하지 않으면 균등으로 돌린다.
 */
export function normalize(
  saved: Partial<SplitSizes> | undefined,
  cols: number,
  rows: number,
): SplitSizes {
  const fix = (w: unknown, n: number): number[] => {
    const ok =
      Array.isArray(w) &&
      w.length === n &&
      w.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0);
    return ok ? (w as number[]).slice() : Array<number>(n).fill(1);
  };
  return { cols: fix(saved?.cols, Math.max(1, cols)), rows: fix(saved?.rows, Math.max(1, rows)) };
}

/**
 * 비중을 격자 track 목록으로 바꾼다 — 칸 사이마다 경계선 track 을 끼운다.
 * 예: [1, 2] → "1fr 6px 2fr"
 */
export function template(weights: readonly number[], gutter = GUTTER_PX): string {
  if (weights.length === 0) return "";
  return weights.map((w) => `${w}fr`).join(` ${gutter}px `);
}

/**
 * 경계선을 끌었을 때 양옆 두 칸의 비중을 다시 나눈다.
 *
 * 두 칸의 **비중 합은 그대로** 두고 그 안에서만 나눈다 — 나머지 칸은 건드리지 않아,
 * 하나를 조절하다 반대편 끝 칸이 따라 움직이는 일이 없다.
 *
 * @param weights 지금 비중
 * @param i       i 번째와 i+1 번째 사이의 경계선
 * @param px      지금 각 칸의 실제 픽셀 크기(비중이 아니라 화면에서 잰 값)
 * @param deltaPx 경계선을 끈 거리(오른쪽/아래가 +)
 */
export function dragWeights(
  weights: readonly number[],
  i: number,
  px: readonly number[],
  deltaPx: number,
  minPx = MIN_PANE_PX,
): number[] {
  const next = weights.slice();
  if (i < 0 || i + 1 >= weights.length || px.length !== weights.length) return next;
  const total = px[i] + px[i + 1];
  // 둘을 합쳐도 최소 폭 둘을 못 담는 경우 — 어떻게 나눠도 규칙을 못 지키니 그대로 둔다.
  if (!Number.isFinite(total) || total < minPx * 2) return next;
  const a = Math.min(Math.max(px[i] + deltaPx, minPx), total - minPx);
  const sum = weights[i] + weights[i + 1];
  next[i] = (sum * a) / total;
  next[i + 1] = (sum * (total - a)) / total;
  return next;
}
