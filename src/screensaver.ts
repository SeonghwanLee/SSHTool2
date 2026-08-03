// 화면보호기 — 무활동 자동 잠금이 0(사용 안 함)일 때 유휴 상태에서 띄우는 애니메이션.
// 전부 canvas 에 코드로만 그린다(이미지·폰트 자산 없음 — 설치 용량에 영향 없음).
// 설정에서 고른 것(기본: 무작위)이 뜬다. 아무 입력이 오면 사라진다
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


// ── ③ 큰 시계 — 유휴 중에도 실용적. 잔상 방지로 위치가 천천히 떠다닌다 ─────────
const bigClock: SaverFactory = (canvas, ctx, accent) => {
  let t = 0;
  const reset = () => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };
  reset();
  return {
    reset,
    step() {
      t++;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const now = new Date();
      const p2 = (n: number) => String(n).padStart(2, "0");
      const time = `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
      const date = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} (${"일월화수목금토"[now.getDay()]})`;

      // OLED 번인 방지 — 리사주 궤적으로 아주 천천히 떠다닌다.
      const cx = canvas.width / 2 + Math.sin(t * 0.008) * canvas.width * 0.06;
      const cy = canvas.height / 2 + Math.sin(t * 0.011) * canvas.height * 0.06;

      ctx.textAlign = "center";
      ctx.fillStyle = accent;
      ctx.font = `bold ${Math.floor(canvas.width / 9)}px Consolas, monospace`;
      ctx.fillText(time, cx, cy);
      ctx.globalAlpha = 0.55;
      ctx.font = `${Math.floor(canvas.width / 36)}px Consolas, monospace`;
      ctx.fillText(date, cx, cy + canvas.width / 18);

      // 은은한 스캔라인 스윕 — 프레임마다 변화가 있어야 '멈춘 화면'으로 오해받지 않는다.
      const sweep = (t * 3) % (canvas.height + 120);
      const grad = ctx.createLinearGradient(0, sweep - 120, 0, sweep);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(1, "rgba(255,255,255,0.045)");
      ctx.globalAlpha = 1;
      ctx.fillStyle = grad;
      ctx.fillRect(0, sweep - 120, canvas.width, 120);
      ctx.textAlign = "left";
    },
  };
};

// ── ④ 별자리 — 떠다니는 점이 가까워지면 선으로 이어진다 ────────────────────────
const constellation: SaverFactory = (canvas, ctx, accent) => {
  interface Dot { x: number; y: number; vx: number; vy: number }
  const N = 70;
  const LINK = 150; // 이 거리 안이면 선으로 잇는다
  let dots: Dot[] = [];
  const reset = () => {
    dots = Array.from({ length: N }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.7,
      vy: (Math.random() - 0.5) * 0.7,
    }));
  };
  reset();
  return {
    reset,
    step() {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const d of dots) {
        d.x += d.vx;
        d.y += d.vy;
        if (d.x < 0 || d.x > canvas.width) d.vx = -d.vx;
        if (d.y < 0 || d.y > canvas.height) d.vy = -d.vy;
      }
      ctx.strokeStyle = accent;
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const dx = dots[i].x - dots[j].x;
          const dy = dots[i].y - dots[j].y;
          const dist = Math.hypot(dx, dy);
          if (dist > LINK) continue;
          ctx.globalAlpha = (1 - dist / LINK) * 0.5;
          ctx.beginPath();
          ctx.moveTo(dots[i].x, dots[i].y);
          ctx.lineTo(dots[j].x, dots[j].y);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = accent;
      for (const d of dots) ctx.fillRect(d.x - 1.5, d.y - 1.5, 3, 3);
      ctx.globalAlpha = 1;
    },
  };
};

// ── ⑤ 도트 불꽃 — 고전 doom fire. 팔레트는 검정→테마색→흰색 ─────────────────────
const doomFire: SaverFactory = (canvas, ctx, accent) => {
  const CELL = 6; // 픽셀 크기 — 작을수록 곱지만 불길이 상대적으로 낮아진다(스크린샷 튜닝)
  const LEVELS = 24;
  let w = 0;
  let h = 0;
  let heat = new Uint8Array(0);
  let img: ImageData | null = null;
  let off: HTMLCanvasElement | null = null;

  // 검정 → 테마색 → 흰색 보간 팔레트.
  const hex = (c: string) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
    const n = parseInt(m ? m[1] : "a7c080", 16);
    return [n >> 16, (n >> 8) & 255, n & 255] as const;
  };
  const [ar, ag, ab] = hex(accent);
  const palette = Array.from({ length: LEVELS }, (_, i) => {
    const t = i / (LEVELS - 1);
    if (t < 0.78) {
      const k = t / 0.78; // 검정 → 테마색 — 흰 구간을 줄여 '불' 답게(첫 튜닝에서 희멀겋었다)
      return [ar * k, ag * k, ab * k] as const;
    }
    const k = (t - 0.78) / 0.22; // 테마색 → 흰색(심지 부분만)
    return [ar + (255 - ar) * k, ag + (255 - ag) * k, ab + (255 - ab) * k] as const;
  });

  const reset = () => {
    w = Math.max(8, Math.ceil(canvas.width / CELL));
    h = Math.max(8, Math.ceil(canvas.height / CELL));
    heat = new Uint8Array(w * h);
    heat.fill(LEVELS - 1, w * (h - 1)); // 맨 아랫줄이 불씨
    img = new ImageData(w, h);
    off = document.createElement("canvas");
    off.width = w;
    off.height = h;
  };
  reset();
  return {
    reset,
    step() {
      if (!img || !off) return;
      // 위로 번지며 무작위로 식는다 — 고전 알고리즘 그대로.
      for (let y = 0; y < h - 1; y++) {
        for (let x = 0; x < w; x++) {
          const src = (y + 1) * w + x;
          const drift = (Math.random() * 3) | 0; // 0~2 — 좌우 흔들림
          const dst = y * w + Math.min(w - 1, Math.max(0, x + drift - 1));
          const cool = Math.random() < 0.34 ? 1 : 0; // 낮출수록 불길이 높이 오른다
          heat[dst] = Math.max(0, heat[src] - cool);
        }
      }
      const d = img.data;
      for (let i = 0; i < w * h; i++) {
        const [r, g, b] = palette[heat[i]];
        d[i * 4] = r;
        d[i * 4 + 1] = g;
        d[i * 4 + 2] = b;
        d[i * 4 + 3] = 255;
      }
      off.getContext("2d")!.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
    },
  };
};

// ── ⑥ 셸 데모 — 화면이 스스로 명령을 치고 출력을 흘린다 ────────────────────────
const shellDemo: SaverFactory = (canvas, ctx, accent) => {
  const FONT = 15;
  const LINE = 22;
  // 가짜 세션 대본 — [명령, 출력들]. 실제 값처럼 보이되 아무 정보도 아니다.
  const SCRIPT: [string, string[]][] = [
    ["uptime", [" 14:32:07 up 213 days,  4:11,  1 user,  load average: 0.08, 0.12, 0.09"]],
    ["df -h /", ["Filesystem      Size  Used Avail Use% Mounted on", "/dev/sda1       200G   84G  117G  42% /"]],
    ["tail -n3 /var/log/app.log", [
      "[INFO] worker-2 heartbeat ok (12ms)",
      "[INFO] queue drained: 1,284 jobs",
      "[INFO] snapshot saved: 2.1GB in 8.4s",
    ]],
    ["ping -c 3 gateway", [
      "64 bytes from gateway: icmp_seq=1 ttl=64 time=0.42 ms",
      "64 bytes from gateway: icmp_seq=2 ttl=64 time=0.39 ms",
      "64 bytes from gateway: icmp_seq=3 ttl=64 time=0.41 ms",
    ]],
    ["free -h", ["              total   used   free", "Mem:            31G    11G    18G"]],
  ];
  const PROMPT = "admin@prod-web-01:~$ ";
  let lines: string[] = [];
  let si = 0; // 대본 위치
  let typed = 0; // 현재 명령에서 친 글자 수
  let outAt = 0; // 출력 몇 줄째
  let pause = 0; // 명령 사이 숨 고르기(프레임)
  const reset = () => {
    lines = [];
    si = Math.floor(Math.random() * SCRIPT.length);
    typed = 0;
    outAt = 0;
    pause = 0;
  };
  reset();
  return {
    reset,
    step() {
      const [cmd, out] = SCRIPT[si % SCRIPT.length];
      if (pause > 0) {
        pause--;
      } else if (typed < cmd.length) {
        typed += Math.random() < 0.3 ? 2 : 1; // 사람 타이핑처럼 들쭉날쭉
      } else if (outAt < out.length) {
        lines.push(PROMPT + cmd);
        // 출력은 즉시 여러 줄 — 명령 완료 순간의 화면 반응처럼
        while (outAt < out.length) lines.push(out[outAt++]);
        lines.push("");
        typed = 0;
        pause = 28; // ~1.5초 쉬고 다음 명령
        si++;
        outAt = 0;
      }
      const rows = Math.floor(canvas.height / LINE) - 2;
      if (lines.length > rows) lines = lines.slice(lines.length - rows);

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${FONT}px Consolas, monospace`;
      const x0 = 24;
      let y = 34;
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.85;
      for (const l of lines) {
        ctx.fillText(l, x0, y);
        y += LINE;
      }
      // 지금 치는 중인 줄 + 깜박이는 블록 커서
      const cur = PROMPT + cmd.slice(0, typed);
      ctx.globalAlpha = 1;
      ctx.fillText(cur, x0, y);
      if (Math.floor(Date.now() / 500) % 2 === 0) {
        const cw = ctx.measureText(cur).width;
        ctx.fillRect(x0 + cw + 2, y - FONT + 2, FONT * 0.55, FONT);
      }
    },
  };
};

/** 이름 → 팩토리. 테스트가 특정 것을 강제할 수 있도록 이름을 공개한다. */
export const SAVER_NAMES = ["matrix", "starfield", "clock", "constellation", "fire", "shell"] as const;
export type SaverName = (typeof SAVER_NAMES)[number];
const FACTORIES: Record<SaverName, SaverFactory> = {
  matrix: matrixRain,
  starfield,
  clock: bigClock,
  constellation,
  fire: doomFire,
  shell: shellDemo,
};

let overlay: HTMLDivElement | null = null;
let raf = 0;
let onResize: (() => void) | null = null;
/** 표시된 시각 — 직후의 마우스 흔들림에 곧장 닫히지 않게 짧은 유예를 둔다(미리보기용). */
let shownAt = 0;

export function isScreensaverOn(): boolean {
  return overlay !== null;
}

/** 화면보호기를 띄운다. name 을 주면 그것으로(테스트용), 없으면 무작위. */
export function showScreensaver(name?: SaverName): void {
  if (overlay) return;
  shownAt = Date.now();
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
  // 미리보기 버튼을 누른 그 클릭·직후의 미세한 마우스 이동이 전역 활동 감지를 타고
  // 곧장 닫아버린다 — 뜨자마자 사라지면 미리보기가 성립하지 않는다. 잠깐만 무시한다.
  if (Date.now() - shownAt < 400) return;
  cancelAnimationFrame(raf);
  if (onResize) window.removeEventListener("resize", onResize);
  onResize = null;
  overlay.remove();
  overlay = null;
}
