// 화면보호기 — 무활동 자동 잠금이 0(사용 안 함)일 때 유휴 상태에서 띄우는 애니메이션.
// MobaXterm 의 움직이는 캐릭터처럼, 여기서는 테마색 matrix rain 을 canvas 로 그린다.
// 아무 입력이 오면 사라진다(입력 감지는 main.ts 가 담당).

let overlay: HTMLDivElement | null = null;
let raf = 0;
let onResize: (() => void) | null = null;

export function isScreensaverOn(): boolean {
  return overlay !== null;
}

export function showScreensaver(): void {
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

  const fontSize = 16;
  let cols = 0;
  let drops: number[] = [];
  const resize = () => {
    canvas.width = overlay!.clientWidth;
    canvas.height = overlay!.clientHeight;
    cols = Math.max(1, Math.floor(canvas.width / fontSize));
    drops = new Array(cols).fill(0).map(() => Math.floor(Math.random() * -60));
  };
  resize();
  onResize = resize;
  window.addEventListener("resize", resize);

  const chars = "アイウエオカキクケコｱｲｳｴｵ0123456789ABCDEF가나다라마바사아자차카타파하".split("");
  const accent =
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#3fb950";

  let last = 0;
  const draw = (ts: number) => {
    raf = requestAnimationFrame(draw);
    if (ts - last < 55) return; // ~18fps 로 낮춰 CPU 부담 최소화
    last = ts;
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
