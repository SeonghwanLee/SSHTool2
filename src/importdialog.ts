// 외부 프로그램 세션 가져오기 — PuTTY/SecureCRT/MobaXterm/WinSCP/FileZilla.
// 프로그램 → 원본 폴더(중첩 트리) → 세션 미리보기, 체크박스 선택(폴더 체크=하위 전체, 부분선택 중간표시),
// 검색 필터(선택 유지), host+user 중복 제외. 비밀번호는 가져오지 않음(첫 접속 시 입력).

import { openModal } from "./dialogs";
import { importScan, type ImportedSession } from "./ipc";
import { blankSession, type SessionInfo } from "./types";

/** 가져올 수 있는 프로그램. id 는 백엔드 import::SOURCES 와 같아야 한다. */
const PROGRAMS: { id: string; label: string }[] = [
  { id: "putty", label: "PuTTY" },
  { id: "securecrt", label: "SecureCRT" },
  { id: "mobaxterm", label: "MobaXterm" },
  { id: "winscp", label: "WinSCP" },
  { id: "filezilla", label: "FileZilla" },
];

/** 가져오기 결과로 추가할 세션들(취소/없음이면 빈 배열). */
export async function importDialog(existing: SessionInfo[]): Promise<SessionInfo[]> {
  // 스캔은 **고른 프로그램 하나만** 돈다(0.69.0) — 다섯 개를 매번 훑으면 안 쓰는
  // 프로그램 때문에도 느려지고, 결과가 섞여 무엇을 가져오는지 알기 어려웠다.
  const idOf = (h: string, p: number, u: string) =>
    `${h.toLowerCase()}|${p}|${u.toLowerCase()}`;
  let scanned: ImportedSession[] = [];
  let candidates: ImportedSession[] = [];

  const rescan = async (source: string): Promise<void> => {
    scanned = await importScan(source).catch(() => []);
    // 이미 있는 host+port+user 는 후보에서 제외(스캔 결과끼리의 중복도 한 번만).
    const seen = new Set(existing.map((s) => idOf(s.host, s.port, s.user)));
    candidates = [];
    for (const s of scanned) {
      const k = idOf(s.host, s.port, s.user);
      if (seen.has(k)) continue;
      seen.add(k);
      candidates.push(s);
    }
  };

  return new Promise((resolve) => {
    openModal(
      (close) => {
        const card = document.createElement("div");
        card.className = "settings-card";

        const title = document.createElement("h3");
        title.textContent = "외부 프로그램 세션 가져오기";
        const sub = document.createElement("div");
        sub.className = "modal-sub";
        sub.textContent = "가져올 프로그램을 고르세요. 비밀번호는 가져오지 않습니다.";

        // ── 프로그램 선택(0.69.0) — 고른 하나만 훑는다 ──
        const progRow = document.createElement("div");
        progRow.className = "import-prog";
        const progLabel = document.createElement("span");
        progLabel.textContent = "프로그램";
        const progSel = document.createElement("select");
        progSel.className = "sel-input";
        for (const p of PROGRAMS) {
          const o = document.createElement("option");
          o.value = p.id;
          o.textContent = p.label;
          progSel.appendChild(o);
        }
        const scanBtn = document.createElement("button");
        scanBtn.type = "button";
        scanBtn.className = "btn-accent";
        scanBtn.textContent = "찾기";
        progRow.append(progLabel, progSel, scanBtn);

        /** 고른 프로그램을 훑어 목록을 새로 그린다. 도는 동안 버튼을 잠근다. */
        const runScan = async (): Promise<void> => {
          const label = PROGRAMS.find((p) => p.id === progSel.value)?.label ?? "";
          scanBtn.disabled = true;
          progSel.disabled = true;
          sub.textContent = `${label} 세션을 찾는 중…`;
          try {
            await rescan(progSel.value);
          } finally {
            scanBtn.disabled = false;
            progSel.disabled = false;
          }
          checked.clear();
          sub.textContent =
            scanned.length === 0
              ? `${label} 세션을 찾지 못했습니다. 설치돼 있는지, 저장된 세션이 있는지 확인하세요.`
              : `${label} ${scanned.length}개 발견 · 이미 등록된 ${scanned.length - candidates.length}개 제외 · 비밀번호는 가져오지 않습니다.`;
          draw();
          updateCount();
        };
        scanBtn.addEventListener("click", () => void runScan());
        // 프로그램을 바꾸면 이전 결과가 남아 헷갈리지 않게 즉시 비운다.
        progSel.addEventListener("change", () => {
          scanned = [];
          candidates = [];
          checked.clear();
          sub.textContent = "‘찾기’ 를 눌러 이 프로그램의 세션을 불러오세요.";
          draw();
          updateCount();
        });

        const search = document.createElement("input");
        search.placeholder = "검색 (이름·호스트·계정)";
        search.className = "sftp-path";

        const list = document.createElement("div");
        list.className = "bulk-list";

        // id → 체크 상태(검색으로 다시 그려도 선택 유지).
        const key = (s: ImportedSession) => `${s.source}|${s.folder}|${s.name}|${s.host}|${s.user}`;
        const checked = new Set<string>();

        const count = document.createElement("div");
        count.className = "modal-err";
        const updateCount = () => {
          count.textContent = checked.size ? `${checked.size}개 선택됨` : "";
          ok.disabled = checked.size === 0;
        };

        // 프로그램 → 폴더 → 하위폴더 → 세션 트리. 실제로 만들어질 depth 와 동일하게 표시.
        interface Node {
          name: string;
          folders: Map<string, Node>;
          sessions: ImportedSession[];
        }
        const newNode = (name: string): Node => ({ name, folders: new Map(), sessions: [] });
        const collect = (n: Node): ImportedSession[] => [
          ...n.sessions,
          ...[...n.folders.values()].flatMap(collect),
        ];

        function draw(): void {
          const q = search.value.trim().toLowerCase();
          const shown = candidates.filter(
            (s) =>
              !q ||
              s.name.toLowerCase().includes(q) ||
              s.host.toLowerCase().includes(q) ||
              s.user.toLowerCase().includes(q),
          );

          // 트리 구성: [소스, ...폴더 세그먼트] 경로로 내려가며 세션을 리프에 담는다.
          const root = newNode("");
          for (const s of shown) {
            const segs = [s.source, ...s.folder.split(/[\\/]/).filter(Boolean)];
            let node = root;
            for (const seg of segs) {
              if (!node.folders.has(seg)) node.folders.set(seg, newNode(seg));
              node = node.folders.get(seg)!;
            }
            node.sessions.push(s);
          }

          list.innerHTML = "";
          renderNode(root, 0);

          if (shown.length === 0) {
            const empty = document.createElement("div");
            empty.className = "tree-empty";
            empty.textContent = candidates.length
              ? "검색 결과가 없습니다."
              : scanned.length
                ? "가져올 새 세션이 없습니다(모두 이미 등록됨)."
                : "위에서 프로그램을 고르고 ‘찾기’ 를 누르세요.";
            list.appendChild(empty);
          }
        }

        function renderNode(node: Node, depth: number): void {
          const folders = [...node.folders.values()].sort((a, b) =>
            a.name.localeCompare(b.name, "ko"),
          );
          for (const f of folders) {
            const items = collect(f);
            const head = document.createElement("label");
            head.className = "bulk-group bulk-group-check";
            head.style.paddingLeft = `${6 + depth * 16}px`;
            const box = document.createElement("input");
            box.type = "checkbox";
            const on = items.filter((s) => checked.has(key(s))).length;
            box.checked = on > 0 && on === items.length;
            box.indeterminate = on > 0 && on < items.length; // 부분 선택
            box.addEventListener("change", () => {
              for (const s of items) {
                if (box.checked) checked.add(key(s));
                else checked.delete(key(s));
              }
              draw();
              updateCount();
            });
            const label = document.createElement("span");
            label.textContent = `${f.name}  (${items.length})`;
            head.append(box, label);
            list.appendChild(head);

            renderNode(f, depth + 1); // 하위 폴더/세션은 한 단계 더 들여쓴다
          }

          const sessions = [...node.sessions].sort((a, b) => a.name.localeCompare(b.name, "ko"));
          for (const s of sessions) {
            const row = document.createElement("label");
            row.className = "bulk-row";
            row.style.paddingLeft = `${6 + depth * 16}px`;
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = checked.has(key(s));
            cb.addEventListener("change", () => {
              if (cb.checked) checked.add(key(s));
              else checked.delete(key(s));
              draw(); // 상위 폴더 체크박스 상태(부분선택) 갱신
              updateCount();
            });
            const label = document.createElement("span");
            label.className = "bulk-label";
            label.textContent = s.name;
            const detail = document.createElement("span");
            detail.className = "bulk-detail";
            detail.textContent = s.user ? `${s.user}@${s.host}:${s.port}` : `${s.host}:${s.port}`;
            row.append(cb, label, detail);
            list.appendChild(row);
          }
        }

        search.addEventListener("input", draw);

        const buttons = document.createElement("div");
        buttons.className = "modal-buttons";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "취소";
        cancel.addEventListener("click", () => {
          close();
          resolve([]);
        });
        const ok = document.createElement("button");
        ok.type = "button";
        ok.className = "btn-accent";
        ok.textContent = "가져오기";
        ok.disabled = true;
        ok.addEventListener("click", () => {
          const picked = candidates.filter((s) => checked.has(key(s)));
          close();
          resolve(picked.map(toSession));
        });
        buttons.append(cancel, ok);

        draw();
        updateCount();
        card.append(title, sub, progRow, search, list, count, buttons);
        return card;
      },
      () => resolve([]),
    );
  });
}

/** 가져온 항목 → 앱 세션. 폴더는 '프로그램명/원본폴더' 로 구조 보존. */
function toSession(s: ImportedSession): SessionInfo {
  return {
    ...blankSession(),
    name: s.name,
    host: s.host,
    port: s.port,
    user: s.user,
    folder: s.folder ? `${s.source}/${s.folder}` : s.source,
  };
}
