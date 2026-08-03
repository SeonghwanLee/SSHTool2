// 화면보호기 — 무활동 자동 잠금이 0(사용 안 함)일 때 유휴 상태에서 띄우는 애니메이션.
// 전부 canvas 에 코드로만 그린다(이미지·폰트 자산 없음 — 설치 용량에 영향 없음).
// 켜질 때마다 아래 4종 중 하나를 무작위로 고른다. 아무 입력이 오면 사라진다
// (입력 감지는 main.ts 가 담당).
//
// 공통 규칙: ~18fps 로 제한해 CPU 를 아끼고, 테마의 --accent 색을 써서 어떤 테마에서도
// 앱과 한 몸으로 보이게 한다.

interface Saver {
  /** 매 프레임 그리기. */
  step(): void;
  /** 크기가 바뀌면 상태를 다시 깐다. */
  reset(): void;
}

type SaverFactory = (
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  accent: string,
) => Saver;

/** 프레임 간격(ms) — 화면보호기가 CPU 를 먹으면 본말전도다. */
const FRAME_MS = 55;

// ── ① 매트릭스 레인(기존) ────────────────────────────────────────────────────
const matrixRain: SaverFactory = (canvas, ctx, accent) => {
  const fontSize = 16;
  const chars = "アイウエオカキクケコｱｲｳｴｵ0123456789ABCDEF가나다라마바사아자차카타파하".split("");
  let cols = 0;
  let drops: number[] = [];
  const reset = () => {
    cols = Math.max(1, Math.floor(canvas.width / fontSize));
    drops = new Array(cols).fill(0).map(() => Math.floor(Math.random() * -60));
  };
  reset();
  return {
    reset,
    step() {
      ctx.fillStyle = "rgba(0, 0, 0, 0.09)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${fontSize}px monospace`;
      ctx.fillStyle = accent;
      for (let i = 0; i < cols; i++) {
        const ch = chars[Math.floor(Math.random() * chars.length)];
        ctx.fillText(ch, i * fontSize, drops[i] * fontSize);
        if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
    },
  };
};

// ── ② 별하늘 비행 — 중심에서 바깥으로 날아가는 별 ───────────────────────────
const starfield: SaverFactory = (canvas, ctx, accent) => {
  interface Star {
    x: number;
    y: number;
    z: number;
  }
  const N = 240;
  let stars: Star[] = [];
  const spawn = (): Star => ({
    x: (Math.random() - 0.5) * canvas.width,
    y: (Math.random() - 0.5) * canvas.height,
    z: Math.random() * 0.9 + 0.05, // 0 에 가까울수록 멀다
  });
  const reset = () => {
    stars = Array.from({ length: N }, spawn);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };
  reset();
  return {
    reset,
    step() {
      ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      ctx.fillStyle = accent;
      for (const s of stars) {
        s.z += 0.012; // 다가온다
        const px = cx + s.x / (1.1 - s.z);
        const py = cy + s.y / (1.1 - s.z);
        // 화면을 벗어났으면 먼 곳에서 다시 태어난다.
        if (s.z >= 1 || px < 0 || px > canvas.width || py < 0 || py > canvas.height) {
          Object.assign(s, spawn(), { z: 0.05 });
          continue;
        }
        // 첫 스크린샷에서 별이 거의 안 보였다 — 크기·밝기를 한 단 올린다.
        const size = Math.max(1.2, s.z * 4.5);
        ctx.globalAlpha = Math.min(1, s.z + 0.55);
        ctx.fillRect(px, py, size, size);
      }
      ctx.globalAlpha = 1;
    },
  };
};

// ── ③ 생명 게임 — 터미널 셀 위의 콘웨이 라이프 ──────────────────────────────
const gameOfLife: SaverFactory = (canvas, ctx, accent) => {
  const cell = 12;
  let w = 0;
  let h = 0;
  let grid = new Uint8Array(0);
  let idle = 0; // 변화 없는 세대 수 — 정체되면 새로 심는다
  const reset = () => {
    w = Math.max(8, Math.floor(canvas.width / cell));
    h = Math.max(8, Math.floor(canvas.height / cell));
    grid = new Uint8Array(w * h).map(() => (Math.random() < 0.22 ? 1 : 0));
    idle = 0;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };
  reset();
  return {
    reset,
    step() {
      const next = new Uint8Array(w * h);
      let changed = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let n = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              n += grid[((y + dy + h) % h) * w + ((x + dx + w) % w)];
            }
          const i = y * w + x;
          next[i] = grid[i] ? (n === 2 || n === 3 ? 1 : 0) : n === 3 ? 1 : 0;
          if (next[i] !== grid[i]) changed++;
        }
      }
      grid = next;
      // 정물(변화 거의 없음)이 이어지면 다시 심는다 — 화면보호기가 멈춰 보이면 안 된다.
      idle = changed < w * h * 0.002 ? idle + 1 : 0;
      if (idle > 40) reset();

      ctx.fillStyle = "rgba(0, 0, 0, 0.9)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = accent;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (grid[y * w + x]) ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
    },
  };
};

// ── ④ 튕기는 프롬프트 — 벽에 튕기는 ">_ SSHTool2" ───────────────────────────
const bouncingLogo: SaverFactory = (canvas, ctx, accent) => {
  const text = ">_ SSHTool2";
  const font = "bold 28px Consolas, monospace";
  let x = 40;
  let y = 80;
  let vx = 2.2;
  let vy = 1.7;
  let n = 0; // 튕긴 횟수 — 색 순환용
  const colors = [accent, "#7fbbb3", "#dbbc7f", "#d699b6", "#e67e80"];
  let color = accent;
  const reset = () => {
    x = Math.random() * Math.max(1, canvas.width - 220) + 20;
    y = Math.random() * Math.max(1, canvas.height - 80) + 40;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };
  reset();
  return {
    reset,
    step() {
      ctx.fillStyle = "rgba(0, 0, 0, 0.18)"; // 잔상 꼬리
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = font;
      const w = ctx.measureText(text).width;
      const hTxt = 28;
      x += vx;
      y += vy;
      let bounced = false;
      if (x <= 0 || x + w >= canvas.width) {
        vx = -vx;
        x = Math.max(0, Math.min(x, canvas.width - w));
        bounced = true;
      }
      if (y - hTxt <= 0 || y >= canvas.height) {
        vy = -vy;
        y = Math.max(hTxt, Math.min(y, canvas.height));
        bounced = true;
      }
      if (bounced) color = colors[++n % colors.length];
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    },
  };
};

/** 이름 → 팩토리. 테스트가 특정 것을 강제할 수 있도록 이름을 공개한다. */
export const SAVER_NAMES = ["matrix", "starfield", "life", "logo"] as const;
export type SaverName = (typeof SAVER_NAMES)[number];
const FACTORIES: Record<SaverName, SaverFactory> = {
  matrix: matrixRain,
  starfield,
  life: gameOfLife,
  logo: bouncingLogo,
};

let overlay: HTMLDivElement | null = null;
let raf = 0;
let onResize: (() => void) | null = null;

export function isScreensaverOn(): boolean {
  return overlay !== null;
}

/** 화면보호기를 띄운다. name 을 주면 그것으로(테스트용), 없으면 무작위. */
export function showScreensaver(name?: SaverName): void {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "screensaver";
  const canvas = document.createElement("canvas");
  overlay.appendChild(canvas);
  const hint = document.createElement("div");
  hint.className = "screensaver-hint";
  hint.textContent = "아무 키나 누르거나 마우스를 움직이면 돌아갑니다";
  overlay.appendChild(hint);
  document.body.appendChild(overlay);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const accent =
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#3fb950";
  const pick = name ?? SAVER_NAMES[Math.floor(Math.random() * SAVER_NAMES.length)];

  const size = () => {
    canvas.width = overlay!.clientWidth;
    canvas.height = overlay!.clientHeight;
  };
  size();
  const saver = FACTORIES[pick](canvas, ctx, accent);
  onResize = () => {
    size();
    saver.reset();
  };
  window.addEventListener("resize", onResize);

  let last = 0;
  const draw = (ts: number) => {
    raf = requestAnimationFrame(draw);
    if (ts - last < FRAME_MS) return; // ~18fps — CPU 부담 최소화
    last = ts;
    saver.step();
  };
  raf = requestAnimationFrame(draw);
}

export function hideScreensaver(): void {
  if (!overlay) return;
  cancelAnimationFrame(raf);
  if (onResize) window.removeEventListener("resize", onResize);
  onResize = null;
  overlay.remove();
  overlay = null;
}
