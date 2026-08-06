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


// ── ③ 플립 시계 — 시/분/초 동일 카드 3장 + 하단 년월일(0.61.0, 시안 A 컨펌) ──────
// 고정 배치(사용자 지시 — 떠다니지 않는다). 값이 바뀌는 순간 카드 상단이 접혀
// 내려오는 스플릿플랩 연출. 초 카드가 매초 접히므로 '멈춘 화면' 오해도 없다.
const flipClock: SaverFactory = (canvas, ctx, accent) => {
  void accent; // 컨펌된 시안이 무채색 — 테마와 무관하게 카드 배색을 유지한다
  const DUR = 280; // 플립 한 번(ms)
  const cur = ["", "", ""]; // 카드별 표시 중 값(시·분·초)
  const flips: ({ from: string; start: number } | null)[] = [null, null, null];
  const reset = () => {
    cur[0] = cur[1] = cur[2] = "";
    flips[0] = flips[1] = flips[2] = null;
  };
  reset();

  /** 카드 한 장(배경·숫자)을 통째로 그린다 — 절반만 필요할 때는 clip 으로 자른다. */
  const face = (cx: number, cy: number, w: number, h: number, text: string): void => {
    const r = Math.min(18, w * 0.08);
    const g = ctx.createLinearGradient(0, cy - h / 2, 0, cy + h / 2);
    g.addColorStop(0, "#232326");
    g.addColorStop(0.5, "#1b1b1e");
    g.addColorStop(0.5, "#151517");
    g.addColorStop(1, "#1a1a1c");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, cy - h / 2, w, h, r);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(cx - w / 2 + 0.5, cy - h / 2 + 0.5, w - 1, h - 1, r);
    ctx.stroke();
    ctx.fillStyle = "#ececea";
    ctx.font = `600 ${Math.floor(w * 0.7)}px "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cx, cy + w * 0.014);
  };

  /** 카드의 위/아래 절반만 그린다(스케일 인자 포함 — 힌지 기준 접힘). */
  const half = (
    cx: number,
    cy: number,
    w: number,
    h: number,
    text: string,
    which: "top" | "bottom",
    scale: number,
    shade: number,
  ): void => {
    if (scale <= 0.01) return;
    ctx.save();
    ctx.translate(0, cy);
    ctx.scale(1, scale);
    ctx.translate(0, -cy);
    ctx.beginPath();
    ctx.rect(cx - w / 2, which === "top" ? cy - h / 2 : cy, w, h / 2);
    ctx.clip();
    face(cx, cy, w, h, text);
    if (shade > 0) {
      ctx.fillStyle = `rgba(0,0,0,${shade})`;
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    }
    ctx.restore();
  };

  return {
    reset,
    step() {
      const W = canvas.width;
      const H = canvas.height;
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, W, H);

      const now = new Date();
      const p2 = (n: number) => String(n).padStart(2, "0");
      const want = [p2(now.getHours()), p2(now.getMinutes()), p2(now.getSeconds())];
      const ms = performance.now();
      for (let i = 0; i < 3; i++) {
        if (cur[i] === "") cur[i] = want[i]; // 첫 프레임은 연출 없이 바로
        else if (cur[i] !== want[i] && !flips[i]) {
          flips[i] = { from: cur[i], start: ms };
          cur[i] = want[i];
        }
      }

      // 카드 크기 — 화면에 비례하되 3장 + 여백이 항상 들어가게.
      const ch = Math.min(H * 0.42, W * 0.26);
      const cw = ch * 0.79;
      const gap = cw * 0.16;
      const cy = H * 0.46;
      const xs = [W / 2 - cw - gap, W / 2, W / 2 + cw + gap];

      for (let i = 0; i < 3; i++) {
        const cx = xs[i];
        const f = flips[i];
        if (!f) {
          face(cx, cy, cw, ch, cur[i]);
        } else {
          const t = (ms - f.start) / DUR;
          if (t >= 1) {
            flips[i] = null;
            face(cx, cy, cw, ch, cur[i]);
          } else {
            // 바닥: 위 절반은 새 값, 아래 절반은 옛 값(덮개가 걷히기 전까지).
            half(cx, cy, cw, ch, cur[i], "top", 1, 0);
            half(cx, cy, cw, ch, f.from, "bottom", 1, 0);
            if (t < 0.5) {
              // 1단계: 옛 값 상단이 힌지로 접혀 내려온다(어두워지며).
              const sc = Math.cos(t * Math.PI);
              half(cx, cy, cw, ch, f.from, "top", sc, 0.35 * (1 - sc));
            } else {
              // 2단계: 새 값 하단 덮개가 펼쳐진다(밝아지며).
              const sc = -Math.cos(t * Math.PI);
              half(cx, cy, cw, ch, cur[i], "bottom", sc, 0.3 * (1 - sc));
            }
          }
        }
        // 힌지(접힘선)와 좌우 축 — 연출 위에 그려 항상 카드를 가로지른다.
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(cx - cw / 2, cy - 2, cw, 4);
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(cx - cw / 2, cy + 2, cw, 1);
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(cx - cw / 2 - 3, cy - 9, 8, 18);
        ctx.fillRect(cx + cw / 2 - 5, cy - 9, 8, 18);
      }

      // 하단 년월일
      const date = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 ${"일월화수목금토"[now.getDay()]}요일`;
      ctx.fillStyle = "#9a9a94";
      ctx.font = `300 ${Math.floor(ch * 0.105)}px "Segoe UI", "Malgun Gothic", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(date, W / 2, cy + ch / 2 + ch * 0.23);
      ctx.textAlign = "left";
    },
  };
};

// ── ③-b 춤추는 다각형(Mystify) — 꼭짓점이 튕기며 도형 잔상이 따라온다(0.61.0) ────
const mystify: SaverFactory = (canvas, ctx, accent) => {
  interface Pt { x: number; y: number; vx: number; vy: number }
  interface Shape { pts: Pt[]; hist: { x: number; y: number }[][]; hue: number }
  const VERTS = 4;
  const TRAIL = 14; // 잔상 겹 수
  // 액센트 HEX → 기준 색상(hue). 두 번째 도형은 보색(+180°).
  const baseHue = (() => {
    const m = /^#?([0-9a-f]{6})$/i.exec(accent.trim());
    const n = parseInt(m ? m[1] : "a7c080", 16);
    const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx === mn) return 90;
    const d = mx - mn;
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return h * 60;
  })();
  let shapes: Shape[] = [];
  const mkPt = (): Pt => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    vx: (Math.random() < 0.5 ? -1 : 1) * (2.2 + Math.random() * 1.8),
    vy: (Math.random() < 0.5 ? -1 : 1) * (2.2 + Math.random() * 1.8),
  });
  const reset = () => {
    shapes = [0, 1].map((i) => ({
      pts: Array.from({ length: VERTS }, mkPt),
      hist: [],
      hue: baseHue + i * 180,
    }));
  };
  reset();
  let t = 0;
  return {
    reset,
    step() {
      t++;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 1.5;
      for (const s of shapes) {
        for (const p of s.pts) {
          p.x += p.vx;
          p.y += p.vy;
          if (p.x < 0 || p.x > canvas.width) { p.vx = -p.vx; p.x = Math.max(0, Math.min(canvas.width, p.x)); }
          if (p.y < 0 || p.y > canvas.height) { p.vy = -p.vy; p.y = Math.max(0, Math.min(canvas.height, p.y)); }
        }
        s.hist.push(s.pts.map((p) => ({ x: p.x, y: p.y })));
        if (s.hist.length > TRAIL) s.hist.shift();
        // 원작처럼 색이 천천히 순환한다. 잔상은 옛것일수록 옅게.
        const hue = (s.hue + t * 0.4) % 360;
        s.hist.forEach((poly, k) => {
          const a = 0.12 + 0.88 * (k / (s.hist.length - 1 || 1));
          ctx.strokeStyle = `hsla(${hue}, 70%, 62%, ${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(poly[0].x, poly[0].y);
          for (let v = 1; v < poly.length; v++) ctx.lineTo(poly[v].x, poly[v].y);
          ctx.closePath();
          ctx.stroke();
        });
      }
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

// ── ⑤ 셸 데모 — 화면이 스스로 명령을 치고 출력을 흘린다 ────────────────────────
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
    ["ps aux --sort=-%cpu | head -4", [
      "USER  PID %CPU %MEM COMMAND",
      "app  2114  3.2  1.8 java -jar collector.jar",
      "app  1873  1.1  0.6 node dist/server.js",
      "root  912  0.4  0.2 /usr/sbin/rsyslogd",
    ]],
    ["systemctl status nginx --no-pager | head -3", [
      "● nginx.service - A high performance web server",
      "     Loaded: loaded (/usr/lib/systemd/system/nginx.service; enabled)",
      "     Active: active (running) since Mon; 213 days ago",
    ]],
    ["docker ps --format 'table {{.Names}}\\t{{.Status}}'", [
      "NAMES          STATUS",
      "api-gateway    Up 6 weeks (healthy)",
      "redis-cache    Up 6 weeks",
      "batch-worker   Up 3 days",
    ]],
    ["git pull", ["Already up to date."]],
    ["ss -tlnp | head -4", [
      "State   Recv-Q  Send-Q  Local Address:Port",
      "LISTEN  0       511     0.0.0.0:443",
      "LISTEN  0       511     0.0.0.0:80",
      "LISTEN  0       128     127.0.0.1:5432",
    ]],
    ["curl -s -o /dev/null -w '%{http_code}\\n' http://localhost:8080/health", ["200"]],
    ["du -sh /var/lib/backup", ["48G     /var/lib/backup"]],
    ["last -3", [
      "admin  pts/0   10.20.0.5   Mon 09:12   still logged in",
      "admin  pts/1   10.20.0.5   Fri 18:44 - 19:02  (00:17)",
      "deploy pts/0   10.20.0.9   Fri 03:00 - 03:01  (00:01)",
    ]],
    ["uname -srmo", ["Linux 5.14.0-687.el9.x86_64 x86_64 GNU/Linux"]],
    ["vmstat 1 2 | tail -1", [" 1  0  0  18342112  84120  9214480  0  0  3  41  212  388  2  1 97  0"]],
    ["sha256sum backup-latest.tar.gz", ["4f8b2ce19e...c41a7d  backup-latest.tar.gz"]],
    ["journalctl -u app --since -5m -n2 --no-pager", [
      "Aug 05 14:29:11 prod-web-01 app[2114]: request burst absorbed (p99 84ms)",
      "Aug 05 14:31:56 prod-web-01 app[2114]: cache hit ratio 96.4%",
    ]],
  ];
  const PROMPT = "admin@prod-web-01:~$ ";
  let lines: string[] = [];
  let order: number[] = []; // 대본 재생 순서 — 매번 섞는다(고정 순서는 금방 외워진다)
  let si = 0; // 대본 위치
  let typed = 0; // 현재 명령에서 친 글자 수
  let outAt = 0; // 출력 몇 줄째
  let pause = 0; // 명령 사이 숨 고르기(프레임)
  const reset = () => {
    lines = [];
    order = SCRIPT.map((_, i) => i).sort(() => Math.random() - 0.5);
    si = 0;
    typed = 0;
    outAt = 0;
    pause = 0;
  };
  reset();
  return {
    reset,
    step() {
      const [cmd, out] = SCRIPT[order[si % order.length]];
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
export const SAVER_NAMES = ["matrix", "starfield", "clock", "mystify", "constellation", "shell"] as const;
export type SaverName = (typeof SAVER_NAMES)[number];
const FACTORIES: Record<SaverName, SaverFactory> = {
  matrix: matrixRain,
  starfield,
  clock: flipClock,
  mystify,
  constellation,
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
