// src/changelog.ts → site/changelog.html 생성.
//
// 앱의 버전정보 창에는 최근 5개만 남기기로 했으므로(0.65.0), 전체 이력은 홈페이지에서만
// 본다. 두 곳을 손으로 맞추면 반드시 어긋나므로 원본(changelog.ts) 하나에서 만들어 낸다.
// 릴리스 때마다 `npm run bump` 가 이 스크립트를 부른다.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(path.join(root, "src/changelog.ts"), "utf8");

/** TS 배열 리터럴에서 항목을 뽑는다(문자열 이스케이프 포함). */
function parseEntries(text) {
  const out = [];
  const re = /version:\s*"([^"]+)",\s*date:\s*"([^"]+)",\s*notes:\s*\[([\s\S]*?)\],\s*\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, version, date, notesRaw] = m;
    const notes = [];
    // 각 노트는 큰따옴표 문자열 — 이스케이프(\" \\ \n)를 살려서 JSON 으로 되돌린다.
    const sre = /"((?:[^"\\]|\\.)*)"/g;
    let s;
    while ((s = sre.exec(notesRaw)) !== null) notes.push(JSON.parse(`"${s[1]}"`));
    out.push({ version, date, notes });
  }
  return out;
}

const entries = parseEntries(src);
if (entries.length === 0) {
  console.error("changelog.ts 에서 항목을 하나도 뽑지 못했습니다 — 형식이 바뀐 것 같습니다.");
  process.exit(1);
}

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const body = entries
  .map(
    (e) => `      <article class="rel">
        <h3>v${esc(e.version)}<span class="date">${esc(e.date)}</span></h3>
        <ul>
${e.notes.map((n) => `          <li>${esc(n)}</li>`).join("\n")}
        </ul>
      </article>`,
  )
  .join("\n");

const html = `<!doctype html>
<!-- 자동 생성 파일 — 직접 고치지 마세요. 원본: src/changelog.ts (npm run bump 이 갱신) -->
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SSHTool2 — 전체 변경 이력</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: #14161a; color: #d8dbe0;
      font: 15px/1.7 "Segoe UI", "Malgun Gothic", system-ui, sans-serif;
    }
    .wrap { max-width: 860px; margin: 0 auto; padding: 48px 20px 80px; }
    h1 { font-size: 26px; margin: 0 0 6px; }
    .sub { color: #8b929c; margin-bottom: 32px; }
    .sub a { color: #a7c080; }
    .rel { border-left: 2px solid #2a2f37; padding: 0 0 4px 18px; margin: 0 0 26px; }
    .rel h3 { margin: 0 0 8px; font-size: 17px; color: #a7c080; display: flex; gap: 12px; align-items: baseline; }
    .date { color: #6f7681; font-size: 13px; font-weight: 400; }
    ul { margin: 0; padding-left: 18px; }
    li { margin: 4px 0; }
    footer { margin-top: 48px; color: #6f7681; font-size: 13px; }
    footer a { color: #a7c080; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>SSHTool2 전체 변경 이력</h1>
    <div class="sub">
      총 ${entries.length}개 버전 · <a href="./">홈으로</a> ·
      <a href="https://github.com/SeonghwanLee/SSHTool2/releases">GitHub 릴리스</a>
    </div>
${body}
    <footer>앱의 <b>버전정보</b> 창에는 최근 5개만 표시됩니다 — 전체 이력은 이 페이지에서 봅니다.</footer>
  </div>
</body>
</html>
`;

writeFileSync(path.join(root, "site/changelog.html"), html);
console.log(`site/changelog.html 생성 — ${entries.length}개 버전`);
