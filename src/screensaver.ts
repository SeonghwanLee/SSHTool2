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


// ── ③ 큰 시계 — 얇은 활자 + 분 진행선 + 숨 쉬는 광원(0.60.0 재디자인) ──────────
// 유휴 중에도 실용적. 잔상 방지로 위치가 천천히 떠다닌다. 광원과 진행선이
// 프레임마다 미세하게 변해 '멈춘 화면'으로 오해받지 않는다(스캔라인의 후임).
const bigClock: SaverFactory = (canvas, ctx, accent) => {
  let t = 0;
  // 액센트 HEX → rgba(알파 지정) — 광원·진행선에 쓴다.
  const hexA = (c: string, a: number): string => {
    const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
    const n = parseInt(m ? m[1] : "a7c080", 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  };
  const reset = () => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };
  reset();
  return {
    reset,
    step() {
      t++;
      const W = canvas.width;
      const H = canvas.height;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);

      const now = new Date();
      const p2 = (n: number) => String(n).padStart(2, "0");
      const date = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 ${"일월화수목금토"[now.getDay()]}요일`;
      // 분 진행률 — 초·밀리초까지 반영해 진행선이 끊김 없이 흐른다.
      const minFrac = (now.getSeconds() * 1000 + now.getMilliseconds()) / 60_000;

      // OLED 번인 방지 — 리사주 궤적으로 아주 천천히 떠다닌다.
      const cx = W / 2 + Math.sin(t * 0.008) * W * 0.05;
      const cy = H / 2 + Math.sin(t * 0.011) * H * 0.05;

      // 숨 쉬는 배경 광원 — 시계 뒤에서 액센트색이 아주 옅게 맥동한다.
      const breathe = 0.09 + 0.03 * Math.sin(t * 0.02);
      const R = Math.min(W, H) * 0.6;
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      glow.addColorStop(0, hexA(accent, breathe));
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

      // 시:분 — 얇은 활자(Segoe UI Light 급). 콜론만 초 리듬으로 부드럽게 숨 쉰다.
      const big = Math.floor(Math.min(W / 6, H / 2.8));
      const thin = `200 ${big}px "Segoe UI", "Malgun Gothic", sans-serif`;
      ctx.font = thin;
      ctx.textAlign = "center";
      const halfColon = ctx.measureText(":").width / 2;
      const digitW = ctx.measureText("00").width;
      ctx.fillStyle = "#e9e9e4";
      ctx.shadowColor = accent;
      ctx.shadowBlur = big * 0.07;
      ctx.fillText(p2(now.getHours()), cx - halfColon - digitW / 2 - big * 0.06, cy);
      ctx.fillText(p2(now.getMinutes()), cx + halfColon + digitW / 2 + big * 0.06, cy);
      const colonPulse = 0.25 + 0.75 * Math.abs(Math.sin((now.getMilliseconds() / 1000) * Math.PI));
      ctx.globalAlpha = colonPulse;
      ctx.fillText(":", cx, cy - big * 0.06);
      ctx.globalAlpha = 1;
      // 초 — 분 오른쪽 위에 작게(위첨자 느낌).
      ctx.font = `200 ${Math.floor(big * 0.26)}px "Segoe UI", "Malgun Gothic", sans-serif`;
      ctx.textAlign = "left";
      ctx.globalAlpha = 0.75;
      ctx.fillText(p2(now.getSeconds()), cx + halfColon + digitW + big * 0.15, cy - big * 0.62);
      ctx.shadowBlur = 0;

      // 분 진행선 — 1분에 걸쳐 왼→오. 트랙은 희미하게, 진행분은 액센트, 끝에 점.
      const lineW = (halfColon + digitW + big * 0.06) * 2 * 0.94;
      const ly = cy + big * 0.28;
      const lx = cx - lineW / 2;
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(2, big * 0.018);
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(lx + lineW, ly);
      ctx.stroke();
      ctx.strokeStyle = hexA(accent, 0.85);
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(lx + lineW * Math.max(0.001, minFrac), ly);
      ctx.stroke();
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(lx + lineW * minFrac, ly, Math.max(3, big * 0.024), 0, Math.PI * 2);
      ctx.fill();

      // 날짜 — 한 줄, 차분하게.
      ctx.font = `300 ${Math.floor(big * 0.155)}px "Segoe UI", "Malgun Gothic", sans-serif`;
      ctx.textAlign = "center";
      ctx.fillStyle = "#e9e9e4";
      ctx.globalAlpha = 0.5;
      ctx.fillText(date, cx, ly + big * 0.34);
      ctx.globalAlpha = 1;
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
export const SAVER_NAMES = ["matrix", "starfield", "clock", "constellation", "shell"] as const;
export type SaverName = (typeof SAVER_NAMES)[number];
const FACTORIES: Record<SaverName, SaverFactory> = {
  matrix: matrixRain,
  starfield,
  clock: bigClock,
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
