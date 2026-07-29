// 릴리스 버전 범프 — `npm run bump 0.51.0`
//
// 버전이 네 곳(package.json · tauri.conf.json · Cargo.toml · changelog.ts)에 흩어져 있어
// 손으로 맞추다 한 번 어긋났다(0.43.0 항목에 0.44.0 내용이 들어간 사고). 이 스크립트는
// 세 파일의 버전을 한 번에 올리고, changelog 에 새 버전 항목이 이미 있는지 검사한다 —
// 없으면 실패한다. 릴리스 노트 없이 버전만 올라가는 릴리스를 만들지 않기 위해서다.
//
// 커밋·태그는 하지 않는다. 무엇을 릴리스할지는 사람이 정하는 일이고,
// 이 스크립트는 "네 곳이 어긋날 수 없게" 만드는 것까지만 맡는다.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const next = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(next ?? "")) {
  console.error("사용법: npm run bump <버전>   예) npm run bump 0.51.0");
  process.exit(1);
}

const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const write = (rel, s) => writeFileSync(path.join(root, rel), s);

// 현재 버전은 package.json 을 기준으로 삼는다.
const pkg = JSON.parse(read("package.json"));
const cur = pkg.version;

if (cur === next) {
  console.error(`이미 ${cur} 입니다.`);
  process.exit(1);
}

// 내림 방지 — 실수로 낮은 버전을 넣으면 업데이터가 새 버전을 옛것으로 본다.
const ord = (v) => v.split(".").map(Number);
const [a, b] = [ord(cur), ord(next)];
if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])))) {
  console.error(`현재 ${cur} → ${next} 는 내려가는 버전입니다.`);
  process.exit(1);
}

// 1) changelog 검사부터 — 실패하면 아무 파일도 건드리지 않은 상태여야 한다.
const changelog = read("src/changelog.ts");
if (!changelog.includes(`version: "${next}"`)) {
  console.error(
    `src/changelog.ts 에 ${next} 항목이 없습니다.\n` +
      `릴리스 노트를 먼저 쓰세요 — 노트 없는 릴리스를 만들지 않습니다.`,
  );
  process.exit(1);
}
if (!changelog.includes(`version: "${cur}"`)) {
  console.error(`changelog 에 현재 버전(${cur}) 항목이 없습니다 — 상태가 이상합니다. 확인 필요.`);
  process.exit(1);
}

// 2) 세 파일 치환 — 각 파일에서 정확히 한 번씩만 바뀌어야 한다.
const targets = [
  ["package.json", `"version": "${cur}"`, `"version": "${next}"`],
  ["src-tauri/tauri.conf.json", `"version": "${cur}"`, `"version": "${next}"`],
  ["src-tauri/Cargo.toml", `version = "${cur}"`, `version = "${next}"`],
];

for (const [rel, from] of targets) {
  const s = read(rel);
  const count = s.split(from).length - 1;
  if (count !== 1) {
    console.error(`${rel}: "${from}" 이 ${count}번 나타납니다(1번이어야 함). 중단 — 아무것도 바꾸지 않았습니다.`);
    process.exit(1);
  }
}
for (const [rel, from, to] of targets) {
  write(rel, read(rel).replace(from, to));
  console.log(`  ${rel}: ${cur} → ${next}`);
}

console.log(`\n완료. 다음 순서:`);
console.log(`  npm run build        # 타입 검사`);
console.log(`  npm run check:ui     # UI 회귀 검사`);
console.log(`  git add -A && git commit && git push`);
console.log(`  git tag v${next} && git push origin v${next}   # 이때 릴리스가 만들어진다`);
