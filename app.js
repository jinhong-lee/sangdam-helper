import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, writeBatch, deleteField,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const PREFS = 'sangdam-helper:prefs';
const TYPE = { analysis: '사례 분석', journal: '상담일지' };
// 관리자: 모든 사용자의 기록을 읽기 전용으로 볼 수 있음 (firestore.rules의 isAdmin과 같은 목록이어야 함)
const ADMINS = ['leejjinhong@gmail.com'];
const isAdminUser = () => !!user && ADMINS.includes(user.email);
// 선 아이콘 한 세트 (Lucide 계열, 선 굵기 1.8 통일) — 글자 기호(▸ ⋯ ← + ✓ 이모지) 대신 사용
const IC_PATH = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevR: '<path d="m9 6 6 6-6 6"/>',
  more: '<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};
const ic = (name, size = 16, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC_PATH[name]}</svg>`;
const LINE_ICON = {
  trash: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};
const SHORT_TYPE = { journal: '일지', analysis: '분석' };   // 메뉴·목록의 종류 표시 (같은 말로 통일)
const SHORT = { analysis: '사례', journal: '일지' }; // 다시 생성 버튼용 짧은 이름
const HISTORY_COUNT = 3;
const TRASH_DAYS = 30;   // 휴지통 보관 기간. 지난 것은 앱을 열 때 영구 삭제 (서버 기능 없이 처리 → 추가 비용 없음)

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 서비스 공통 날짜 형식: yy.mm.dd hh:mm (시간이 필요 없으면 yy.mm.dd)
const p2 = (n) => String(n).padStart(2, '0');
const fmtDay = (ts) => { const d = new Date(ts); return `${p2(d.getFullYear() % 100)}.${p2(d.getMonth() + 1)}.${p2(d.getDate())}`; };
const fmtDate = (ts) => { const d = new Date(ts); return `${fmtDay(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
// ⚠ 작성일과 상담일은 완전히 다른 값:
//   작성일 = 기록을 실제로 쓴 시각(writtenAt, 예전 기록은 createdAt) → 화면의 날짜 표시·'최근 작성순'
//   상담일 = 제목에 적은 회기 날짜·시간 → '상담일순'·이전 기록 참고·한꺼번에 만들기·내보내기 순서
//   createdAt은 예전에 여러 회기 저장 때 상담일을 넣은 적이 있어 화면 표시에 직접 쓰지 않음.
// editedAt은 사람이 [내용 저장]으로 고친 시각(AI 생성·다시 생성은 수정으로 치지 않음).
const writtenOf = (r) => r.writtenAt || r.createdAt || r.updatedAt || 0;
const sessionOf = (r) => (r?.title && parseHeader(r.title).ts) || null;   // 제목에 상담일이 없으면 null
const chronoOf = (r) => sessionOf(r) || writtenOf(r);                     // 회기 흐름 순서
const recDate = (r) => r.editedAt ? `수정 ${fmtDate(r.editedAt)}` : `작성 ${fmtDate(writtenOf(r))}`;
const plain = (md) => (md || '').replace(/[#*|>`_-]+/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- 화면 갱신 ----------
// 화면 전체를 지우고 다시 그리지 않고, 새 화면과 비교해 바뀐 부분만 고침(morphdom).
// → 이동·저장 때 깜빡임이 없고, 입력 중인 칸·스크롤·포커스가 유지되며, 기록이 많아도 바뀐 곳만 손댐.
const nodeKey = (n) => (n.nodeType === 1 ? n.id || n.getAttribute('data-open') || n.getAttribute('data-tkey') || n.getAttribute('data-key') || undefined : undefined);
function paint(el, html) {
  if (!el) return;
  if (!window.morphdom) { el.innerHTML = html; return; }   // 라이브러리를 못 불러오면 예전 방식으로
  const next = el.cloneNode(false);
  next.innerHTML = html;
  window.morphdom(el, next, {
    childrenOnly: true,
    getNodeKey: nodeKey,
    onBeforeElUpdated: (from, to) => !from.isEqualNode(to),   // 똑같은 부분은 건드리지 않음
  });
}
const view = {
  set main(html) { paint($('#main'), html); },
  set nav(html) { paint($('#nav'), html); },
};
// 화면을 다시 그릴 때마다 이벤트를 다시 연결하므로, 쌓이지 않게 on* 속성으로 덮어씀
function on(sel, type, fn) { const el = $(sel); if (el) el['on' + type] = fn; }

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('act'); t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2000);
}
// 되돌리기 버튼이 붙은 알림 (삭제 직후 등)
function toastAction(msg, label, fn) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span><button class="toast-btn">${esc(label)}</button>`;
  t.classList.add('show', 'act');
  clearTimeout(toast.timer);
  const hide = () => t.classList.remove('show', 'act');
  toast.timer = setTimeout(hide, 6000);
  t.querySelector('button').onclick = async () => { clearTimeout(toast.timer); hide(); await fn(); };
}
function show(view) {
  ['#bootView', '#loginView', '#appView'].forEach((v) => $(v).classList.toggle('hidden', v !== view));
}
function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS)) || {}; } catch { return {}; } }
function savePrefs(p) { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch {} }

// ---------- 상태 ----------
let manifest = null;
const docs = {};
let auth, db, user = null;
let profile = {};
let clients = [];
let records = [];
let trash = [];          // 휴지통에 있는 기록 (deletedAt 있음)
let trashClients = [];   // 휴지통에 있는 내담자
let models = null;
let sel = null;          // 기록 선택 모드: { ids: Set }
let curList = null;      // 지금 화면의 기록 목록 { list, showClient }
let batchRun = null;     // 여러 기록 결과 만들기 진행 중
let editor = null;    // 작성 중인 기록
let running = null;   // 진행 중인 생성 요청
const prefs = loadPrefs();

const userCol = (name) => collection(db, 'users', user.uid, name);
const userDoc = (name, id) => doc(db, 'users', user.uid, name, id);
const clientName = (id) => clients.find((c) => c.id === id)?.name || '(삭제된 내담자)';
const clientRecords = (id) => records.filter((r) => r.clientId === id);

// ---------- 시작 ----------
async function boot() {
  if (!firebaseConfig.apiKey) {
    $('#bootView').innerHTML = '<div class="card" style="max-width:480px">아직 로그인 서비스가 연결되지 않았어요. 관리자에게 알려주세요.</div>';
    return;
  }
  try {
    manifest = await (await fetch('prompts/manifest.json')).json();
    const all = [manifest.role, ...manifest.lenses, manifest.formats.analysis, manifest.formats.journal];
    await Promise.all(all.map(async (d) => {
      const res = await fetch('prompts/' + d.file);
      if (!res.ok) throw new Error(d.file);
      docs[d.id] = (await res.text()).trim();
    }));
  } catch (e) {
    $('#bootView').innerHTML = `<div class="error-box">자료를 불러오지 못했어요. 새로고침해 주세요. (${esc(e.message)})</div>`;
    return;
  }

  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);

  onAuthStateChanged(auth, async (u) => {
    user = u;
    if (!u) { editor = null; show('#loginView'); return; }
    show('#bootView');
    try {
      await loadData();
    } catch (e) {
      $('#bootView').innerHTML = `<div class="error-box">기록을 불러오지 못했어요. (${esc(e.message)})</div>`;
      return;
    }
    $('#userMail').textContent = u.email || '';
    $('#adminLink').hidden = !isAdminUser();
    if (isAdminUser()) loadFeedback().catch(() => {});   // 보안 규칙 게시 전이면 조용히 넘어감
    show('#appView');
    route();
  });
}

async function loadData() {
  const pref = doc(db, 'users', user.uid);
  const snap = await getDoc(pref);
  profile = snap.exists() ? snap.data() : {};
  if (!snap.exists()) await setDoc(pref, { email: user.email || '', createdAt: Date.now() });
  setDoc(pref, { email: user.email || '', lastSeenAt: Date.now() }, { merge: true }).catch(() => {});
  // AI 이용 키는 관리자도 볼 수 없게 users/{uid}/private/settings 에 따로 보관 (예전 위치에 있으면 옮기고 지움)
  const keyRef = doc(db, 'users', user.uid, 'private', 'settings');
  const ks = await getDoc(keyRef);
  let key = ks.exists() ? ks.data().geminiKey || '' : '';
  if (profile.geminiKey !== undefined) {
    if (!key && profile.geminiKey) { key = profile.geminiKey; await setDoc(keyRef, { geminiKey: key }, { merge: true }); }
    await updateDoc(pref, { geminiKey: deleteField() });
  }
  profile.geminiKey = key;
  const [cs, rs] = await Promise.all([getDocs(userCol('clients')), getDocs(userCol('records'))]);
  const allC = cs.docs.map((d) => ({ id: d.id, ...d.data() }));
  const allR = rs.docs.map((d) => ({ id: d.id, ...d.data() }));
  const cutoff = Date.now() - TRASH_DAYS * 864e5;
  const expired = (x) => x.deletedAt && x.deletedAt < cutoff;
  const ops = [
    ...allC.filter(expired).map((c) => (b) => b.delete(userDoc('clients', c.id))),
    ...allR.filter(expired).map((r) => (b) => b.delete(userDoc('records', r.id))),
  ];
  if (ops.length) commitOps(ops).catch(() => {});   // 실패해도 다음에 열 때 다시 정리
  clients = allC.filter((c) => !c.deletedAt).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  records = allR.filter((r) => !r.deletedAt).sort((a, b) => writtenOf(b) - writtenOf(a));
  trashClients = allC.filter((c) => c.deletedAt && !expired(c));
  trash = allR.filter((r) => r.deletedAt && !expired(r));
  models = null;
}

// 여러 문서를 한 번에 쓰기 (한 번에 500개 제한이 있어 나눠서)
async function commitOps(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach((op) => op(b));
    await b.commit();
  }
}

// ---------- 로그인 ----------
$('#loginBtn').onclick = async () => {
  const err = $('#loginError'); err.classList.add('hidden');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === 'auth/popup-blocked') return signInWithRedirect(auth, provider);
    if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    err.textContent = e.code === 'auth/unauthorized-domain'
      ? '이 주소에서는 아직 로그인이 허용되지 않았어요. 관리자에게 알려주세요.'
      : '로그인하지 못했어요. (' + e.code + ')';
    err.classList.remove('hidden');
  }
};
// 저장하지 않은 내용이 있을 때 물어봄 → true: 계속 진행, false: 멈춤
async function askUnsaved(actionLabel) {
  if (!editor?.dirty) return true;
  const pick = await confirmModal({ title: '저장하지 않은 내용이 있어요', message: `${actionLabel} 전에 저장할까요? 저장하지 않으면 지금 적은 내용이 사라져요.`, okLabel: `저장하고 ${actionLabel}`, cancelLabel: `저장 안 하고 ${actionLabel}` });
  if (pick === null) return false;
  if (pick) { try { await saveEditor(true, true); } catch { return false; } }
  else if (editor) editor.dirty = false;
  return true;
}
$('#logoutBtn').onclick = async () => {
  exitViewAs();
  if (!(await askUnsaved('로그아웃'))) return;
  if (batch && !batch.done && !(await confirmModal({ title: '결과를 만드는 중이에요', message: '로그아웃하면 아직 못 만든 기록은 멈춰요. 이미 만든 결과는 저장돼 있어요.', okLabel: '멈추고 로그아웃', cancelLabel: '계속 만들기' }))) return;
  batch?.ctrl.abort(); $('#batchModal')?.remove(); batch = null; renderBatch();
  running?.abort();
  await signOut(auth);
  location.hash = '';
};

// ---------- 화면 이동 ----------
let lastHash = location.hash;
let skipHash = false;
window.addEventListener('hashchange', async () => {
  if (skipHash) { skipHash = false; return; }
  if (editor?.dirty) {
    const target = location.hash;
    skipHash = true; location.hash = lastHash;          // 일단 지금 화면에 머문 채로 물어봄
    if (!(await askUnsaved('이동'))) return;
    location.hash = target;
    return;
  }
  lastHash = location.hash;
  route();
});
window.addEventListener('beforeunload', (e) => {
  if (editor?.dirty || editor?.saveState === 'saving' || batchRun) { e.preventDefault(); e.returnValue = ''; }
});
// Cmd/Ctrl+S로 즉시 저장
document.addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 's' && editor) { ev.preventDefault(); editor.dirty = true; saveEditor(false, true); }
});
function setHashSilently(h) { history.replaceState(null, '', h); lastHash = h; }

function route() {
  if (!user) return;
  running?.abort();
  clearTimeout(autoT);
  closeMenus();
  editor = null;
  sel = null;
  const [, page, a, b] = (location.hash || '#/').split('/');
  if (viewAs && (page === 'settings' || page === 'admin')) exitViewAs();   // 설정·관리자로 가면 내 화면으로 돌아옴
  if (page === 'admin' && a === 'feedback' && isAdminUser()) { viewFeedback(); renderNav(); return; }
  if (page === 'admin' && a && isAdminUser()) { enterViewAs(a); return; }
  if (page === 'c' && clients.some((c) => c.id === a)) viewClient(a);
  else if (page === 'new' && !viewAs && clients.some((c) => c.id === a) && TYPE[b]) openEditor({ clientId: a, type: b });
  else if (page === 'r' && records.some((r) => r.id === a)) openEditor(records.find((r) => r.id === a));
  else if (page === 'trash' && !viewAs) viewTrash();
  else if (page === 'settings') viewSettings();
  else if (page === 'admin' && isAdminUser()) viewAdmin(a);
  else viewHome();
  renderNav();
  setNavOpen(false);   // 모바일: 이동하면 메뉴 접기
  window.scrollTo(0, 0);
}
function setNavOpen(open) {
  $('#sidebar').classList.toggle('open', open);
  $('#navToggle').setAttribute('aria-expanded', open);
}
$('#navToggle').onclick = () => setNavOpen(!$('#sidebar').classList.contains('open'));
$('#nav').addEventListener('click', (ev) => { if (ev.target.closest('a')) setNavOpen(false); });   // 같은 화면을 눌러도 접힘

const navToggled = new Map(); // 내담자별로 사용자가 직접 펼침/접음을 바꾼 상태
let navQuery = '';
// 검색: 이미 불러온 목록 안에서만 찾음 → 서버 조회 없음(무료 사용량 소모 없음)
function hl(text, q) {
  const t = esc(text);
  if (!q) return t;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return t;
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}
function renderNav() {
  const h = location.hash || '#/';
  const [, page, a] = h.split('/');
  const curRecord = editor?.id || (page === 'r' ? a : null);
  const curClient = editor?.clientId || (page === 'c' ? a : null);
  const q = navQuery.trim().toLowerCase();
  const groups = clients.map((c) => {
    let recs = sortList(clientRecords(c.id));   // 목록과 같은 정렬
    const nameHit = !q || c.name.toLowerCase().includes(q);
    if (q && !nameHit) recs = recs.filter((r) => (r.title || '').toLowerCase().includes(q));
    return { c, recs, show: nameHit || recs.length, total: clientRecords(c.id).length };
  }).filter((g) => g.show);
  { const [, pg, id] = (location.hash || '#/').split('/');
    const rec = pg === 'r' && records.find((r) => r.id === id);
    const cid = pg === 'c' || pg === 'new' ? id : rec?.clientId;
    $('#navToggleName').textContent = cid ? clientName(cid) : pg === 'trash' ? '휴지통' : pg === 'settings' ? '설정' : '전체 기록'; }
  view.nav = `
    ${groups.map(({ c, recs, total }) => {
      const open = q ? true : navToggled.has(c.id) ? navToggled.get(c.id) : c.id === curClient;
      const cls = page === 'c' && a === c.id ? 'on' : c.id === curClient ? 'parent' : '';
      return `<div class="tree">
        <div class="tree-row">
          <button class="tw" data-tw="${c.id}" aria-expanded="${open}" aria-label="${esc(c.name)} 기록 ${open ? '접기' : '펼치기'}">${ic('chevR', 14)}</button>
          <a href="#/c/${c.id}" class="${cls}"><span class="kt" data-tip>${hl(c.name, q)}</span> <span class="cnt">${total}</span></a>
        </div>
        ${open ? `<div class="tree-kids">${recs.map((r) => `
          <a href="#/r/${r.id}" class="kid ${r.id === curRecord ? 'on' : ''}">
            <span class="ktype">${SHORT_TYPE[r.type]}</span><span class="kt" data-tip>${hl(r.title || '', q)}</span>
          </a>`).join('') || '<span class="kid-empty">아직 기록이 없어요</span>'}</div>` : ''}
      </div>`;
    }).join('')}
    ${q && !groups.length ? '<div class="nav-empty">검색 결과가 없어요</div>' : ''}
    ${!q && !viewAs ? `<div class="nav-sep" aria-hidden="true"></div><a href="#/trash" class="nav-trash ${page === 'trash' ? 'on' : ''}"><span class="nav-ic">${LINE_ICON.trash}휴지통</span> <span class="cnt">${trashRows().length}</span></a>` : ''}
`;
  $('#nav').querySelectorAll('[data-tw]').forEach((b) => {
    b.onclick = () => { navToggled.set(b.dataset.tw, b.getAttribute('aria-expanded') !== 'true'); renderNav(); };
  });
}

// 왼쪽 메뉴 폭 조절 (220~480px, 기기별로 기억)
const SIDE = { min: 220, max: 480, def: 264 };
(() => {
  const layout = document.querySelector('.layout'), handle = $('#sideResizer');
  if (!layout || !handle) return;
  const set = (w, save) => {
    w = Math.round(Math.min(SIDE.max, Math.max(SIDE.min, w)));
    layout.style.setProperty('--side-w', w + 'px');
    handle.setAttribute('aria-valuenow', w);
    if (save) { prefs.sideW = w; savePrefs(prefs); }
    return w;
  };
  handle.setAttribute('aria-valuemin', SIDE.min); handle.setAttribute('aria-valuemax', SIDE.max);
  let cur = set(prefs.sideW || SIDE.def, false);
  handle.onpointerdown = (ev) => {
    ev.preventDefault(); handle.setPointerCapture(ev.pointerId); document.body.classList.add('resizing');
    handle.onpointermove = (m) => { cur = set(m.clientX, false); };
    handle.onpointerup = () => { handle.onpointermove = null; document.body.classList.remove('resizing'); cur = set(cur, true); };
  };
  handle.ondblclick = () => { cur = set(SIDE.def, true); };
  handle.onkeydown = (ev) => {
    const step = ev.shiftKey ? 48 : 16;
    if (ev.key === 'ArrowLeft') cur = set(cur - step, true);
    else if (ev.key === 'ArrowRight') cur = set(cur + step, true);
    else if (ev.key === 'Home') cur = set(SIDE.min, true);
    else if (ev.key === 'End') cur = set(SIDE.max, true);
    else return;
    ev.preventDefault();
  };
})();

// 내담자 추가 (왼쪽 메뉴 맨 위)
$('#navAddClient').onclick = addClient;

// 검색창
const navSearch = $('#navSearch');
navSearch.oninput = () => { navQuery = navSearch.value; renderNav(); };
navSearch.onkeydown = (e) => { if (e.key === 'Escape') { navSearch.value = ''; navQuery = ''; renderNav(); } };

// 말줄임된 항목만 마우스를 올리면 전체 제목을 툴팁으로 보여줌
const navTip = document.createElement('div');
navTip.className = 'nav-tip'; navTip.hidden = true; navTip.setAttribute('role', 'tooltip');
document.body.appendChild(navTip);
$('#nav').addEventListener('mouseover', (ev) => {
  const el = ev.target.closest('a')?.querySelector('[data-tip]');
  if (!el || el.scrollWidth <= el.clientWidth) { navTip.hidden = true; return; }
  navTip.textContent = el.textContent;
  navTip.hidden = false;
  const r = el.closest('a').getBoundingClientRect();
  navTip.style.left = Math.min(r.right + 8, window.innerWidth - navTip.offsetWidth - 8) + 'px';
  navTip.style.top = (r.top + r.height / 2 - navTip.offsetHeight / 2) + 'px';
});
$('#nav').addEventListener('mouseleave', () => { navTip.hidden = true; });
window.addEventListener('scroll', () => { navTip.hidden = true; }, { passive: true });

// ---------- 내담자 ----------
// 내담자 별칭 입력 모달 (추가·이름 바꾸기 공용)
function nameModal({ title, okLabel, value = '', exceptId = null }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="nTitle">
        <div class="modal-body">
          <h3 id="nTitle">${esc(title)}</h3>
          <p class="sub">실명 대신 "A-1"처럼 나만 알아볼 수 있는 별칭을 써주세요.</p>
          <div class="field" style="margin:0">
            <label for="nInput">별칭</label>
            <input type="text" id="nInput" autocomplete="off" maxlength="30" value="${esc(value)}" placeholder="예) A-1">
            <p class="field-error" id="nError" hidden></p>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" data-cancel>취소</button>
          <button class="btn" data-ok disabled>${esc(okLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const input = back.querySelector('#nInput');
    const ok = back.querySelector('[data-ok]');
    const err = back.querySelector('#nError');
    const check = () => {
      const v = input.value.trim();
      const dup = v && clients.some((c) => c.name === v && c.id !== exceptId);
      err.hidden = !dup; err.textContent = dup ? '같은 이름의 내담자가 이미 있어요. 다른 별칭을 써주세요.' : '';
      input.classList.toggle('invalid', !!dup);
      ok.disabled = !v || dup || v === value;
      return !ok.disabled;
    };
    const done = (v) => { document.removeEventListener('keydown', onKey); back.remove(); opener?.focus?.(); resolve(v); };
    const onKey = (ev) => { if (ev.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
    input.oninput = check;
    // 한글 조합 중 Enter 대응: keyup에서 확인
    input.onkeyup = (ev) => { if (ev.key === 'Enter' && !ev.isComposing && check()) done(input.value.trim()); };
    ok.onclick = () => { if (check()) done(input.value.trim()); };
    back.querySelector('[data-cancel]').onclick = () => done(null);
    back.onclick = (ev) => { if (ev.target === back) done(null); };
    check();
    input.focus(); input.select();
  });
}

async function addClient() {
  const name = await nameModal({ title: '내담자 추가', okLabel: '추가' });
  if (!name) return;
  const data = { name, memo: '', createdAt: Date.now(), updatedAt: Date.now() };
  const ref = await addDoc(userCol('clients'), data);
  clients.push({ id: ref.id, ...data });
  clients.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  location.hash = '#/c/' + ref.id;
}

function viewClient(id) {
  const c = clients.find((x) => x.id === id);
  const list = clientRecords(id);
  view.main = `
    <div class="page-head" style="align-items:center">
      <div class="name-row">
        <h2>${esc(c.name)}</h2>
        <div class="more">
          <button class="more-btn" id="moreBtn" aria-haspopup="menu" aria-expanded="false" aria-label="내담자 관리 메뉴">${ic('more', 18)}</button>
          <div class="more-menu" id="moreMenu" role="menu" hidden>
            <button role="menuitem" id="renameBtn">이름 바꾸기</button>
            <button role="menuitem" class="danger" id="delClientBtn">내담자 삭제</button>
          </div>
        </div>
      </div>
      <div class="row">
        <a class="btn h32 new-rec" href="#/new/${id}/journal">${ic('plus')}상담일지 쓰기</a>
        <a class="btn soft h32" href="#/new/${id}/analysis">${ic('plus')}사례 분석 쓰기</a>
      </div>
    </div>
    <div class="stack">
      ${profileCardHTML(c)}
      ${listHTML(list, false)}
    </div>`;
  bindProfileCard(c);
  $('#moreBtn').onclick = () => toggleMenu($('#moreBtn'));
  const closeMenu = closeMenus;
  $('#renameBtn').onclick = async () => {
    closeMenu();
    const name = await nameModal({ title: '이름 바꾸기', okLabel: '바꾸기', value: c.name, exceptId: c.id });
    if (!name) return;
    c.name = name;
    await updateDoc(userDoc('clients', id), { name, updatedAt: Date.now() });
    clients.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    viewClient(id); renderNav();
  };
  $('#delClientBtn').onclick = async () => {
    closeMenu();
    if (!(await confirmModal({ title: '내담자 삭제', message: `"${c.name}"와 이 내담자의 기록 ${list.length}건을 휴지통으로 옮겨요. ${TRASH_DAYS}일 안에는 복구할 수 있어요.`, okLabel: '휴지통으로 옮기기', danger: true }))) return;
    const now = Date.now();
    try {
      await commitOps([(b) => b.update(userDoc('clients', id), { deletedAt: now }), ...list.map((r) => (b) => b.update(userDoc('records', r.id), { deletedAt: now }))]);
    } catch { return toast('삭제하지 못했어요. 인터넷 연결을 확인해 주세요.'); }
    c.deletedAt = now; list.forEach((r) => (r.deletedAt = now));
    records = records.filter((r) => r.clientId !== id); trash.push(...list);
    clients = clients.filter((x) => x.id !== id); trashClients.push(c);
    location.hash = '#/';
    toastAction(`"${c.name}"를 휴지통으로 옮겼어요`, '되돌리기', async () => {
      await restoreItems([{ kind: 'client', id: c.id, item: c, clientId: c.id, deletedAt: now }]);
      toast('되돌렸어요'); location.hash = '#/c/' + c.id; route();
    });
  };
  bindList();
}

// ---------- 내담자 정보 (예전 '내담자 메모') ----------
// 상담사가 계속 기억해야 할 고정 정보. 항목은 일지 서식 17종·수퍼비전폼 공통 항목에서 추린 가안 → 강미 피드백 후 조정.
// 저장: clients/{id}.profile = { birth, gender, ... }, '기타 기억할 것'은 예전 memo 필드를 그대로 씀(기존 메모 유지).
const PROFILE = [
  { group: '기본 정보', fields: [
    { k: 'birth', label: '생년월일', type: 'date', ph: '예) 20180305' },
    { k: 'gender', label: '성별', type: 'select', options: ['남', '여'] },
    { k: 'school', label: '학교·학년', ph: '예) 초2, 미취학, 성인' },
    { k: 'program', label: '소속 사업·기관', ph: '예) 교육청 지원, 발달재활 바우처' },
    { k: 'start', label: '상담 시작일', type: 'date', ph: '예) 20260905' },
    { k: 'schedule', label: '정기 일정', ph: '예) 주 1회 화 16시, 모 상담 격주' },
  ] },
  { group: '상담 배경', fields: [
    { k: 'referral', label: '의뢰 경위', ph: '예) 담임 권유, 수업 중 자리 이탈이 잦음' },
    { k: 'concern', label: '주호소', multi: true, ph: '예) 친구를 때리는 일이 잦음, 엄마와 떨어지기 힘들어함' },
    { k: 'history', label: '발달·병력', multi: true, ph: '예) 언어 발달 늦음, ADHD 진단(2025), 약 복용 중' },
    { k: 'family', label: '가족·양육 환경', multi: true, ph: '예) 부모·동생 1명, 주 양육자 할머니' },
    { k: 'tests', label: '검사 결과', multi: true, ph: '예) K-WISC-V 전체 IQ 95 (2026.09)' },
    { k: 'memo', label: '기타 기억할 것', multi: true, ph: '예) 시작 전 화장실 꼭 들르기, 모래 촉감 싫어함' },
  ] },
];
const PF_ALL = PROFILE.flatMap((g) => g.fields);
const PF = Object.fromEntries(PF_ALL.map((f) => [f.k, f]));
const pval = (c, k) => ((k === 'memo' ? c?.memo : c?.profile?.[k]) || '').trim();
function ageOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); if (!m) return null;
  const t = new Date(); let a = t.getFullYear() - +m[1];
  if (t.getMonth() + 1 < +m[2] || (t.getMonth() + 1 === +m[2] && t.getDate() < +m[3])) a--;
  return a >= 0 && a < 130 ? a : null;
}
const dotDate = (iso) => { const m = /^\d{2}(\d{2})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${m[1]}.${m[2]}.${m[3]}` : (iso || ''); };
const birthText = (iso) => { const a = ageOf(iso); return dotDate(iso) + (a === null ? '' : ` (만 ${a}세)`); };
// "20180305" / "2018-03-05" / "2018.3.5" → "2018-03-05", 틀리면 null
function parseDate8(v) {
  const t = (v || '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(t) || /^(\d{4})[.\-/\s]+(\d{1,2})[.\-/\s]+(\d{1,2})\.?$/.exec(t);
  if (!m) return null;
  const [y, mo, da] = [+m[1], +m[2], +m[3]], dt = new Date(y, mo - 1, da);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== da || y < 1900) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
}
const SUMMARY_KEYS = ['birth', 'gender', 'school', 'program', 'schedule'];
const fieldText = (c, f) => (f.k === 'birth' ? birthText(pval(c, f.k)) : f.type === 'date' ? dotDate(pval(c, f.k)) : pval(c, f.k));
const summaryItems = (c) => SUMMARY_KEYS.filter((k) => pval(c, k)).map((k) => fieldText(c, PF[k]));
const detailFields = (c) => PF_ALL.filter((f) => !SUMMARY_KEYS.includes(f.k) && pval(c, f.k));
// AI·관리자·내보내기용 텍스트
function profileText(c) {
  if (!c) return '';
  return PF_ALL.filter((f) => pval(c, f.k)).map((f) => `${f.label}: ${fieldText(c, f)}`).join('\n');
}

function profileCardHTML(c) {
  const items = summaryItems(c), details = detailFields(c);
  const open = !!prefs.profileOpen || !items.length;   // 기본 정보가 없으면 상세(예전 메모 등)를 펼쳐서 보여줌
  if (!items.length && !details.length) return `
    <div class="card pf-card pf-empty">
      <div><h3>내담자 정보</h3><p class="sub" style="margin:0">생년월일·의뢰 경위처럼 계속 기억할 정보를 적어두면 AI가 함께 참고해요.</p></div>
      <button class="btn soft h32" id="pfEdit">정보 입력</button>
    </div>`;
  return `
    <div class="card pf-card">
      <div class="pf-head">
        <button class="pf-toggle" id="pfToggle" aria-expanded="${open}" aria-controls="pfDetails">
          <svg class="pf-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg><h3>내담자 정보</h3>
        </button>
        <button class="btn ghost h32" id="pfEdit">수정</button>
      </div>
      <div class="pf-meta">${items.length ? items.map((t) => `<span>${esc(t)}</span>`).join('<span class="pf-dot" aria-hidden="true">•</span>') : '<span class="pf-none">기본 정보 없음</span>'}</div>
      <div class="pf-details" id="pfDetails" ${open ? '' : 'hidden'}>
        ${details.length ? details.map((f) => `<div class="pf-row"><div class="pf-label">${f.label}</div><div class="pf-value">${esc(fieldText(c, f))}</div></div>`).join('') : '<p class="sub" style="margin:0">상담 배경 정보가 아직 없어요.</p>'}
      </div>
    </div>`;
}
function bindProfileCard(c) {
  on('#pfToggle', 'click', () => {
    const next = $('#pfToggle').getAttribute('aria-expanded') !== 'true';
    prefs.profileOpen = next; savePrefs(prefs);
    $('#pfToggle').setAttribute('aria-expanded', next); $('#pfDetails').hidden = !next;
  });
  on('#pfEdit', 'click', () => openProfileModal(c));
}

function openProfileModal(c) {
  const opener = document.activeElement;
  const fieldHTML = (f) => {
    const v = pval(c, f.k);
    const val = f.type === 'date' ? v.replace(/-/g, '') : v;
    const input = f.type === 'select'
      ? `<select id="pf_${f.k}" data-k="${f.k}"><option value="">선택 안 함</option>${f.options.map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`
      : f.multi
        ? `<textarea id="pf_${f.k}" data-k="${f.k}" rows="1" placeholder="${esc(f.ph)}">${esc(val)}</textarea>`
        : `<input type="text" id="pf_${f.k}" data-k="${f.k}" value="${esc(val)}" placeholder="${esc(f.ph)}" autocomplete="off" ${f.type === 'date' ? 'inputmode="numeric" maxlength="10"' : 'maxlength="60"'}>`;
    return `<div class="pf-field">
      <label for="pf_${f.k}">${f.label}${f.type === 'date' ? `<span class="pf-hint" data-hint="${f.k}"></span>` : ''}</label>${input}</div>`;
  };
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal pf-modal" role="dialog" aria-modal="true" aria-labelledby="pfTitle">
      <div class="pf-modal-head">
        <h3 id="pfTitle">내담자 정보</h3>
        <button class="pf-close" data-cancel aria-label="닫기"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>
      <div class="modal-body pf-body">
        <div class="pf-notice">
          <b>상담사가 계속 기억해야 할 정보</b>
          적어둔 정보는 상담일지·사례 분석을 만들 때 AI가 함께 참고해요. 모르는 칸은 비워두세요.
        </div>
        ${PROFILE.map((g, i) => `${i ? `<h4 class="pf-group-title">${g.group}</h4>` : ''}<div class="pf-group">${g.fields.map(fieldHTML).join('')}</div>`).join('')}
      </div>
      <div class="pf-actions">
        <p class="field-error" id="pfErr" hidden></p>
        <button class="btn block pf-save" data-ok disabled>저장하기</button>
      </div>
    </div>`;
  document.body.appendChild(back);
  const els = [...back.querySelectorAll('[data-k]')];
  const ok = back.querySelector('[data-ok]'), err = back.querySelector('#pfErr');
  const snap = () => JSON.stringify(els.map((e) => e.value.trim()));
  const initial = snap();
  const dirty = () => snap() !== initial;
  const grow = (t) => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; };
  const sync = () => {
    back.querySelectorAll('[data-hint]').forEach((h) => {
      const v = back.querySelector('#pf_' + h.dataset.hint).value.trim(), d = parseDate8(v);
      h.textContent = !v ? '' : !d ? ' · 20180305처럼 8자리로 적어주세요' : h.dataset.hint === 'birth' && ageOf(d) !== null ? ` · 만 ${ageOf(d)}세` : '';
      h.classList.toggle('bad', !!v && !d);
    });
    ok.disabled = !dirty();
  };
  const done = () => { document.removeEventListener('keydown', onKey); back.remove(); opener?.focus?.(); };
  const tryClose = async () => {
    if (dirty() && !(await confirmModal({ title: '저장하지 않고 닫을까요?', message: '입력한 내용이 사라져요.', okLabel: '닫기', cancelLabel: '계속 입력' }))) return;
    done();
  };
  const onKey = (ev) => { if (ev.key === 'Escape' && !document.querySelector('[role=alertdialog]')) tryClose(); };
  document.addEventListener('keydown', onKey);
  els.forEach((e) => { e.addEventListener('input', () => { if (e.tagName === 'TEXTAREA') grow(e); sync(); }); e.addEventListener('change', sync); });
  back.querySelectorAll('textarea').forEach(grow);
  back.querySelector('[data-cancel]').onclick = tryClose;
  back.onclick = (ev) => { if (ev.target === back) tryClose(); };
  ok.onclick = async () => {
    const out = {}, bad = [];
    els.forEach((e) => {
      const f = PF[e.dataset.k], v = e.value.trim();
      if (f.type === 'date' && v) { const d = parseDate8(v); if (!d) bad.push(f.label); out[f.k] = d || ''; } else out[f.k] = v;
    });
    if (bad.length) { err.textContent = `${bad.join(', ')}: 날짜를 20180305처럼 8자리 숫자로 적어주세요.`; err.hidden = false; return; }
    const { memo, ...profile } = out;
    ok.disabled = true; ok.textContent = '저장 중…'; err.hidden = true;
    try {
      const now = Date.now();
      await updateDoc(userDoc('clients', c.id), { profile, memo, updatedAt: now });
      Object.assign(c, { profile, memo, updatedAt: now });
      done(); toast('내담자 정보를 저장했어요');
      if (location.hash === '#/c/' + c.id) viewClient(c.id);
    } catch {
      err.textContent = '저장하지 못했어요. 인터넷 연결을 확인해 주세요.'; err.hidden = false;
      ok.textContent = '저장하기'; ok.disabled = false;
    }
  };
  // 아래에 더 있으면 저장 버튼 위에 옅은 그라디언트로 암시
  const body = back.querySelector('.pf-body'), acts = back.querySelector('.pf-actions');
  const fade = () => acts.classList.toggle('more', body.scrollHeight - body.scrollTop - body.clientHeight > 4);
  body.addEventListener('scroll', fade, { passive: true });
  els.forEach((e) => e.addEventListener('input', fade));
  sync(); fade();
  back.querySelector('#pf_birth')?.focus();
}

// 처음 쓰는 사람용 3단계 안내: 하나라도 안 끝났으면 홈 위에 보임
function onboardHTML() {
  if (viewAs) return clients.length ? '' : '<div class="card empty"><b>아직 내담자가 없어요</b></div>';
  const steps = [
    { done: !!profile.geminiKey, t: 'AI 이용 키 등록', d: '결과를 만들 때 필요해요. 무료이고 처음 한 번만 하면 돼요.', act: '<a class="btn h32" href="#/settings">키 등록하기</a>' },
    { done: clients.length > 0, t: '내담자 추가', d: '이름 대신 "A-1"처럼 나만 알아볼 수 있는 별칭을 쓰세요.', act: '<button class="btn h32" id="obClient">내담자 추가</button>' },
    { done: records.length > 0, t: '첫 상담일지 쓰기', d: '회기 내용을 적으면 AI가 상담일지 초안을 만들어 줘요.', act: clients.length ? `<a class="btn h32" href="#/new/${clients[0].id}/journal">상담일지 쓰기</a>` : '' },
  ];
  if (steps.every((x) => x.done)) return '';
  const next = steps.findIndex((x) => !x.done);
  return `<div class="card onboard">
    <h3>농지니 시작하기 <span class="ob-count">${steps.filter((x) => x.done).length}/3</span></h3>
    <ol class="ob-steps">${steps.map((x, i) => `
      <li class="${x.done ? 'done' : i === next ? 'now' : ''}">
        <span class="ob-num" aria-hidden="true">${x.done ? ic('check', 14) : i + 1}</span>
        <div class="ob-text"><b>${x.t}</b>${i === next ? `<span>${x.d}</span>` : ''}</div>
        ${i === next ? x.act : ''}
      </li>`).join('')}</ol>
  </div>`;
}
function viewHome() {
  if (!clients.length) {
    view.main = `<div class="page-head"><h2>전체 기록</h2></div>${onboardHTML()}`;
    on('#obClient', 'click', addClient);
    return;
  }
  view.main = `
    <div class="page-head"><h2>전체 기록</h2></div>
    ${onboardHTML()}
    ${records.length ? listHTML(records, true) : ''}`;   // 기록이 없으면 위 시작하기 안내가 다음 할 일을 보여줌
  on('#emptyAddClient', 'click', addClient);
  on('#obClient', 'click', addClient);
  bindList();
}

// ---------- 기록 목록 ----------
function listHTML(list, showClient) {
  curList = { list, showClient };
  return `<div id="listWrap">${listInner()}</div>`;
}
// 목록 카드: 왼쪽 썸네일(종류 아이콘) — 마우스를 올리면 체크 표시, 누르면 선택. 위 막대의 체크박스로 전체 선택/해제.
const ICON = {
  journal: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h10l3 3v15H6z"/><path d="M9 9h7M9 13h7M9 17h4"/></svg>',
  analysis: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.2-4.2M8.5 11h5M11 8.5v5"/></svg>',
  client: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
};
const shortDay = fmtDay;
const picked = () => sel?.ids || new Set();
// 목록 정렬: 최근 작성순(기본) / 상담일순. 상담일 = 제목의 회기 날짜·시간, 없으면 작성일. 회기 번호는 바꾸지 않음.
const SORTS = { recent: '최근 작성순', sessionDesc: '상담일 최신순', sessionAsc: '상담일 오래된순' };
function sortList(list) {
  const k = SORTS[prefs.listSort] ? prefs.listSort : 'recent';
  const a = list.slice();
  if (k === 'recent') return a.sort((x, y) => writtenOf(y) - writtenOf(x));
  return a.sort((x, y) => (k === 'sessionAsc' ? 1 : -1) * (chronoOf(x) - chronoOf(y) || writtenOf(x) - writtenOf(y)));
}
function listInner() {
  const { showClient } = curList;
  const list = sortList(curList.list);
  if (!list.length) return '<div class="card empty"><b>아직 기록이 없어요</b>오른쪽 위 [상담일지 쓰기]로 첫 기록을 만들어 보세요.</div>';
  const ids = picked(), n = ids.size, all = n === list.length;
  return `
  <div class="list-bar${n ? ' active' : ''}">
    <label class="bar-check">
      <input type="checkbox" id="selAll" ${all ? 'checked' : ''} data-mixed="${n && !all ? 1 : 0}" aria-label="${all ? '전체 해제' : '전체 선택'}">
      <span>총 ${list.length}건</span>
    </label>
    ${!n ? `<label class="sort-wrap"><span class="sr-only">정렬</span><select id="listSort" class="sort-select">${Object.entries(SORTS).map(([k, t]) => `<option value="${k}" ${(prefs.listSort || 'recent') === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>` : ''}
    ${n ? `<div class="row bar-actions">
      <span class="bar-count" aria-live="polite"><b>${n}</b>건 선택</span>
      <button class="btn h32" id="selGen">결과 만들기</button>
      <button class="btn danger h32" id="selDel">삭제</button>
      <button class="btn ghost h32" id="selCancel">취소</button>
    </div>` : ''}
  </div>
  <div class="list${n ? ' selecting' : ''}">${list.map((r) => {
    const on = ids.has(r.id);
    return `
    <div class="item${on ? ' picked' : ''}" data-open="${r.id}">
      <button type="button" class="thumb ${r.type}" data-pick="${r.id}" aria-pressed="${on}" aria-label="${esc(r.title)} 선택">
        <span class="thumb-icon">${ICON[r.type] || ICON.journal}</span><span class="thumb-check">${ICON.check}</span>
      </button>
      <div class="item-body">
        <div class="item-title">
          <span class="it-name">${esc(r.title)}</span>
          <span class="it-date" title="${esc(recDate(r))}">${shortDay(writtenOf(r))}</span>
          ${(() => { const b = batchState(r.id); return b ? `<span class="it-state ${b}">${b === 'run' ? '결과 만드는 중' : '결과 대기'}</span>` : `<span class="it-state ${r.result ? 'done' : ''}">${r.result ? '결과 있음' : '결과 없음'}</span>`; })()}
        </div>
        <div class="item-line">${showClient ? `<b>${esc(clientName(r.clientId))}</b>` : `<b>${SHORT_TYPE[r.type]}</b>`}<span class="it-preview">${esc(plain(r.result || recordText(r)).slice(0, 200))}</span></div>
      </div>
      <div class="more">
        <button class="more-btn" data-more aria-haspopup="menu" aria-expanded="false" aria-label="기록 메뉴">${ic('more', 18)}</button>
        <div class="more-menu right" role="menu" hidden>
          <button role="menuitem" data-dup="${r.id}">복제</button>
          <button role="menuitem" class="danger" data-del="${r.id}">삭제</button>
        </div>
      </div>
    </div>`;
  }).join('')}</div>`;
}
function renderList(focusId) {
  const w = $('#listWrap'); if (!w) return;
  paint(w, listInner()); bindList();
  const box = $('#selAll'); if (box) box.indeterminate = box.dataset.mixed === '1';
  if (focusId) w.querySelector(`[data-pick="${focusId}"]`)?.focus();
}
function togglePick(id, on) {
  if (!sel) sel = { ids: new Set() };
  if (on ?? !sel.ids.has(id)) sel.ids.add(id); else sel.ids.delete(id);
  renderList(id);
}
// ⋯ 메뉴 공용: 하나만 열리고, 바깥 클릭·ESC로 닫힘
function closeMenus() {
  document.querySelectorAll('.more-menu:not([hidden])').forEach((m) => {
    m.hidden = true; m.previousElementSibling?.setAttribute('aria-expanded', 'false');
  });
}
function toggleMenu(btn) {
  const menu = btn.nextElementSibling;
  const willOpen = menu.hidden;
  closeMenus();
  if (!willOpen) return;
  menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
  menu.querySelector('[role=menuitem], button')?.focus();
}
document.addEventListener('click', (ev) => { if (!ev.target.closest('.more') || ev.target.closest('.more-menu a')) closeMenus(); });
$('#acctBtn').onclick = () => toggleMenu($('#acctBtn'));
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeMenus(); });

function bindList() {
  $('#main').querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('.thumb, button, .more')) return;
      if (picked().size) { togglePick(el.dataset.open); return; }   // 하나라도 고른 동안에는 카드를 눌러도 고르기 (실수로 열려 선택이 풀리지 않게)
      location.hash = '#/r/' + el.dataset.open;
    };
  });
  $('#main').querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => togglePick(b.dataset.pick); });
  on('#selAll', 'change', () => {
    const all = picked().size === curList.list.length;
    sel = { ids: new Set(all ? [] : curList.list.map((r) => r.id)) }; renderList(); $('#selAll')?.focus();
  });
  on('#listSort', 'change', (e) => { prefs.listSort = e.target.value; savePrefs(prefs); renderList(); renderNav(); $('#listSort')?.focus(); });
  on('#selCancel', 'click', () => { sel = null; renderList(); $('#selAll')?.focus(); });
  on('#selGen', 'click', () => openBatchRun(curList.list.filter((r) => picked().has(r.id))));
  on('#selDel', 'click', () => trashRecords([...picked()]));
  $('#main').querySelectorAll('.item [data-more]').forEach((b) => { b.onclick = () => toggleMenu(b); });
  $('#main').querySelectorAll('[data-dup]').forEach((b) => { b.onclick = () => { closeMenus(); duplicate(b.dataset.dup); }; });
  $('#main').querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { closeMenus(); removeRecord(b.dataset.del); }; });
}

async function copyText(text) {
  if (!text) return toast('복사할 결과가 없어요');
  try { await navigator.clipboard.writeText(text); toast('복사했어요'); }
  catch { toast('복사하지 못했어요. 직접 드래그해서 복사해 주세요'); }
}

async function duplicate(id) {
  const src = records.find((r) => r.id === id);
  const { id: _, ...rest } = src;
  const data = { ...rest, title: src.title + ' (복사본)', createdAt: Date.now(), writtenAt: Date.now(), updatedAt: Date.now() };
  delete data.editedAt;
  const ref = await addDoc(userCol('records'), data);
  records.unshift({ id: ref.id, ...data });
  toast('복제했어요');
  location.hash = '#/r/' + ref.id;
}

// ---------- 여러 회기 한꺼번에 쓰기 ----------
const freeLabel = () => freeField('journal').label;
// "3회기 10월 3일 오후 4시" 같은 머리줄에서 회기 번호·날짜·시간을 읽음
const HEADER_RE = /^\s*[\[(#*\-•▶]*\s*(?:(\d{1,3})\s*회기|회기\s*(\d{1,3}))/;
function parseHeader(line) {
  const hm = line.match(HEADER_RE) || line.match(/(\d{1,3})\s*회기|회기\s*(\d{1,3})/);
  const n = hm ? +(hm[1] || hm[2]) : null;
  let rest = hm ? line.replace(hm[0], ' ') : line;
  const now = new Date();
  let y = null, mo = null, d = null, h = null, mi = 0;
  let m = rest.match(/(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?/);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; rest = rest.replace(m[0], ' '); }
  else if ((m = rest.match(/(?<![\d.])(\d{2})\.(\d{1,2})\.(\d{1,2})(?![\d.])/))) { y = 2000 + +m[1]; mo = +m[2]; d = +m[3]; rest = rest.replace(m[0], ' '); }   // 26.10.15 (서비스 날짜 형식)
  else if ((m = rest.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일?/) || rest.match(/(?<![\d:])(\d{1,2})\s*[/.]\s*(\d{1,2})(?![\d:])/))) {
    mo = +m[1]; d = +m[2]; rest = rest.replace(m[0], ' ');
  }
  const t = rest.match(/(오전|오후|AM|PM|am|pm)?\s*(\d{1,2})\s*(?:시|:)\s*(?:(\d{1,2})\s*분?)?/);
  if (t) {
    h = +t[2]; mi = +(t[3] || 0);
    const ap = (t[1] || '').toLowerCase();
    if ((ap === '오후' || ap === 'pm') && h < 12) h += 12;
    else if (!ap && h >= 1 && h <= 8) h += 12;   // 오전/오후 없이 1~8시면 오후로 봄 (미리보기에서 고칠 수 있음)
  }
  let ts = null;
  if (mo && d && mo <= 12 && d <= 31) {
    if (!y) { y = now.getFullYear(); if (new Date(y, mo - 1, d) - now > 30 * 864e5) y -= 1; }   // 연도 없으면 올해(미래면 작년)
    ts = new Date(y, mo - 1, d, h ?? 0, h != null ? mi : 0).getTime();
  }
  return { n, ts, hasTime: h != null };
}
function stampOf(ts, withTime) { return withTime ? fmtDate(ts) : fmtDay(ts); }
function sessionTitle(n, ts, hasTime) {
  return [n ? `${n}회기` : '', ts ? stampOf(ts, hasTime) : ''].filter(Boolean).join(' · ') || '상담일지';
}
function splitByRule(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out = []; let cur = null, before = 0;
  for (const line of lines) {
    if (HEADER_RE.test(line)) {
      const h = parseHeader(line);
      const extra = line.replace(HEADER_RE, '').replace(/(\d{4}\s*[.\-/년]\s*)?\d{1,2}\s*(월|[/.])\s*\d{1,2}\s*일?/, '').replace(/(오전|오후|AM|PM|am|pm)?\s*\d{1,2}\s*(시|:)\s*(\d{1,2}\s*분?)?/, '').replace(/^[\s,·:\-)\]]+/, '').trim();
      cur = { title: sessionTitle(h.n, h.ts, h.hasTime), body: extra ? [extra] : [] };
      out.push(cur);
    } else if (cur) cur.body.push(line);
    else if (line.trim()) before++;
  }
  return { sessions: out.map((s) => ({ title: s.title, content: s.body.join('\n').trim() })).filter((s) => s.content || s.title), before };
}
async function aiJSON(system, user, signal) {
  if (!models) models = await findModels(profile.geminiKey);
  let lastErr;
  for (const model of models.slice(0, 4)) {
    try {
      const res = await fetch(`${GEMINI}/models/${model}:generateContent`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': profile.geminiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
      });
      if (!res.ok) throw await apiError(res);
      const j = await res.json();
      const text = (j.candidates?.[0]?.content?.parts || []).filter((x) => !x.thought).map((x) => x.text || '').join('');
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      if (!(err.status === 429 || err.status === 404 || err.status === 503)) throw err;
    }
  }
  throw lastErr;
}
async function splitByAI(text, signal) {
  const arr = await aiJSON(
    '너는 상담 기록을 회기별로 나누는 도우미다. 반드시 JSON 배열만 출력한다.',
    `아래 글을 회기(상담 1회) 단위로 나눠라.\n- 각 항목: {"session": 회기 번호(숫자, 없으면 null), "date": "YYYY-MM-DD" 또는 null, "time": "HH:MM"(24시간) 또는 null, "content": 그 회기의 내용}\n- content는 원문 그대로 옮기고 요약하거나 고치지 마라. 머리줄(회기·날짜·시간)은 content에서 뺀다.\n- 연도가 없으면 ${new Date().getFullYear()}년으로 본다.\n\n[글]\n${text}`,
    signal,
  );
  return (Array.isArray(arr) ? arr : []).map((x) => {
    let ts = null;
    if (x.date && /^\d{4}-\d{2}-\d{2}$/.test(x.date)) {
      const [y, mo, d] = x.date.split('-').map(Number);
      const [h, mi] = (x.time && /^\d{1,2}:\d{2}$/.test(x.time) ? x.time : '0:0').split(':').map(Number);
      ts = new Date(y, mo - 1, d, h, mi).getTime();
    }
    return { title: sessionTitle(x.session, ts, !!x.time), content: String(x.content || '').trim() };
  }).filter((s) => s.content);
}
async function generateText(prompt, signal, onText = () => {}) {
  if (!models) models = await findModels(profile.geminiKey);
  let lastErr;
  for (const model of models.slice(0, 4)) {
    try {
      const r = await generate(model, prompt, signal, onText);
      if (!r.text) throw new Error('빈 답변이 돌아왔어요');
      return r.text;
    } catch (err) {
      lastErr = err;
      if (!(err.status === 429 || err.status === 404 || err.status === 503)) throw err;
    }
  }
  throw lastErr;
}

function renderBulk(host, clientId, { text, onBack, onSaved, excludeId, autoGen }) {
  const lensIds = prefs.lenses_journal || manifest.lenses.filter((l) => l.journal).map((l) => l.id);
  const lensNames = manifest.lenses.filter((l) => lensIds.includes(l.id)).map((l) => l.title);
  let sessions = [], busy = false, ctrl = null;
  const box = host;

  // 규칙으로 못 나눴을 때: AI로 나누기 제안
  const fallback = (msg) => {
    box.innerHTML = `
      <div class="error-box">${esc(msg)}</div>
      <p class="hint-line">각 회기 첫 줄을 <b>"N회기"</b>로 시작하면 바로 나눌 수 있어요. 형식이 제각각이면 AI가 나눠 드려요.</p>
      <div class="bulk-actions">
        <button class="btn ghost" id="iBack">돌아가서 고치기</button>
        <button class="btn" id="iAI">AI로 나누기</button>
      </div>`;
    box.querySelector('#iBack').onclick = onBack;
    box.querySelector('#iAI').onclick = () => runAISplit();
  };
  const runAISplit = async () => {
    if (!profile.geminiKey) { toast('AI로 나누려면 설정에서 AI 이용 키를 먼저 등록해 주세요'); return; }
    busy = true; ctrl = new AbortController();
    box.innerHTML = `<div class="status"><span class="spinner"></span>AI가 회기별로 나누고 있어요. 10~30초 정도 걸려요.</div>`;
    try {
      sessions = await splitByAI(text, ctrl.signal);
      busy = false;
      if (sessions.length < 2) return fallback('AI가 나눠봤지만 회기가 하나뿐이에요. 하나의 상담일지로 만들려면 돌아가서 [상담일지 생성]을 누르세요.');
      step2(0, true);
    } catch (err) { busy = false; fallback(friendlyError(err)); }
  };

  // 2단계: 미리보기·수정
  const step2 = (before, byAI) => {
    // 지금 쓰던 임시 기록은 제외
    const existing = clientRecords(clientId).filter((r) => r.type === 'journal' && r.id !== excludeId).map((r) => (r.title.match(/^(\d+)회기/) || [])[1]).filter(Boolean);
    box.innerHTML = `
      <div>
        <h3 class="bulk-title">${sessions.length}개 회기로 나눴어요</h3>
        <p class="sub">저장하지 않을 회기는 체크를 해제하세요.${byAI ? ' (AI가 나눈 결과예요)' : ''}</p>
        ${before ? `<p class="hint-line warn">첫 "N회기" 줄 앞에 있던 ${before}줄은 저장하지 않아요.</p>` : ''}
        <div class="imp-list">${sessions.map((s, i) => {
          const n = (s.title.match(/^(\d+)회기/) || [])[1];
          const dup = n && existing.includes(n);
          return `<div class="imp-row" data-i="${i}">
            <input type="checkbox" class="imp-check" ${dup ? '' : 'checked'} aria-label="이 회기 저장">
            <div class="imp-main">
              <input type="text" class="imp-title" value="${esc(s.title)}" aria-label="제목">
              <textarea class="imp-body" rows="3" aria-label="내용">${esc(s.content)}</textarea>
              ${dup ? `<p class="hint-line warn">이미 ${n}회기 기록이 있어서 체크를 해제했어요.</p>` : ''}
            </div>
            <span class="imp-status" aria-live="polite"></span>
          </div>`;
        }).join('')}</div>
        <label class="check modal-hist">
          <input type="checkbox" id="iAuto" ${profile.geminiKey ? (autoGen ? 'checked' : '') : 'disabled'}>
          <span>저장하고 상담일지 내용까지 AI로 생성
            <small>${profile.geminiKey ? `회기당 30초~1분 걸려요. 적용 이론: ${lensNames.length ? esc(lensNames.join(', ')) : '없음'} (마지막으로 고른 설정)` : '설정에서 AI 이용 키를 등록하면 쓸 수 있어요'}</small>
          </span>
        </label>
      </div>
      <div class="bulk-actions">
        <button class="btn ghost" id="iBack">돌아가서 고치기</button>
        <button class="btn" id="iGo"></button>
      </div>`;
    const rows = () => [...box.querySelectorAll('.imp-row')];
    const sync = () => {
      const n = rows().filter((r) => r.querySelector('.imp-check').checked).length;
      const auto = box.querySelector('#iAuto').checked;
      const go = box.querySelector('#iGo');
      go.disabled = !n;
      go.textContent = n ? (auto ? `상담일지 ${n}개 저장하고 내용까지 생성` : `상담일지 ${n}개로 저장`) : '저장할 회기를 선택하세요';
    };
    box.querySelector('.imp-list').onchange = sync;
    box.querySelector('#iAuto').onchange = sync;
    box.querySelector('#iBack').onclick = onBack;
    box.querySelector('#iGo').onclick = () => doImport();
    sync();
  };

  // 3단계: 저장 (+ 일지 생성)
  const doImport = async () => {
    const auto = box.querySelector('#iAuto').checked;
    const picked = [...box.querySelectorAll('.imp-row')].filter((r) => r.querySelector('.imp-check').checked).map((r) => {
      const title = r.querySelector('.imp-title').value.trim() || '상담일지';
      const h = parseHeader(title);
      return { row: r, title, content: r.querySelector('.imp-body').value.trim(), ts: h.ts };
    });
    busy = true; ctrl = new AbortController();
    box.querySelectorAll('input, textarea').forEach((x) => (x.disabled = true));
    box.querySelector('.bulk-actions').innerHTML = `<span class="sub" id="iProg" style="margin:0 auto 0 0"></span><button class="btn ghost" id="iStop">${auto ? '중단' : ''}</button>`;
    const stop = box.querySelector('#iStop'); if (!auto) stop.remove(); else stop.onclick = () => ctrl.abort();
    const prog = (t) => { box.querySelector('#iProg').textContent = t; };
    const created = [];
    // 오래된 회기부터 저장해야 이전 기록 참고가 순서대로 됨
    picked.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    try {
      for (const [i, s] of picked.entries()) {
        prog(`기록 저장 중… ${i + 1}/${picked.length}`);
        const t0 = Date.now() + i;   // 작성 시각 (상담일은 제목에 들어 있음). 같은 순간이라도 순서가 유지되게 1ms씩
        const data = { writtenAt: t0, clientId, type: 'journal', title: s.title, inputs: { [freeLabel()]: s.content }, mode: 'sentence', lenses: lensIds, useHistory: true, result: '', createdAt: t0, updatedAt: Date.now() };
        const ref = await addDoc(userCol('records'), data);
        records.unshift({ id: ref.id, ...data });
        created.push({ id: ref.id, ...data, row: s.row });
        s.row.querySelector('.imp-status').textContent = auto ? '대기' : '✓ 저장';
      }
      renderNav();
      if (auto) {
        let ok = 0;
        for (const [i, r] of created.entries()) {
          if (ctrl.signal.aborted) break;
          const st = r.row.querySelector('.imp-status');
          st.innerHTML = '<span class="spinner"></span>'; prog(`상담일지 만드는 중… ${i + 1}/${created.length}`);
          let tries = 0;
          for (;;) {
            try {
              const text = await generateText(buildPrompt(r), ctrl.signal);
              await updateDoc(userDoc('records', r.id), { result: text, updatedAt: Date.now() });
              Object.assign(records.find((x) => x.id === r.id), { result: text, updatedAt: Date.now() });
              st.textContent = '✓ 완료'; ok++;
              break;
            } catch (err) {
              if (err.name === 'AbortError') { st.textContent = '중단'; break; }
              if (err.status === 429 && tries++ < 2) { prog('무료 사용량 제한으로 30초 기다렸다가 이어서 만들어요…'); await new Promise((res) => setTimeout(res, 30000)); continue; }
              st.textContent = '실패'; st.title = friendlyError(err);
              break;
            }
          }
        }
        prog(`상담일지 ${created.length}개를 저장하고, ${ok}개의 내용을 만들었어요.` + (ok < created.length ? ' 못 만든 회기는 열어서 [상담일지 생성]을 눌러주세요.' : ''));
      } else prog(`상담일지 ${created.length}개를 저장했어요.`);
    } catch (err) {
      prog('저장하지 못했어요: ' + friendlyError(err));
    }
    busy = false;
    box.querySelector('.bulk-actions').insertAdjacentHTML('beforeend', '<button class="btn" id="iDone">내담자 화면으로</button>');
    box.querySelector('#iStop')?.remove();
    box.querySelector('#iDone').onclick = () => { location.hash = '#/c/' + clientId; };
    await onSaved?.();
    box.querySelector('#iDone').focus();
  };

  const r = splitByRule(text.trim());
  if (r.sessions.length >= 2) { sessions = r.sessions; step2(r.before); }
  else fallback('"N회기"로 시작하는 줄을 두 개 이상 찾지 못했어요.');
}

// ---------- 관리자: 사용자 화면 그대로 보기 (읽기 전용) ----------
// 헤더를 뺀 왼쪽 메뉴·본문 전체를 그 사용자의 데이터로 바꿔서 보여줌. 쓰기 버튼은 body.viewas 로 숨김(보안 규칙에서도 쓰기 차단).
let viewAs = null, ownData = null;
async function enterViewAs(uid) {
  view.main = '<div class="status"><span class="spinner"></span>불러오는 중…</div>';
  try {
    const data = adminCache[uid] || (adminCache[uid] = await loadUserData(uid));
    const u = await getDoc(doc(db, 'users', uid));
    if (!ownData) ownData = { clients, records };
    clients = data.clients; records = data.records;
    viewAs = { uid, email: u.exists() ? u.data().email || uid : uid };
    navToggled.clear();
    document.body.classList.add('viewas');
    $('#viewasName').textContent = viewAs.email;
    $('#viewasBadge').hidden = false;
    setHashSilently('#/');
    route();
  } catch (err) {
    view.main = `<div class="error-box">불러오지 못했어요. (${esc(err.message)})</div>`;
  }
}
function exitViewAs() {
  if (!viewAs) return;
  clients = ownData.clients; records = ownData.records;
  viewAs = null; ownData = null;
  navToggled.clear();
  document.body.classList.remove('viewas');
  $('#viewasBadge').hidden = true;
}
$('#viewasExit').onclick = () => { exitViewAs(); location.hash = '#/admin'; if (location.hash === '#/admin') route(); };

// ---------- 관리자 (읽기 전용) ----------
const adminCache = {};
async function loadUserData(uid) {
  const [cs, rs] = await Promise.all([
    getDocs(collection(db, 'users', uid, 'clients')),
    getDocs(collection(db, 'users', uid, 'records')),
  ]);
  return {
    // 휴지통에 있는 것은 관리자 집계·화면에서 제외
    clients: cs.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => !c.deletedAt).sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    records: rs.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => !r.deletedAt).sort((a, b) => writtenOf(b) - writtenOf(a)),
  };
}
const pct = (n, total) => (total ? Math.round((n / total) * 100) + '%' : '-');
async function viewAdmin(uid) {
  const main = $('#main');
  view.main = '<div class="status"><span class="spinner"></span>불러오는 중…</div>';
  try {
    if (!uid) {
      const us = await getDocs(collection(db, 'users'));
      const rows = await Promise.all(us.docs.map(async (d) => {
        const data = adminCache[d.id] = await loadUserData(d.id);
        return { uid: d.id, email: d.data().email || '(이메일 없음)', lastSeenAt: d.data().lastSeenAt, ...data };
      }));
      rows.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
      view.main = `
        <div class="page-head"><h2>관리자</h2></div>
        ${adminTabs('users')}
        <p class="sub">사용자를 누르면 그 사람의 화면을 읽기 전용으로 볼 수 있어요.</p>
        <div class="table-wrap"><table class="admin-table">
          <thead><tr><th>사용자</th><th>내담자</th><th>상담일지</th><th>사례 분석</th><th>문장으로 쓰기</th><th>결과 생성</th><th>마지막 접속</th></tr></thead>
          <tbody>${rows.map((r) => {
            const j = r.records.filter((x) => x.type === 'journal').length;
            const sent = r.records.filter((x) => x.mode === 'sentence').length;
            const gen = r.records.filter((x) => x.result).length;
            return `<tr data-uid="${r.uid}">
              <td><a href="#/admin/${r.uid}">${esc(r.email)}</a></td>
              <td>${r.clients.length}</td><td>${j}</td><td>${r.records.length - j}</td>
              <td>${pct(sent, r.records.length)}</td><td>${pct(gen, r.records.length)}</td>
              <td>${r.lastSeenAt ? fmtDate(r.lastSeenAt) : '-'}</td></tr>`;
          }).join('')}</tbody>
        </table></div>`;
      return;
    }
    const data = adminCache[uid] || (adminCache[uid] = await loadUserData(uid));
    const u = await getDoc(doc(db, 'users', uid));
    const email = u.exists() ? u.data().email : uid;
    const byClient = (cid) => data.records.filter((r) => r.clientId === cid);
    const recHTML = (r) => {
      const inputs = Object.entries(r.inputs || {}).filter(([, v]) => (v || '').trim());
      return `<details class="admin-rec">
        <summary><span class="ktype">${SHORT_TYPE[r.type]}</span><b>${esc(r.title || '')}</b>
          <span class="sub" style="margin:0">${recDate(r)} · ${MODES[r.mode] || '방식 기록 없음'}${r.result ? '' : ' · 결과 없음'}</span></summary>
        <div class="admin-rec-body">
          <h4>입력한 내용</h4>
          ${inputs.length ? inputs.map(([k, v]) => `<div class="read-field"><div class="read-label">${esc(k)}</div><div class="read-value">${esc(v)}</div></div>`).join('') : '<p class="sub">없음</p>'}
          ${r.lenses?.length ? `<p class="sub" style="margin:10px 0 0">적용 이론: ${esc(manifest.lenses.filter((l) => r.lenses.includes(l.id)).map((l) => l.title).join(', '))}${r.useHistory ? ' · 이전 기록 참고' : ''}</p>` : ''}
          ${r.result ? `<h4>결과</h4><div class="result">${DOMPurify.sanitize(marked.parse(r.result))}</div>` : ''}
        </div>
      </details>`;
    };
    view.main = `
      <a class="back" href="#/admin">${ic('back', 14)}관리자</a>
      <div class="page-head"><h2>${esc(email)}</h2><button class="btn ghost h32" id="adminRefresh">새로고침</button></div>
      <p class="sub">읽기 전용 · 내담자 ${data.clients.length}명 · 기록 ${data.records.length}건</p>
      ${data.clients.map((c) => `
        <div class="card admin-client">
          <h3>${esc(c.name)} <span class="sub" style="margin:0">기록 ${byClient(c.id).length}건</span></h3>
          ${profileText(c) ? `<p class="sub" style="white-space:pre-wrap">${esc(profileText(c))}</p>` : ''}
          ${byClient(c.id).map(recHTML).join('') || '<p class="sub">기록 없음</p>'}
        </div>`).join('') || '<div class="card empty"><b>아직 내담자가 없어요</b></div>'}`;
    $('#adminRefresh').onclick = () => { delete adminCache[uid]; viewAdmin(uid); };
  } catch (err) {
    view.main = `<div class="error-box">불러오지 못했어요. Firebase 보안 규칙에 관리자 권한이 적용됐는지 확인해 주세요. (${esc(err.message)})</div>`;
  }
}

// ---------- 의견 보내기 ----------
// 사용자는 내용 한 칸만 쓰고, 보낸 사람·시각·화면·기기는 자동으로 붙임. 상담 내용은 담지 않음(화면 이름만).
const FB_TYPES = { bug: '불편해요', request: '이런 기능 있으면', etc: '기타' };
const FB_STATUS = { new: '새로 옴', seen: '확인', done: '반영' };
let fbDraft = { type: null, text: '' };   // 창을 닫아도 쓰던 내용 유지
let feedback = [];                         // 관리자용
function screenLabel() {
  const [, page, a, b] = (location.hash || '#/').split('/');
  if (page === 'c') return `${clientName(a)} · 내담자 화면`;
  if (page === 'r') { const r = records.find((x) => x.id === a); return r ? `${clientName(r.clientId)} · ${TYPE[r.type]} 기록 화면` : '기록 화면'; }
  if (page === 'new') return `${clientName(a)} · 새 ${TYPE[b] || '기록'} 작성`;
  return { trash: '휴지통', settings: '설정', admin: '관리자' }[page] || '전체 기록';
}
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? '아이폰' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? '아이패드' : /Android/.test(ua) ? '안드로이드' : /Mac/.test(ua) ? '맥' : /Windows/.test(ua) ? '윈도우' : '기타';
  const br = /SamsungBrowser/.test(ua) ? '삼성 인터넷' : /Edg\//.test(ua) ? '엣지' : /Whale/.test(ua) ? '웨일' : /KAKAOTALK/.test(ua) ? '카카오톡' : /Chrome|CriOS/.test(ua) ? '크롬' : /Firefox|FxiOS/.test(ua) ? '파이어폭스' : /Safari/.test(ua) ? '사파리' : '기타';
  return `${os} ${br} · 화면 폭 ${window.innerWidth}px`;
}
function openFeedback() {
  const opener = document.activeElement;
  const screen = screenLabel(), device = deviceLabel(), hash = location.hash || '#/';
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="fbTitle">
      <div class="modal-body">
        <h3 id="fbTitle">농지에게 의견 보내기</h3>
        <p class="sub">불편한 점이나 있었으면 하는 기능을 편하게 적어주세요.</p>
        <div class="fb-chips" role="group" aria-label="종류 (선택)">${Object.entries(FB_TYPES).map(([k, v]) => `<button type="button" class="fb-chip" data-type="${k}" aria-pressed="${fbDraft.type === k}">${v}</button>`).join('')}</div>
        <textarea class="fb-input" id="fbText" maxlength="2000" aria-label="의견 내용" placeholder="예) 결과 만들기를 누르면 너무 오래 걸려요">${esc(fbDraft.text)}</textarea>
        <p class="fb-warn">내담자 실명이나 상담 내용은 적지 마세요.</p>
        <p class="fb-ctx">함께 전달돼요: ${esc(screen)} · ${esc(device)}</p>
        <p class="field-error" id="fbErr" hidden></p>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" data-cancel>닫기</button>
        <button class="btn" data-ok disabled>보내기</button>
      </div>
    </div>`;
  document.body.appendChild(back);
  const ta = back.querySelector('#fbText'), ok = back.querySelector('[data-ok]'), err = back.querySelector('#fbErr');
  const sync = () => { fbDraft.text = ta.value; ok.disabled = !ta.value.trim(); };
  const done = () => { document.removeEventListener('keydown', onKey); back.remove(); opener?.focus?.(); };
  const onKey = (ev) => { if (ev.key === 'Escape') done(); };
  document.addEventListener('keydown', onKey);
  ta.oninput = sync;
  back.querySelectorAll('.fb-chip').forEach((c) => {
    c.onclick = () => {
      fbDraft.type = fbDraft.type === c.dataset.type ? null : c.dataset.type;   // 다시 누르면 해제
      back.querySelectorAll('.fb-chip').forEach((x) => x.setAttribute('aria-pressed', x.dataset.type === fbDraft.type));
    };
  });
  back.querySelector('[data-cancel]').onclick = done;
  back.onclick = (ev) => { if (ev.target === back) done(); };
  ok.onclick = async () => {
    ok.disabled = true; ok.textContent = '보내는 중…'; err.hidden = true;
    try {
      await addDoc(collection(db, 'feedback'), {
        uid: user.uid, email: user.email || '', type: fbDraft.type, text: ta.value.trim().slice(0, 2000),
        screen, hash, device, status: 'new', createdAt: Date.now(),
      });
      fbDraft = { type: null, text: '' };
      done(); toast('보냈어요. 고마워요!');
    } catch {
      err.textContent = '보내지 못했어요. 잠시 후 다시 시도해 주세요. 쓴 내용은 그대로 남아 있어요.'; err.hidden = false;
      ok.textContent = '다시 보내기'; ok.disabled = false;
    }
  };
  sync();
  ta.focus();
}
$('#fbBtn').onclick = openFeedback;

// ---------- 관리자: 의견함 ----------
function adminTabs(on) {
  const n = feedback.filter((f) => f.status === 'new').length;
  return `<div class="seg" role="tablist" aria-label="관리자 메뉴">
    <a role="tab" class="seg-btn ${on === 'users' ? 'on' : ''}" aria-selected="${on === 'users'}" href="#/admin" style="display:inline-flex;align-items:center;text-decoration:none">사용자</a>
    <a role="tab" class="seg-btn ${on === 'feedback' ? 'on' : ''}" aria-selected="${on === 'feedback'}" href="#/admin/feedback" style="display:inline-flex;align-items:center;text-decoration:none">의견${n ? `<span class="fb-badge">${n}</span>` : ''}</a>
  </div>`;
}
function updateFbBadge() {
  const n = feedback.filter((f) => f.status === 'new').length;
  const b = $('#fbBadge'); b.hidden = !n; b.textContent = n;
}
async function loadFeedback() {
  const s = await getDocs(collection(db, 'feedback'));
  feedback = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => writtenOf(b) - writtenOf(a));
  updateFbBadge();
}
async function viewFeedback() {
  const main = $('#main');
  view.main = '<div class="status"><span class="spinner"></span>불러오는 중…</div>';
  try { await loadFeedback(); } catch (e) {
    view.main = `<div class="page-head"><h2>관리자</h2></div>${adminTabs('feedback')}<div class="error-box">의견을 불러오지 못했어요. Firebase 콘솔에 새 보안 규칙(firestore.rules)을 게시했는지 확인해 주세요. (${esc(e.message)})</div>`;
    return;
  }
  const render = () => {
    view.main = `
      <div class="page-head"><h2>관리자</h2><button class="btn ghost h32" id="fbRefresh">새로고침</button></div>
      ${adminTabs('feedback')}
      <p class="sub">새 의견이 위에 보여요.</p>
      ${feedback.length ? `<div class="list">${feedback.slice().sort((a, b) => (a.status === 'new' ? 0 : 1) - (b.status === 'new' ? 0 : 1) || b.createdAt - a.createdAt).map((f) => `
        <div class="item fb-item ${f.status === 'new' ? 'is-new' : ''}">
          <div class="item-body">
            <div class="item-title">${f.type ? `<span class="tag fb-${f.type}">${FB_TYPES[f.type]}</span>` : ''}${esc(f.email)}</div>
            <div class="item-meta">${fmtDate(f.createdAt)} · ${esc(f.screen || '')} · ${esc(f.device || '')}</div>
            <div class="fb-text">${esc(f.text)}</div>
          </div>
          <select data-fb="${f.id}" aria-label="처리 상태">${Object.entries(FB_STATUS).map(([k, v]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>`).join('')}</div>` : '<div class="card empty"><b>아직 받은 의견이 없어요</b>사용자가 상단 [농지에게 의견 보내기]로 보내면 여기에 쌓여요.</div>'}`;
    $('#fbRefresh').onclick = () => viewFeedback();
    main.querySelectorAll('[data-fb]').forEach((s) => {
      s.onchange = async () => {
        const f = feedback.find((x) => x.id === s.dataset.fb), prev = f.status;
        f.status = s.value;
        try { await updateDoc(doc(db, 'feedback', f.id), { status: f.status, updatedAt: Date.now() }); toast(`'${FB_STATUS[f.status]}'으로 바꿨어요`); }
        catch { f.status = prev; toast('바꾸지 못했어요. 인터넷 연결을 확인해 주세요.'); }
        updateFbBadge(); render(); main.querySelector(`[data-fb="${f.id}"]`)?.focus();
      };
    });
  };
  render();
}

// ---------- 기록 내보내기 ----------
function exportRecords(kind) {
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  let body, type;
  if (kind === 'json') {
    body = JSON.stringify({ exportedAt: new Date().toISOString(), clients, records }, null, 2);
    type = 'application/json';
  } else {
    const line = '='.repeat(40);
    body = `농지니 기록 · ${nowStamp()} 내보냄\n내담자 ${clients.length}명 · 기록 ${records.length}건\n`;
    clients.forEach((c) => {
      body += `\n${line}\n[내담자] ${c.name}\n${profileText(c) ? profileText(c) + '\n' : ''}${line}\n`;
      clientRecords(c.id).slice().sort((a, b) => chronoOf(a) - chronoOf(b)).forEach((r) => {   // 상담 흐름 순서
        body += `\n▶ [${TYPE[r.type]}] ${r.title} (${recDate(r)})\n\n■ 입력 내용\n`;
        Object.entries(r.inputs || {}).filter(([, v]) => (v || '').trim()).forEach(([k, v]) => { body += `- ${k}: ${v.trim()}\n`; });
        body += `\n■ 결과\n${(r.result || '(아직 결과 없음)').trim()}\n\n${'-'.repeat(40)}\n`;
      });
    });
    type = 'text/plain';
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: type + ';charset=utf-8' }));
  a.download = `농지니_기록_${stamp}.${kind}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('파일을 저장했어요');
}

// 일반 확인 모달
function confirmModal({ title, message, okLabel = '확인', cancelLabel = '취소', danger = false }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal modal-sm" role="alertdialog" aria-modal="true" aria-labelledby="cTitle" aria-describedby="cMsg">
        <div class="modal-body"><h3 id="cTitle">${esc(title)}</h3><p class="sub" id="cMsg" style="margin:0">${esc(message)}</p></div>
        <div class="modal-actions">
          <button class="btn ghost" data-cancel>${esc(cancelLabel)}</button>
          <button class="btn ${danger ? 'btn-delete' : ''}" data-ok>${esc(okLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const done = (v) => { document.removeEventListener('keydown', onKey); back.remove(); opener?.focus?.(); resolve(v); };
    const onKey = (ev) => { if (ev.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
    back.querySelector('[data-ok]').onclick = () => done(true);
    back.querySelector('[data-cancel]').onclick = () => done(false);
    back.onclick = (ev) => { if (ev.target === back) done(null); };
    back.querySelector('[data-cancel]').focus();
  });
}

// 삭제 확인 모달: 입력칸에 "삭제"를 적어야 삭제 버튼이 눌림
function confirmDelete(title, message) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal modal-sm" role="alertdialog" aria-modal="true" aria-labelledby="dTitle" aria-describedby="dMsg">
        <div class="modal-body">
          <h3 id="dTitle">${esc(title)}</h3>
          <p class="sub" id="dMsg">${esc(message)}<br><b>삭제하면 되돌릴 수 없어요.</b></p>
          <label class="field" style="margin:0">
            <span class="del-label">확인을 위해 아래 칸에 <b>삭제</b>라고 입력해 주세요.</span>
            <input type="text" id="dInput" autocomplete="off" aria-label="삭제라고 입력">
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" data-cancel>취소</button>
          <button class="btn btn-delete" data-ok disabled>삭제</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const input = back.querySelector('#dInput');
    const ok = back.querySelector('[data-ok]');
    const done = (v) => { document.removeEventListener('keydown', onKey); back.remove(); opener?.focus?.(); resolve(v); };
    const onKey = (ev) => { if (ev.key === 'Escape') done(false); };
    document.addEventListener('keydown', onKey);
    input.oninput = () => { ok.disabled = input.value.trim() !== '삭제'; };
    // 한글 입력 시 Enter가 글자 조합 확정에 쓰여 keydown이 무시될 수 있어 keyup에서 값으로 직접 확인
    input.onkeyup = (ev) => {
      if (ev.key !== 'Enter' || ev.isComposing) return;
      ok.disabled = input.value.trim() !== '삭제';
      if (!ok.disabled) done(true);
    };
    ok.onclick = () => done(true);
    back.querySelector('[data-cancel]').onclick = () => done(false);
    back.onclick = (ev) => { if (ev.target === back) done(false); };
    input.focus();
  });
}

// 기록 삭제: 바로 지우지 않고 휴지통으로 (되돌리기 알림 + 30일 보관)
async function removeRecord(id) {
  const r = records.find((x) => x.id === id);
  if (editor) editor.dirty = false;
  clearTimeout(autoT);
  if (!(await trashRecords([id], false))) return;
  if (location.hash === '#/r/' + id) location.hash = '#/c/' + r.clientId;
  else route();
}
async function trashRecords(ids, reroute = true) {
  const now = Date.now();
  try {
    await commitOps(ids.map((id) => (b) => b.update(userDoc('records', id), { deletedAt: now })));
  } catch { toast('삭제하지 못했어요. 인터넷 연결을 확인해 주세요.'); return false; }
  const moved = records.filter((r) => ids.includes(r.id));
  moved.forEach((r) => (r.deletedAt = now));
  records = records.filter((r) => !ids.includes(r.id)); trash.push(...moved);
  if (reroute) route();
  toastAction(`${ids.length > 1 ? ids.length + '건을' : '기록을'} 휴지통으로 옮겼어요`, '되돌리기', async () => {
    await restoreItems(moved.map((r) => ({ kind: 'record', id: r.id, item: r, clientId: r.clientId })));
    toast('되돌렸어요'); route();
  });
  return true;
}

// ---------- 휴지통 ----------
const trashKey = (x) => x.kind + ':' + x.id;
function trashRows() {
  const rows = trash.map((r) => ({ kind: 'record', id: r.id, item: r, clientId: r.clientId, deletedAt: r.deletedAt }));
  trashClients.forEach((c) => rows.push({ kind: 'client', id: c.id, item: c, clientId: c.id, deletedAt: c.deletedAt }));
  // 최근 삭제순, 같은 시각에 지운 것은 내담자 행이 먼저
  return rows.sort((a, b) => b.deletedAt - a.deletedAt || (a.kind === 'client' ? -1 : b.kind === 'client' ? 1 : 0));
}
const anyClientName = (id) => (clients.find((c) => c.id === id) || trashClients.find((c) => c.id === id))?.name || '(알 수 없음)';
// 내담자와 함께 삭제된 기록 = 같은 시각에 휴지통으로 간 그 내담자의 기록
const codeleted = (c) => trash.filter((r) => r.clientId === c.id && r.deletedAt === c.deletedAt);

// 복구: 기록을 살리면 내담자도 휴지통에 있을 때 함께 살림 / 내담자를 살리면 함께 삭제된 기록도 살림
async function restoreItems(rows) {
  const recIds = new Set(), cliIds = new Set();
  rows.forEach((x) => {
    if (x.kind === 'record') { recIds.add(x.id); if (trashClients.some((c) => c.id === x.clientId)) cliIds.add(x.clientId); }
    else { cliIds.add(x.id); codeleted(x.item).forEach((r) => recIds.add(r.id)); }
  });
  await commitOps([
    ...[...recIds].map((id) => (b) => b.update(userDoc('records', id), { deletedAt: deleteField() })),
    ...[...cliIds].map((id) => (b) => b.update(userDoc('clients', id), { deletedAt: deleteField() })),
  ]);
  trash.filter((r) => recIds.has(r.id)).forEach((r) => { delete r.deletedAt; records.push(r); });
  trash = trash.filter((r) => !recIds.has(r.id));
  trashClients.filter((c) => cliIds.has(c.id)).forEach((c) => { delete c.deletedAt; clients.push(c); });
  trashClients = trashClients.filter((c) => !cliIds.has(c.id));
  records.sort((a, b) => writtenOf(b) - writtenOf(a));
  clients.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return recIds.size + cliIds.size;
}
// 영구 삭제: 내담자를 지우면 휴지통에 남은 그 내담자의 기록도 함께
async function purgeItems(rows) {
  const recIds = new Set(), cliIds = new Set();
  rows.forEach((x) => {
    if (x.kind === 'record') recIds.add(x.id);
    else { cliIds.add(x.id); trash.filter((r) => r.clientId === x.id).forEach((r) => recIds.add(r.id)); }
  });
  await commitOps([
    ...[...recIds].map((id) => (b) => b.delete(userDoc('records', id))),
    ...[...cliIds].map((id) => (b) => b.delete(userDoc('clients', id))),
  ]);
  trash = trash.filter((r) => !recIds.has(r.id));
  trashClients = trashClients.filter((c) => !cliIds.has(c.id));
}

let trashSel = new Set(), trashFilter = '';
function viewTrash() {
  const all = trashRows();
  if (trashFilter && !all.some((x) => x.clientId === trashFilter)) trashFilter = '';
  const rows = trashFilter ? all.filter((x) => x.clientId === trashFilter) : all;
  trashSel = new Set([...trashSel].filter((k) => rows.some((x) => trashKey(x) === k)));
  const n = trashSel.size;
  const names = [...new Set(all.map((x) => x.clientId))].map((id) => [id, anyClientName(id)]).sort((a, b) => a[1].localeCompare(b[1], 'ko'));
  const left = (x) => Math.max(0, Math.ceil((x.deletedAt + TRASH_DAYS * 864e5 - Date.now()) / 864e5));
  view.main = `
    <div class="page-head" style="align-items:center">
      <h2>휴지통</h2>
      ${all.length ? '<div class="row"><button class="btn ghost h32" id="tRestoreAll">모두 복구</button><button class="btn danger h32" id="tEmpty">휴지통 비우기</button></div>' : ''}
    </div>
    <p class="sub">${TRASH_DAYS}일이 지나면 자동으로 영구 삭제돼요.</p>
    ${all.length ? `
    <div class="list-bar${n ? ' active' : ''}">
      <label class="bar-check">
        <input type="checkbox" id="tAll" ${n && n === rows.length ? 'checked' : ''} data-mixed="${n && n < rows.length ? 1 : 0}" aria-label="${n && n === rows.length ? '전체 해제' : '전체 선택'}">
        <span>총 ${rows.length}건</span>
      </label>
      ${n ? `<div class="row bar-actions">
        <span class="bar-count" aria-live="polite"><b>${n}</b>건 선택</span>
        <button class="btn h32" id="tRestore">복구</button>
        <button class="btn danger h32" id="tPurge">영구 삭제</button>
        <button class="btn ghost h32" id="tCancel">취소</button>
      </div>` : names.length > 1 ? `<label class="sort-wrap"><span class="sr-only">내담자로 거르기</span><select id="tFilter" class="sort-select"><option value="">모든 내담자</option>${names.map(([id, nm]) => `<option value="${id}" ${id === trashFilter ? 'selected' : ''}>${esc(nm)}</option>`).join('')}</select></label>` : ''}
    </div>
    <div class="list">${rows.map((x) => {
      const k = trashKey(x), isC = x.kind === 'client', on = trashSel.has(k), kind = isC ? 'client' : x.item.type;
      const name = isC ? x.item.name : x.item.title;
      const info = isC ? `기록 ${codeleted(x.item).length}건과 함께 삭제`
        : `${anyClientName(x.clientId)}${trashClients.some((c) => c.id === x.clientId) ? ' (삭제된 내담자)' : ''} · ${sessionOf(x.item) ? '상담 ' + fmtDay(sessionOf(x.item)) : '작성 ' + fmtDay(writtenOf(x.item))}`;
      return `
      <div class="item trash-item${on ? ' picked' : ''}" data-tkey="${k}">
        <button type="button" class="thumb ${kind}" data-tpick="${k}" aria-pressed="${on}" aria-label="${esc(name)} 선택">
          <span class="thumb-icon">${ICON[kind] || ICON.journal}</span><span class="thumb-check">${ICON.check}</span>
        </button>
        <div class="item-body">
          <div class="item-title">
            <span class="it-name">${esc(name)}</span>
            <span class="it-date" title="삭제한 날">${fmtDay(x.deletedAt)} 삭제</span>
            <span class="it-state left">${left(x)}일 남음</span>
          </div>
          <div class="item-line"><b>${isC ? '내담자' : SHORT_TYPE[x.item.type]}</b><span class="it-preview">${esc(info)}</span></div>
        </div>
        <div class="more">
          <button class="more-btn" data-more aria-haspopup="menu" aria-expanded="false" aria-label="휴지통 항목 메뉴">${ic('more', 18)}</button>
          <div class="more-menu right" role="menu" hidden>
            <button role="menuitem" data-trestore="${k}">복구</button>
            <button role="menuitem" class="danger" data-tpurge="${k}">영구 삭제</button>
          </div>
        </div>
      </div>`;
    }).join('')}</div>` : `
    <div class="card empty"><b>휴지통이 비어 있어요</b>기록이나 내담자를 삭제하면 여기에 ${TRASH_DAYS}일 동안 보관돼요.</div>`}`;

  const byKey = (k) => rows.find((x) => trashKey(x) === k);
  const done = (msg) => { trashSel.clear(); viewTrash(); renderNav(); toast(msg); };
  const restore = async (list) => {
    try { const cnt = await restoreItems(list); done(`${cnt}건을 복구했어요`); }
    catch { toast('복구하지 못했어요. 인터넷 연결을 확인해 주세요.'); }
  };
  const purge = async (list, title) => {
    if (!(await confirmDelete(title, `${list.length}건을 영구 삭제해요.`))) return;
    try { await purgeItems(list); done('영구 삭제했어요'); }
    catch { toast('삭제하지 못했어요. 인터넷 연결을 확인해 주세요.'); }
  };
  const toggle = (k) => { trashSel.has(k) ? trashSel.delete(k) : trashSel.add(k); viewTrash(); $(`[data-tpick="${k}"]`)?.focus(); };
  // 카드를 누르면 고르기 (휴지통 항목은 열어볼 화면이 없음)
  $('#main').querySelectorAll('[data-tkey]').forEach((el) => {
    el.onclick = (e) => { if (e.target.closest('.thumb, .more, button')) return; toggle(el.dataset.tkey); };
  });
  $('#main').querySelectorAll('[data-tpick]').forEach((b) => { b.onclick = () => toggle(b.dataset.tpick); });
  $('#main').querySelectorAll('.trash-item [data-more]').forEach((b) => { b.onclick = () => toggleMenu(b); });
  $('#main').querySelectorAll('[data-trestore]').forEach((b) => { b.onclick = () => { closeMenus(); restore([byKey(b.dataset.trestore)]); }; });
  $('#main').querySelectorAll('[data-tpurge]').forEach((b) => { b.onclick = () => { closeMenus(); purge([byKey(b.dataset.tpurge)], '영구 삭제'); }; });
  const box = $('#tAll'); if (box) box.indeterminate = box.dataset.mixed === '1';
  on('#tAll', 'change', () => { trashSel = new Set(trashSel.size === rows.length ? [] : rows.map(trashKey)); viewTrash(); $('#tAll')?.focus(); });
  on('#tCancel', 'click', () => { trashSel.clear(); viewTrash(); $('#tAll')?.focus(); });
  on('#tFilter', 'change', (e) => { trashFilter = e.target.value; trashSel.clear(); viewTrash(); $('#tFilter')?.focus(); });
  on('#tRestore', 'click', () => restore(rows.filter((x) => trashSel.has(trashKey(x)))));
  on('#tPurge', 'click', () => purge(rows.filter((x) => trashSel.has(trashKey(x))), '영구 삭제'));
  on('#tRestoreAll', 'click', () => restore(all));
  on('#tEmpty', 'click', () => purge(all, '휴지통 비우기'));
}

// ---------- 고른 기록 결과 한꺼번에 만들기 ----------
function openBatchRun(list) {
  if (!list.length) return;
  if (batch && !batch.done) { toast('지금 결과를 만드는 중이에요. 끝난 뒤에 다시 시도해 주세요'); openBatchModal(); return; }
  if (!profile.geminiKey) { toast('먼저 설정에서 AI 이용 키를 등록해 주세요'); location.hash = '#/settings'; return; }
  const opener = document.activeElement;
  const had = list.filter((r) => r.result).length;
  const defLenses = prefs.lenses_journal || manifest.lenses.filter((l) => l.journal).map((l) => l.id);
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="bTitle">
      <div class="modal-body" id="bBody">
        <h3 id="bTitle">고른 기록 ${list.length}건 결과 만들기</h3>
        <p class="sub">고른 기록 모두에 같은 이론을 적용해요.</p>
        <div class="row" style="margin:-4px 0 6px"><button class="link-btn" data-all>모두 선택</button><button class="link-btn" data-none>모두 해제</button></div>
        <div id="bLenses">${manifest.lenses.map((l) => `
          <label class="lens">
            <input type="checkbox" value="${l.id}" ${defLenses.includes(l.id) ? 'checked' : ''}>
            <span><span class="num">${l.id.slice(0, 2)}</span> <span class="t">${esc(l.title)}</span><div class="d">${esc(l.desc)}</div></span>
          </label>`).join('')}</div>
        <label class="check modal-hist">
          <input type="checkbox" id="bHistory" checked>
          <span>이전 기록 참고하기
            <small>기록마다 앞선 기록 최대 ${HISTORY_COUNT}건을 함께 참고해요.</small>
          </span>
        </label>
        ${had ? `<label class="check modal-hist">
          <input type="checkbox" id="bSkip" checked>
          <span>이미 결과가 있는 ${had}건은 건너뛰기
            <small>해제하면 지금 결과가 새 결과로 바뀌어요</small>
          </span>
        </label>` : ''}
        <p class="modal-note" id="bEta"></p>
      </div>
      <div class="modal-actions" id="bActions">
        <button class="btn ghost" data-cancel>취소</button>
        <button class="btn" data-go></button>
      </div>
    </div>`;
  document.body.appendChild(back);
  const boxes = () => [...back.querySelectorAll('#bLenses input')];
  const goBtn = back.querySelector('[data-go]');
  const targets = () => (back.querySelector('#bSkip')?.checked ? list.filter((r) => !r.result) : list);
  const sync = () => {
    const n = targets().length;
    goBtn.disabled = !n;
    goBtn.textContent = n ? `${n}건 만들기` : '만들 기록이 없어요';
    back.querySelector('#bEta').textContent = n
      ? `약 ${Math.max(1, Math.ceil(n / 2))}~${n}분 걸려요. 오래된 기록부터 하나씩 만들고, 다 된 건은 바로 저장돼요. 만드는 동안 창을 닫고 다른 일을 해도 돼요. 다 되면 알려드려요.`
      : '';
  };
  let busy = false;
  const close = () => {
    if (busy) return;
    document.removeEventListener('keydown', onKey); back.remove(); opener?.focus?.();
  };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.onclick = (ev) => { if (ev.target === back) close(); };
  back.querySelector('#bLenses').onchange = sync;
  back.querySelector('#bSkip')?.addEventListener('change', sync);
  back.querySelector('[data-all]').onclick = () => boxes().forEach((b) => (b.checked = true));
  back.querySelector('[data-none]').onclick = () => boxes().forEach((b) => (b.checked = false));
  back.querySelector('[data-cancel]').onclick = close;
  goBtn.onclick = () => {
    const lenses = boxes().filter((b) => b.checked).map((b) => b.value);
    const useHistory = back.querySelector('#bHistory').checked;
    const todo = targets().slice().sort((a, b) => chronoOf(a) - chronoOf(b));   // 상담일이 이른 회기부터 → 뒤 회기가 앞 회기 결과를 참고
    prefs.lenses_journal = lenses; savePrefs(prefs);
    close();
    sel = null; renderList();
    startBatch(todo, lenses, useHistory);
    openBatchModal();
  };
  sync();
  goBtn.focus();
}

// ---------- 결과 만들기: 뒤에서 진행 ----------
// 진행 창을 닫아도 계속 만듦(이 탭 안에서). 오른쪽 아래 진행 버튼으로 다시 열 수 있고, 다 되면 알림.
// 진행률: 결과 글자 수 ÷ 같은 종류 기존 결과의 보통 길이(중앙값)로 추정 — 첫 글자가 오기 전(AI가 생각하는 동안)은 시간에 따라 15%까지 천천히.
let batch = null;
const BATCH_LABEL = { wait: '대기', run: '만드는 중', done: '완료', fail: '실패', stop: '중단', skip: '건너뜀' };
function donutSVG(p, st, size = 22) {
  const r = 9, c = 2 * Math.PI * r;
  const ring = `<circle cx="12" cy="12" r="${r}" fill="none" stroke="var(--border)" stroke-width="3"/>`;
  let inner;
  if (st === 'done') inner = `<circle cx="12" cy="12" r="10.5" fill="var(--primary)"/><path d="m7.5 12.3 3 3 6-6.3" fill="none" stroke="var(--on-primary)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
  else if (st === 'fail') inner = `<circle cx="12" cy="12" r="10.5" fill="var(--error)"/><path d="M12 7v6M12 16.6v.1" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`;
  else if (st === 'stop' || st === 'skip') inner = `${ring}<path d="M8.5 12h7" stroke="var(--text-2)" stroke-width="2.2" stroke-linecap="round"/>`;
  else if (st === 'run') p = Math.max(p, 0.04);   // 막 시작해도 움직임이 보이게
  if (!['done', 'fail', 'stop', 'skip'].includes(st)) inner = ring + (p > 0 ? `<circle cx="12" cy="12" r="${r}" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${(c * Math.min(p, 1)).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 12 12)"/>` : '');
  return `<svg class="donut" viewBox="0 0 24 24" width="${size}" height="${size}" role="img" aria-label="${st === 'run' ? Math.round(p * 100) + '%' : BATCH_LABEL[st] || ''}">${inner}</svg>`;
}
function typicalLen(type) {
  const ls = records.filter((x) => x.type === type && x.result).map((x) => x.result.length).sort((a, b) => a - b);
  return ls.length ? Math.max(1500, ls[Math.floor(ls.length / 2)]) : 3000;
}
const batchCount = () => {
  const it = batch?.items || [];
  return { total: it.length, ok: it.filter((x) => x.st === 'done').length, fail: it.filter((x) => x.st === 'fail').length, fin: it.filter((x) => !['wait', 'run'].includes(x.st)).length };
};
const batchOverall = () => { const it = batch.items; return it.reduce((a, x) => a + (x.st === 'run' ? x.p : x.st === 'wait' ? 0 : 1), 0) / it.length; };
// 목록 카드의 상태 표시용: 대기·만드는 중
function batchState(id) { const x = batch && !batch.done && batch.items.find((i) => i.r.id === id); return x && (x.st === 'wait' || x.st === 'run') ? x.st : null; }

function startBatch(todo, lenses, useHistory) {
  const ctrl = new AbortController();
  batch = { items: todo.map((r) => ({ r, st: 'wait', p: 0, err: '', before: r.result || '' })), ctrl, done: false, seen: false };
  batchRun = ctrl;
  renderBatch(true);
  (async () => {
    for (const x of batch.items) {
      if (ctrl.signal.aborted) { x.st = 'stop'; continue; }
      const cur = records.find((y) => y.id === x.r.id);
      if (!cur || cur.deletedAt) { x.st = 'skip'; x.err = '삭제된 기록'; renderBatch(true); continue; }
      if ((cur.result || '') !== x.before) { x.st = 'skip'; x.err = '그사이 직접 만든 결과가 있어요'; renderBatch(true); continue; }
      x.st = 'run'; x.p = 0; renderBatch(true);
      const t0 = Date.now(), expect = typicalLen(cur.type);
      let got = 0;
      const tick = setInterval(() => { if (!got) { x.p = 0.15 * (1 - Math.exp(-(Date.now() - t0) / 8000)); renderBatch(); } }, 400);
      const job = { ...cur, inputs: normInputs(cur.type, cur.inputs), mode: inferMode(cur), lenses, useHistory };
      let tries = 0;
      for (;;) {
        try {
          const text = await generateText(buildPrompt(job), ctrl.signal, (t) => { got = t.length; x.p = 0.15 + 0.8 * Math.min(1, got / expect); renderBatch(); });
          const patch = { result: text, lenses, useHistory, updatedAt: Date.now() };
          await updateDoc(userDoc('records', cur.id), patch);
          Object.assign(cur, patch);
          // 이 기록을 열어 둔 상태면 화면에도 반영 (결과를 직접 고치는 중이면 건드리지 않음)
          if (editor?.id === cur.id && !editor.editingResult) {
            editor.result = text; editor.lenses = lenses; editor.useHistory = useHistory;
            if (!editor.dirty) renderEditor();
          }
          x.st = 'done'; x.p = 1;
          break;
        } catch (err) {
          if (err.name === 'AbortError') { x.st = 'stop'; break; }
          if (err.status === 429 && tries++ < 2) { x.err = '무료 사용량 제한으로 30초 기다리는 중'; renderBatch(); await new Promise((res) => setTimeout(res, 30000)); x.err = ''; continue; }
          x.st = 'fail'; x.err = friendlyError(err);
          break;
        }
      }
      clearInterval(tick);
      renderBatch(true);
    }
    batch.done = true; batchRun = null;
    renderBatch(true);
    const { ok, fail } = batchCount();
    const stopped = ctrl.signal.aborted;
    if (!$('#batchModal')) {
      toastAction(stopped ? `결과 만들기를 멈췄어요 · ${ok}건 완료` : `결과 ${ok}건을 다 만들었어요` + (fail ? ` · ${fail}건 실패` : ''), '자세히', openBatchModal);
    } else batch.seen = true;
    if (document.hidden) document.title = '✓ 결과 완료 · 농지니';
  })();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && batch?.done) document.title = '농지니'; });

// 상태가 바뀌면(full) 목록·진행 창·버튼 모두, 진행률만 바뀌면 도넛만 갱신
function renderBatch(full = false) {
  if (!batch) { $('#batchDock').hidden = true; document.title = '농지니'; return; }
  const { total, ok, fail, fin } = batchCount();
  const pAll = batchOverall();
  if (!batch.done) document.title = `(${fin}/${total}) 농지니`;
  else if (!document.hidden) document.title = '농지니';
  // 오른쪽 아래 진행 버튼
  const dock = $('#batchDock');
  dock.hidden = false;
  dock.classList.toggle('done', batch.done);
  $('#batchDockOpen').innerHTML = `${donutSVG(pAll, batch.done ? (fail && !ok ? 'fail' : 'done') : 'run', 26)}
    <span class="bd-text"><b>${batch.done ? (batch.ctrl.signal.aborted ? '결과 만들기 멈춤' : '결과 만들기 완료') : '결과 만드는 중'}</b>
    <span>${batch.done ? `${ok}건 완료${fail ? ` · ${fail}건 실패` : ''}` : `${fin}/${total}건 · ${Math.round(pAll * 100)}%`}</span></span>`;
  $('#batchDockClose').hidden = !batch.done;
  // 진행 창
  const m = $('#batchModal');
  if (m) {
    batch.items.forEach((x, i) => {
      const row = m.querySelector(`[data-st="${i}"]`); if (!row) return;
      row.querySelector('.bs-donut').innerHTML = donutSVG(x.p, x.st);
      row.querySelector('.bs-label').textContent = x.st === 'run' ? `${Math.round(x.p * 100)}%` : BATCH_LABEL[x.st];
      row.dataset.state = x.st;
      const note = row.querySelector('.bs-note'); note.textContent = x.err; note.hidden = !x.err;
    });
    m.querySelector('#bProg').textContent = batch.done
      ? `${ok}건을 만들었어요.` + (fail ? ` ${fail}건은 만들지 못했어요. 다시 골라서 만들거나, 기록을 열어 [생성]을 눌러주세요.` : '')
      : `${fin}/${total}건 완료 · 창을 닫아도 뒤에서 계속 만들어요. 다 되면 알려드려요. (브라우저 탭을 닫으면 멈춰요)`;
    if (full) {
      const acts = m.querySelector('#bActions');
      const want = batch.done ? 'done' : 'run';
      if (acts.dataset.mode !== want) {
        acts.dataset.mode = want;
        acts.innerHTML = batch.done ? '<button class="btn" id="bDone">닫기</button>'
          : '<button class="btn ghost" id="bStop">중단</button><button class="btn" id="bHide">닫고 계속 만들기</button>';
        m.querySelector('#bStop')?.addEventListener('click', () => batch.ctrl.abort());
        m.querySelector('#bHide')?.addEventListener('click', closeBatchModal);
        m.querySelector('#bDone')?.addEventListener('click', closeBatchModal);
        if (batch.done) m.querySelector('#bDone').focus();
      }
    }
  }
  if (full) renderList();
}
function openBatchModal() {
  if (!batch || $('#batchModal')) return;
  if (batch.done) batch.seen = true;
  const opener = document.activeElement;
  const back = document.createElement('div');
  back.className = 'modal-back'; back.id = 'batchModal';
  back.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="bTitle">
      <div class="modal-body">
        <div class="bm-head"><h3 id="bTitle">결과 만들기</h3>
          <button class="pf-close" data-x aria-label="닫기"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
        <p class="sub" id="bProg" aria-live="polite"></p>
        <div class="imp-list">${batch.items.map((x, i) => `
          <div class="imp-row batch-row" data-st="${i}"><div class="imp-main"><b>${esc(x.r.title)}</b><span class="sub" style="margin:0">${esc(clientName(x.r.clientId))} · 작성 ${fmtDay(writtenOf(x.r))}</span><span class="bs-note" hidden></span></div>
            <span class="bs-status"><span class="bs-label"></span><span class="bs-donut"></span></span></div>`).join('')}</div>
      </div>
      <div class="modal-actions" id="bActions"></div>
    </div>`;
  document.body.appendChild(back);
  back._opener = opener;
  back.onclick = (ev) => { if (ev.target === back) closeBatchModal(); };
  back.querySelector('[data-x]').onclick = closeBatchModal;
  renderBatch(true);
  (back.querySelector('#bHide') || back.querySelector('#bDone'))?.focus();
}
function closeBatchModal() {
  const m = $('#batchModal'); if (!m) return;
  m.remove(); m._opener?.focus?.();
  if (batch?.done) { dismissBatch(); route(); }
}
function dismissBatch() { batch = null; renderBatch(); }
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && $('#batchModal') && !document.querySelector('[role=alertdialog]')) closeBatchModal(); });
$('#batchDockOpen').onclick = openBatchModal;
$('#batchDockClose').onclick = dismissBatch;

// ---------- 작성 · 수정 화면 ----------
function nowStamp() { return fmtDate(Date.now()); }
function defaultTitle(clientId, type) {
  if (type === 'journal') return `${clientRecords(clientId).filter((r) => r.type === 'journal').length + 1}회기 · ${nowStamp()}`;
  return nowStamp();
}

// ---------- 작성 방식 ----------
// sentence: 문장으로 쓰기(자유 서술 칸 하나, 여러 회기를 붙여넣으면 회기별로 나눠 저장 가능) / fields: 항목별로 쓰기
const MODES = { sentence: '문장으로 쓰기', fields: '항목별로 쓰기' };
const freeField = (type) => manifest.fields[type].find((f) => f.free);
const modeFields = (type, mode) => manifest.fields[type].filter((f) => (mode === 'sentence' ? f.free : !f.free));
const FIELD_RENAMES = { '아동의 말': '내담자의 말' };   // 바뀐 칸 이름 → 예전 기록도 새 이름으로 보이게
const OLD_FREE = { journal: ['회기 메모', '오늘 회기 내용'], analysis: ['사례 메모'] };   // 예전 칸 이름 → 새 이름으로 옮김
function normInputs(type, inputs) {
  const inp = { ...(inputs || {}) };
  const newK = freeField(type)?.label;
  (OLD_FREE[type] || []).forEach((oldK) => { if (newK && inp[oldK] && !inp[newK]) inp[newK] = inp[oldK]; delete inp[oldK]; });
  Object.entries(FIELD_RENAMES).forEach(([o, n]) => { if (inp[o] != null && inp[n] == null) inp[n] = inp[o]; delete inp[o]; });
  return inp;
}
function inferMode(src) {
  if (src.mode) return src.mode;
  const inp = src.inputs || {};
  if (!src.id) return MODES[prefs['mode_' + src.type]] ? prefs['mode_' + src.type] : 'sentence';
  const free = freeField(src.type)?.label;
  const hasFree = (inp[free] || '').trim();
  const hasOther = modeFields(src.type, 'fields').some((f) => (inp[f.label] || '').trim());
  return hasFree && !hasOther ? 'sentence' : 'fields';
}

function openEditor(src) {
  const type = src.type;
  const hasHistory = prevRecords(src.clientId, src.id).length > 0;
  editor = {
    id: src.id || null,
    clientId: src.clientId,
    type,
    title: src.title || defaultTitle(src.clientId, type),
    inputs: normInputs(type, src.inputs),
    mode: null,
    lenses: src.lenses || prefs['lenses_' + type] || manifest.lenses.filter((l) => l[type]).map((l) => l.id),
    useHistory: src.useHistory ?? hasHistory,
    result: src.result || '',
    createdAt: src.createdAt || null,
    writtenAt: src.writtenAt || null,
    dirty: false,
    editingResult: false,
    editing: !src.id,          // 저장된 기록은 읽기 화면으로 열고, [수정]을 눌러야 편집
  };
  editor.mode = inferMode({ ...src, inputs: editor.inputs });
  renderEditor();
}

function renderEditorBody() {
  const e = editor, host = $('#editorBody');
  const splitting = !!e.splitting;
  $('#runBtn').hidden = splitting;
  $('#saveBtn').hidden = splitting;
  $('#outCard').classList.toggle('hidden', splitting || !e.result);
  if (splitting) {
    renderBulk(host, e.clientId, {
      text: e.inputs[freeField('journal').label] || '',
      onBack: () => { e.splitting = false; renderEditor(); },
      onSaved: () => discardDraft(e),
      excludeId: e.id,
      autoGen: e.splitAuto,
    });
    return;
  }
  const sentence = e.mode === 'sentence';
  const editForm = isEditForm(e);
  const autoTitle = sentence && e.type === 'journal' && !editForm;   // 새 상담일지 문장 쓰기는 제목을 내용 첫 줄(N회기·날짜)에서 자동으로 만듦
  host.innerHTML = `
    ${editForm ? '' : `<p class="sub">${sentence
      ? (e.type === 'journal' ? '회기마다 첫 줄에 "N회기 날짜 시간"을 적어주세요. 여러 회기를 한꺼번에 넣으면 회기별로 나눠 저장해요.' : '아는 내용을 편하게 적어주세요. AI가 항목별로 나눠 분석해요.')
      : '아는 항목만 짧게 적어주세요. 빈 칸은 건너뛰어요.'}</p>`}
    ${autoTitle ? '' : `<div class="field">
      <label for="title">제목</label>
      <input type="text" id="title" value="${esc(e.title)}">
    </div>`}
    ${modeFields(e.type, e.mode).map((f, i) => `
      <div class="field">
        <label for="f${i}">${esc(f.label)}</label>
        <textarea id="f${i}" class="${f.free ? 'free' : ''}" data-label="${esc(f.label)}" placeholder="${esc(editForm && f.free ? EDIT_HINT[e.type] : (f.hint || ''))}">${esc(e.inputs[f.label] || '')}</textarea>
      </div>`).join('')}`;
  if ($('#title')) $('#title').oninput = (ev) => { e.title = ev.target.value; markDirty(true); };
  host.querySelectorAll('textarea[data-label]').forEach((t) => {
    t.oninput = () => { e.inputs[t.dataset.label] = t.value; markDirty(true); if (t.classList.contains('free')) updateSplitHint(); };
  });
  if (canSplit(e)) {
    host.querySelector('textarea.free').insertAdjacentHTML('afterend', '<div class="split-hint" id="splitHint" aria-live="polite"></div>');
    updateSplitHint();
  }
}
// 상담일지 문장 칸에 여러 회기가 들어 있으면 회기별로 나눠 저장할 수 있게 안내
const canSplit = (e) => e.type === 'journal' && e.mode === 'sentence' && !e.result && !isEditForm(e);
const sessionCount = (e) => splitByRule((e.inputs[freeField('journal').label] || '').trim()).sessions.length;
function updateSplitHint() {
  const e = editor, el = $('#splitHint'); if (!e || !el) return;
  const n = sessionCount(e);
  el.className = 'split-hint' + (n >= 2 ? ' on' : '');
  const t = (e.inputs[freeField('journal').label] || '').trim();
  el.innerHTML = n >= 2
    ? `<span><b>${n}개 회기</b>가 들어 있어요. 저장하면 회기별 상담일지 ${n}개로 나눠져요.</span>`
    : (t && n === 0 && t.length > 200 ? '<span>회기 표시("N회기") 없이 여러 회기를 넣었나요?</span><button class="link-btn" id="splitBtn">AI로 회기 나누기</button>' : '');
  on('#splitBtn', 'click', () => startSplit(false));
}
function startSplit(autoGen) {
  const e = editor;
  if (!(e.inputs[freeField('journal').label] || '').trim()) return toast('먼저 내용을 적거나 붙여넣어 주세요');
  e.splitting = true; e.splitAuto = !!autoGen;
  renderEditor();
}
// 회기가 하나면 첫 줄의 "N회기 날짜 시간"으로 제목을 만듦
function applyAutoTitle(e) {
  if (!(e.type === 'journal' && e.mode === 'sentence') || isEditForm(e)) return;   // 수정 중엔 사용자가 고친 제목 유지
  const r = splitByRule((e.inputs[freeField('journal').label] || '').trim());
  if (r.sessions.length === 1 && /회기/.test(r.sessions[0].title)) e.title = r.sessions[0].title;
}
// 같은 내담자에게 내용 앞부분이 같은 기록이 이미 있는지 (실수로 같은 회기를 두 번 저장하는 것 방지)
function findSimilar(e) {
  const key = (inp) => Object.values(inp || {}).filter((v) => typeof v === 'string').join('').replace(/\s+/g, '').slice(0, 60);
  const mine = key(e.inputs);
  if (mine.length < 10) return null;
  return clientRecords(e.clientId).find((r) => r.id !== e.id && r.type === e.type && key(r.inputs) === mine) || null;
}
// 새 기록 저장 전 확인 → true: 저장 진행
function okToSave(e) {
  if (e.id) return Promise.resolve(true);
  const d = findSimilar(e);
  if (!d) return Promise.resolve(true);
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal modal-sm" role="alertdialog" aria-modal="true" aria-labelledby="sTitle" aria-describedby="sMsg">
        <div class="modal-body">
          <h3 id="sTitle">비슷한 기록이 이미 있어요</h3>
          <p class="sub" id="sMsg" style="margin:0">"${esc(d.title)}" (작성 ${fmtDay(writtenOf(d))})과 내용 앞부분이 같아요. 같은 회기를 두 번 저장하는 건 아닌지 확인해 주세요.</p>
          <p style="margin:12px 0 0"><button class="link-btn" data-view>기존 기록 새 탭에서 보기</button></p>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" data-cancel>저장 안 함</button>
          <button class="btn" data-ok>그래도 저장</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const done = (v) => { document.removeEventListener('keydown', onKey); back.remove(); opener?.focus?.(); resolve(v); };
    const onKey = (ev) => { if (ev.key === 'Escape') done(false); };
    document.addEventListener('keydown', onKey);
    back.querySelector('[data-view]').onclick = () => window.open('#/r/' + d.id, '_blank');   // 새 탭이라 지금 쓰던 내용은 그대로
    back.querySelector('[data-ok]').onclick = () => done(true);
    back.querySelector('[data-cancel]').onclick = () => done(false);
    back.onclick = (ev) => { if (ev.target === back) done(false); };
    back.querySelector('[data-cancel]').focus();
  });
}

// 저장 버튼: 여러 회기면 바로 회기별 미리보기로
async function onSaveClick() {
  const e = editor;
  if (canSplit(e) && sessionCount(e) >= 2) return startSplit(false);
  if (!(await okToSave(e))) return;
  applyAutoTitle(e);
  saveEditor(false, true).then(() => { if (editor === e && !e.dirty) { e.editing = false; renderEditor(); } }).catch(() => {});
}
// 나눠 저장한 뒤, 문장 칸 내용이 자동 저장되며 생긴 원본 기록은 지움 (같은 내용이 두 번 남지 않게)
async function discardDraft(e) {
  clearTimeout(autoT);
  await saveChain;
  e.dirty = false;                       // 나눠 저장했으니 원본 입력은 '저장 안 됨'으로 남기지 않음
  if (!e.id) return;
  try { await deleteDoc(userDoc('records', e.id)); } catch {}
  records = records.filter((r) => r.id !== e.id);
  e.id = null; e.dirty = false;
}

function renderEditor() {
  if (editor.editing) renderEditForm(); else renderReadView();
}

// ---------- 읽기 화면 (저장된 기록) ----------
function renderReadView() {
  const e = editor;
  const fields = modeFields(e.type, e.mode).filter((f) => (e.inputs[f.label] || '').trim());
  view.main = `
    <div class="page-head editor-head">
      <div>
        <a class="back" href="#/c/${e.clientId}">${ic('back', 14)}${esc(clientName(e.clientId))}</a>
        <div class="eyebrow">${TYPE[e.type]}</div>
      </div>
      <div class="row head-actions">
        <button class="btn danger small" id="delBtn">삭제</button>
        <button class="btn ghost h32" id="editBtn">수정</button>
        <button class="btn h32" id="runBtn">${e.result ? SHORT[e.type] + ' 다시 생성' : TYPE[e.type] + ' 생성'}</button>
      </div>
    </div>

    <h2 class="read-title">${esc(e.title)}</h2>
    <p class="read-meta">${recDate(records.find((r) => r.id === e.id) || e)}</p>

    <div class="card read-inputs">
      <div class="out-head"><h3>입력한 내용</h3><span class="sub" style="margin:0">${MODES[e.mode] || ''}</span></div>
      ${fields.length ? fields.map((f) => `
        <div class="read-field">
          ${e.mode === 'sentence' ? '' : `<div class="read-label">${esc(f.label)}</div>`}
          <div class="read-value">${esc(e.inputs[f.label])}</div>
        </div>`).join('') : '<p class="sub" style="margin:0">입력한 내용이 없어요.</p>'}
    </div>

    <!-- 만든 결과는 입력한 내용 아래 (입력 → 결과 순서로 읽힘) -->
    <div class="card ${e.result ? '' : 'hidden'}" id="outCard" style="margin-top:18px">
      <div class="out-head">
        <h3>${TYPE[e.type]}</h3>
        <div class="row"><button class="btn ghost small" id="copyBtn">복사</button></div>
      </div>
      <div class="status" id="status"></div>
      <div class="result" id="result"></div>
    </div>`;
  e.editingResult = false;
  renderResult();
  $('#editBtn').onclick = () => { normalizeForEdit(e); e.editing = true; renderEditor(); };
  $('#runBtn').onclick = openRunModal;
  $('#copyBtn').onclick = () => copyText(e.result);
  $('#delBtn').onclick = () => removeRecord(e.id);
}

// 수정 화면은 작성 방식과 관계없이 "제목 + 내용" 하나의 폼. 항목별로 쓴 내용은 "항목: 값" 줄로 합쳐 옮김(내용 손실 없음).
function normalizeForEdit(e) {
  if (e.mode === 'sentence') return;
  const free = freeField(e.type).label;
  const lines = modeFields(e.type, 'fields').filter((f) => (e.inputs[f.label] || '').trim()).map((f) => `${f.label}: ${e.inputs[f.label].trim()}`);
  e.inputs[free] = [(e.inputs[free] || '').trim(), lines.join('\n')].filter(Boolean).join('\n\n');
  e.mode = 'sentence';
}
const isEditForm = (e) => e.editing && !!e.id;   // 저장된 기록 수정 중
// 수정 화면은 기록 하나만 다루므로 여러 회기 예시 대신 한 회기 예시
const EDIT_HINT = { journal: "예) 클레이 처음 만짐, 손끝만 대다가 점점 손바닥 전체로 만지며 웃음. '엄마 손 같아'라고 말함.", analysis: "예) 8세 남아, 초2. 수업 중 자리 이탈과 친구를 때리는 일이 잦아 담임 권유로 의뢰됨." };

// ---------- 편집 화면 ----------
function renderEditForm() {
  const e = editor;
  view.main = `
    <div class="page-head editor-head">
      <div>
        <a class="back" href="#/c/${e.clientId}">${ic('back', 14)}${esc(clientName(e.clientId))}</a>
        <div class="eyebrow">${TYPE[e.type]} · ${e.id ? '수정 중' : '새 기록'}</div>
      </div>
      <div class="row head-actions">
        <span class="save-state" id="dirtyMark" aria-live="polite"></span>
        ${e.id ? '<button class="btn ghost h32" id="cancelBtn">취소</button>' : ''}
        <button class="btn h32" id="saveBtn" disabled>내용 저장</button>
        <button class="btn h32" id="runBtn">${e.result ? SHORT[e.type] + ' 다시 생성' : TYPE[e.type] + ' 생성'}</button>
      </div>
    </div>

    <div class="card">
      ${isEditForm(e) ? '' : `<div class="seg" role="tablist" aria-label="작성 방식">
        ${Object.entries(MODES).map(([k, v]) => `
          <button role="tab" class="seg-btn ${e.mode === k ? 'on' : ''}" aria-selected="${e.mode === k}" data-mode="${k}">${v}</button>`).join('')}
      </div>`}
      <div id="editorBody"></div>
    </div>

    <div class="card ${e.result ? '' : 'hidden'}" id="outCard" style="margin-top:18px">
      <div class="out-head">
        <h3>${TYPE[e.type]} 결과</h3>
        <div class="row">
          <button class="btn ghost small" id="copyBtn">복사</button>
          <button class="btn ghost small" id="editResultBtn">${e.editingResult ? '수정 완료' : '직접 수정'}</button>
        </div>
      </div>
      <div class="status" id="status"></div>
      <div class="result" id="result"></div>
    </div>`;

  renderEditorBody();
  renderResult();
  setSaveState(e, e.dirty ? 'dirty' : e.id ? 'saved' : 'idle');
  $('#main').querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = () => {
      if (e.mode === b.dataset.mode) return;
      e.mode = b.dataset.mode;
      e.splitting = false;
      prefs['mode_' + e.type] = e.mode; savePrefs(prefs);
      if (e.id) markDirty(true);
      renderEditor();
    };
  });

  $('#runBtn').onclick = openRunModal;
  $('#saveBtn').onclick = onSaveClick;
  $('#copyBtn').onclick = () => copyText(e.result);
  $('#editResultBtn').onclick = () => {
    if (e.editingResult) e.result = $('#resultEdit').value;
    e.editingResult = !e.editingResult;
    $('#editResultBtn').textContent = e.editingResult ? '수정 완료' : '직접 수정';
    renderResult();
  };
  if (e.id) $('#cancelBtn').onclick = cancelEdit;
}
// 수정 취소: 바꾼 게 있으면 버릴지 묻고, 저장된 내용으로 되돌려 읽기 화면으로
async function cancelEdit() {
  const e = editor;
  if (e.dirty) {
    const ok = await confirmModal({ title: '수정한 내용을 버릴까요?', message: '저장하지 않은 수정 내용은 사라져요.', okLabel: '버리기', cancelLabel: '계속 수정', danger: true });
    if (!ok) return;
  }
  const saved = records.find((r) => r.id === e.id);
  openEditor(saved);
}

// ---------- 만들기 전 이론 선택 모달 (만들 때마다, 다시 만들 때도 항상 띄움) ----------
async function openRunModal() {
  const e = editor;
  if (!profile.geminiKey) { toast('먼저 설정에서 AI 이용 키를 등록해 주세요'); location.hash = '#/settings'; return; }
  if (!buildPrompt().filledCount) return toast('내용을 하나 이상 입력해 주세요');
  if (canSplit(e) && sessionCount(e) >= 2) return startSplit(true);   // 여러 회기면 묻지 않고 회기별 미리보기로(내용 생성 체크된 상태)
  if (!(await okToSave(e))) return;
  applyAutoTitle(e);
  const prevCount = prevRecords(e.clientId, e.id, sessionOf(e) || (e.id ? writtenOf(e) : null)).length;
  const memo = profileText(clients.find((c) => c.id === e.clientId));
  const opener = document.activeElement;
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="mTitle">
      <div class="modal-body">
        <h3 id="mTitle">${e.result ? SHORT[e.type] + ' 다시 생성' : TYPE[e.type] + ' 생성'}</h3>
        <p class="sub">하나도 고르지 않으면 입력 내용만으로 작성해요.</p>
        <div class="row" style="margin:-4px 0 6px"><button class="link-btn" data-all>모두 선택</button><button class="link-btn" data-none>모두 해제</button></div>
        <div id="mLenses">${manifest.lenses.map((l) => `
          <label class="lens">
            <input type="checkbox" value="${l.id}" ${e.lenses.includes(l.id) ? 'checked' : ''}>
            <span><span class="num">${l.id.slice(0, 2)}</span> <span class="t">${esc(l.title)}</span><div class="d">${esc(l.desc)}</div></span>
          </label>`).join('')}</div>
        <label class="check modal-hist">
          <input type="checkbox" id="mHistory" ${e.useHistory && prevCount ? 'checked' : ''} ${prevCount ? '' : 'disabled'}>
          <span>이 내담자의 이전 기록 참고하기
            <small>${prevCount ? `최근 기록 ${Math.min(prevCount, HISTORY_COUNT)}건을 참고해 변화와 반복되는 주제를 반영해요` : '아직 참고할 이전 기록이 없어요'}</small>
          </span>
        </label>
        ${memo ? '<p class="modal-note">내담자 정보도 함께 참고해요.</p>' : ''}
        ${e.result ? '<p class="modal-note">지금 결과는 새 결과로 바뀌어요.</p>' : ''}
      </div>
      <div class="modal-actions">
        <button class="btn ghost" data-cancel>취소</button>
        <button class="btn" data-go></button>
      </div>
    </div>`;
  document.body.appendChild(back);
  const boxes = () => [...back.querySelectorAll('#mLenses input')];
  const goBtn = back.querySelector('[data-go]');
  const sync = () => {
    const n = boxes().filter((b) => b.checked).length;
    goBtn.textContent = n ? `이론 ${n}개 적용해 생성` : '이론 없이 생성';
  };
  const close = () => { document.removeEventListener('keydown', onKey); back.remove(); opener?.focus?.(); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.onclick = (ev) => { if (ev.target === back) close(); };
  back.querySelector('#mLenses').onchange = sync;
  back.querySelector('[data-all]').onclick = () => { boxes().forEach((b) => (b.checked = true)); sync(); };
  back.querySelector('[data-none]').onclick = () => { boxes().forEach((b) => (b.checked = false)); sync(); };
  back.querySelector('[data-cancel]').onclick = close;
  goBtn.onclick = () => {
    e.lenses = boxes().filter((b) => b.checked).map((b) => b.value);
    prefs['lenses_' + e.type] = e.lenses; savePrefs(prefs);
    if (prevCount) e.useHistory = back.querySelector('#mHistory').checked;
    markDirty(true);
    close();
    run();
  };
  sync();
  goBtn.focus();
}

function renderResult() {
  const e = editor;
  if (e.editingResult) {
    $('#result').innerHTML = '<textarea class="result-edit" id="resultEdit"></textarea>';
    $('#resultEdit').value = e.result;
    $('#resultEdit').oninput = () => markDirty(true);
  } else {
    $('#result').innerHTML = DOMPurify.sanitize(marked.parse(e.result || ''));
  }
}

// ---------- 저장 ----------
// 내용은 [내용 저장]을 눌러야 저장됨(자동 저장 없음). AI 결과 생성 직후에는 결과를 잃지 않도록 바로 저장.
// 저장은 한 줄로 세워 순서대로 처리.
let autoT = null;
let saveChain = Promise.resolve();
function setSaveState(e, state) {
  e.saveState = state;
  if (editor !== e) return;
  const m = $('#dirtyMark'); if (!m) return;
  m.className = 'save-state ' + state;
  m.innerHTML = { idle: '', dirty: '저장 안 됨', saving: '저장 중…', saved: `${ic('check', 14)}저장됨`, error: '저장 실패 · <button class="link-btn" id="retrySave">다시 시도</button>' }[state] || '';
  const sb = $('#saveBtn'); if (sb) sb.disabled = !(state === 'dirty' || state === 'error');
  if (state === 'error') $('#retrySave').onclick = () => saveEditor(true, true);
}
function markDirty(on) {
  const e = editor; if (!e) return;
  e.dirty = on;
  if (!on) return;
  e.rev = (e.rev || 0) + 1;
  setSaveState(e, 'dirty');
}
function saveEditor(silent = true, byUser = false) {
  const e = editor; if (!e) return Promise.resolve();
  clearTimeout(autoT);
  const p = saveChain.then(() => doSave(e, silent, byUser));
  saveChain = p.catch(() => {});
  return p;
}
async function doSave(e, silent, byUser) {
  if (!e.dirty && e.id) return;            // 이미 저장된 상태
  if (editor === e && e.editingResult) { const t = $('#resultEdit'); if (t) e.result = t.value; }
  const rev = e.rev || 0;
  const data = {
    clientId: e.clientId, type: e.type, title: e.title.trim() || defaultTitle(e.clientId, e.type),
    inputs: e.inputs, mode: e.mode, lenses: e.lenses, useHistory: e.useHistory, result: e.result, updatedAt: Date.now(),
  };
  if (e.id && byUser) data.editedAt = Date.now();   // 저장된 기록을 사람이 고쳐 저장한 경우만 "수정"
  setSaveState(e, 'saving');
  try {
    if (e.id) {
      await updateDoc(userDoc('records', e.id), data);
      Object.assign(records.find((r) => r.id === e.id) || {}, data);
    } else {
      data.createdAt = data.writtenAt = Date.now();
      const ref = await addDoc(userCol('records'), data);
      e.id = ref.id; e.createdAt = data.createdAt;
      records.unshift({ id: ref.id, ...data });
      if (editor === e) setHashSilently('#/r/' + ref.id);
    }
    if ((e.rev || 0) === rev) { e.dirty = false; setSaveState(e, 'saved'); }
    if (!silent) toast('저장했어요');
    renderNav();
  } catch (err) {
    setSaveState(e, 'error');
    toast('저장하지 못했어요. 인터넷 연결을 확인해 주세요.');
    throw err;
  }
}

// ---------- 질문문 조립 ----------
// 이전 기록으로 보낼 내용: AI 결과가 있으면 결과, 없으면 작성한 원문 (결과 없이 저장한 기록도 회기 흐름에 포함)
function recordText(r) {
  return (r.result || Object.values(r.inputs || {}).filter((v) => typeof v === 'string').join('\n\n')).trim();
}
// 이 기록보다 상담일이 앞선 기록(최근 것부터). before가 없으면(새 기록) 전부.
function prevRecords(clientId, id, before) {
  return clientRecords(clientId)
    .filter((r) => r.id !== id && recordText(r) && (!before || chronoOf(r) < before))
    .sort((a, b) => chronoOf(b) - chronoOf(a));
}

function buildPrompt(e = editor) {
  const lenses = manifest.lenses.filter((l) => e.lenses.includes(l.id));
  const filled = modeFields(e.type, e.mode || 'fields')
    .map((f) => [f.label, (e.inputs[f.label] || '').trim()])
    .filter(([, v]) => v);
  const task = TYPE[e.type] + (e.type === 'journal' ? ' 작성' : '');
  const sep = '\n\n---\n\n';

  let out = `# 요청: ${task}\n\n아래는 [참고자료] → [출력 양식] → [이전 기록] → [입력 정보] 순서로 구성되어 있습니다. 끝까지 모두 읽은 뒤 답해주십시오.`;
  if (lenses.length) {
    out += sep + `# [참고자료] 적용할 이론 (${lenses.length}개)\n\n아래 이론을 **번호 순서대로 하나씩** 적용하십시오. 각 이론의 "확인 질문"을 입력 정보에 빠짐없이 대입하고, 정보가 없어 답할 수 없는 질문은 "정보 부족"으로 표시하십시오.\n\n순서: ` + lenses.map((l) => `${l.id.slice(0, 2)}. ${l.title}`).join(' → ');
    lenses.forEach((l) => { out += sep + docs[l.id]; });
  }
  out += sep + docs[manifest.formats[e.type].id];

  if (e.useHistory) {
    const prev = prevRecords(e.clientId, e.id, sessionOf(e) || (e.id ? writtenOf(e) : null)).slice(0, HISTORY_COUNT).reverse();
    if (prev.length) {
      out += sep + `# [이전 기록] 같은 내담자의 최근 기록 ${prev.length}건 (오래된 순)\n\n이전 기록과 비교해 **변화, 반복되는 주제, 연속성**을 반영하십시오. 이전 기록과 이번 입력 정보가 다르면 이번 입력 정보를 우선하십시오.\n\n`
        + prev.map((r) => `## ${TYPE[r.type]} · ${r.title}${sessionOf(r) ? '' : ` · 작성 ${fmtDay(writtenOf(r))}`}${r.result ? '' : ' (작성 원문)'}\n\n${recordText(r).slice(0, 4000)}`).join('\n\n');
    }
  }

  const memo = profileText(clients.find((c) => c.id === e.clientId));
  out += sep + `# [입력 정보]\n\n내담자: ${clientName(e.clientId)}\n기록: ${e.title}\n\n`
    + (memo ? `## 내담자 기본 정보 (상담자가 입력)\n나이·의뢰 경위·발달력 등 고정 정보입니다. 판단할 때 반드시 반영하고, 특히 연령 기대 수준은 만 나이를 기준으로 판단하십시오.\n${memo}\n\n` : '') + filled.map(([k, v]) => `## ${k}\n${v}`).join('\n\n');
  out += sep + `${lenses.length ? '[참고자료]의 이론을 순서대로 빠짐없이 적용해 ' : ''}[출력 양식]에 맞춰 ${task}을 해주십시오. 답변은 한국어 마크다운으로 작성하십시오.`;
  return { system: docs[manifest.role.id], user: out, filledCount: filled.length };
}

// ---------- 제미나이 호출 ----------
async function findModels(key) {
  const res = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw await apiError(res);
  const list = ((await res.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''))
    .filter((n) => /^gemini-/.test(n) && !/(image|tts|audio|live|embedding|vision|robotics|computer)/.test(n));
  const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const rank = (n) =>
    n === 'gemini-flash-latest' ? 1000 :
    /flash$/.test(n) && !/lite/.test(n) ? 500 + ver(n) :
    n === 'gemini-flash-lite-latest' ? 400 :
    /flash-lite$/.test(n) ? 300 + ver(n) :
    /flash/.test(n) && !/lite/.test(n) ? 200 + ver(n) :
    /flash/.test(n) ? 100 + ver(n) : 0;
  const picked = list.filter((n) => rank(n) > 0).sort((a, b) => rank(b) - rank(a));
  if (!picked.length) throw new Error('이 키로 쓸 수 있는 모델을 찾지 못했어요.');
  return picked;
}

async function apiError(res) {
  let msg = '';
  try { msg = (await res.json()).error?.message || ''; } catch {}
  const e = new Error(msg || res.statusText);
  e.status = res.status;
  return e;
}

function friendlyError(e) {
  if (e.name === 'AbortError') return '중단했어요.';
  if (e.status === 400 && /API key/i.test(e.message)) return '이용 키가 올바르지 않아요. 설정에서 키를 다시 확인해 주세요.';
  if (e.status === 403) return '이 키로는 쓸 수 없어요. 구글 AI 스튜디오에서 키를 새로 만들어 등록해 주세요.';
  if (e.status === 429) return '무료 사용량을 잠시 넘었어요. 1분 뒤에 다시 시도해 주세요. (하루 사용량을 넘었다면 다음 날 오후 4~5시쯤 풀려요)';
  if (e.status >= 500) return '구글 서버가 잠시 불안정해요. 조금 뒤 다시 시도해 주세요.';
  if (e instanceof TypeError) return '인터넷 연결을 확인해 주세요.';
  return '문제가 생겼어요: ' + e.message;
}

async function generate(model, prompt, signal, onText) {
  const res = await fetch(`${GEMINI}/models/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': profile.geminiKey },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: prompt.system }] },
      contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
      generationConfig: { temperature: 0.4 },
    }),
  });
  if (!res.ok) throw await apiError(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '', finish = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      let chunk; try { chunk = JSON.parse(line.slice(5)); } catch { continue; }
      const cand = chunk.candidates?.[0];
      const part = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
      if (part) { text += part; onText(text); }
      if (cand?.finishReason) finish = cand.finishReason;
      if (chunk.promptFeedback?.blockReason) finish = 'BLOCKED';
    }
  }
  return { text, finish };
}

// ---------- 진행률 ----------
// 출력 양식 문서에서 "단계"를 읽어, 생성 중인 글에 어느 단계까지 나왔는지로 진행률을 계산합니다.
// 사례 분석: "## 1. 사례 요약" 같은 번호 제목 (3번 이론별 분석은 선택한 이론 수만큼 나눔)
// 상담일지: 양식 표의 항목 이름 + 덧붙일 것 항목
const norm = (t) => t.replace(/[\s\-–—·:()（）*_|#]/g, '');
function milestones(type) {
  const doc = docs[manifest.formats[type].id] || '';
  const heads = [...doc.matchAll(/^##\s*(\d+)\.\s*(.+)$/gm)].map((m) => ({ num: +m[1], title: m[2].trim() }));
  if (heads.length) return { kind: 'heads', items: heads };
  const rows = [...doc.matchAll(/^\|\s*([^|]+?)\s*\|/gm)].map((m) => m[1]).filter((t) => !/^-+$/.test(t) && t !== '항목');
  const extras = [...doc.matchAll(/^\d+\.\s*\*\*(.+?)\*\*/gm)].map((m) => m[1]);
  return { kind: 'rows', items: [...rows, ...extras].map((t) => ({ title: t, key: norm(t) })) };
}
function progressOf(type, text, lensCount) {
  const ms = milestones(type);
  if (!ms.items.length) return null;
  if (ms.kind === 'heads') {
    const L = Math.max(1, lensCount);
    const total = ms.items.length - 1 + L;            // 이론별 분석 = 이론 수만큼
    const nums = [...text.matchAll(/^(?:#{1,4}\s*\**|\*\*)\s*(\d{1,2})\s*[.)]/gm)].map((m) => +m[1]).filter((n) => n <= ms.items.length);
    const n = nums.length ? Math.max(...nums) : 0;
    if (!n) return { done: 0, total, label: '작성 시작' };
    const lensIdx = ms.items.findIndex((h) => /이론/.test(h.title)) + 1 || 3;
    let done, label = `${n}. ${ms.items[n - 1].title}`;
    if (n < lensIdx) done = n - 1;
    else if (n === lensIdx) {
      const after = text.slice(text.search(new RegExp(`^(?:#{1,4}\\s*\\**|\\*\\*)\\s*${n}\\s*[.)]`, 'm')));
      const k = Math.min(L, Math.max(1, (after.match(/주목할\s*지점/g) || []).length));
      done = lensIdx - 1 + (k - 1);
      if (lensCount > 1) label += ` (${k}/${L})`;
    } else done = lensIdx - 1 + L + (n - lensIdx - 1);
    return { done: done + 0.5, total, label };
  }
  const flat = norm(text);
  // 가장 뒤 항목이 나왔으면 그 앞은 지난 것으로 봄 (AI가 항목 하나를 빠뜨리거나 이름을 바꿔도 멈추지 않게)
  let k = 0;
  ms.items.forEach((it, i) => { if (flat.includes(it.key)) k = i + 1; });
  return { done: Math.max(0, k - 0.5), total: ms.items.length, label: k ? ms.items[k - 1].title : '작성 시작' };
}
function showProgress(p, secs) {
  const s = $('#status'); if (!s) return;
  const t = secs ? ` · ${secs}초` : '';
  if (!p) {
    s.innerHTML = `<div class="progress"><div class="pbar"><div class="pfill indet"></div></div>
      <div class="pmeta"><span class="step">자료를 읽고 구상하고 있어요${t}</span></div></div>`;
    return;
  }
  const pct = Math.min(97, Math.round(p.done / p.total * 100));
  let bar = s.querySelector('.pfill:not(.indet)');
  if (!bar) {
    s.innerHTML = `<div class="progress"><div class="pbar"><div class="pfill" style="width:0%"></div></div>
      <div class="pmeta"><span class="step"></span><b></b></div></div>`;
    bar = s.querySelector('.pfill');
  }
  bar.style.width = pct + '%';
  s.querySelector('.step').textContent = p.label + ' 작성 중' + t;
  s.querySelector('.pmeta b').textContent = pct + '%';
}

function setStatus(msg, busy) {
  const s = $('#status'); if (!s) return;
  s.innerHTML = (busy ? '<span class="spinner"></span>' : '') + esc(msg);
}

async function run() {
  const e = editor;
  if (!profile.geminiKey) { toast('먼저 설정에서 AI 이용 키를 등록해 주세요'); location.hash = '#/settings'; return; }
  const prompt = buildPrompt();
  if (!prompt.filledCount) return toast('내용을 하나 이상 입력해 주세요');

  running?.abort();
  const ctrl = new AbortController(); running = ctrl;
  e.editingResult = false;
  const erb = $('#editResultBtn'); if (erb) erb.textContent = '직접 수정';
  $('#outCard').classList.remove('hidden');
  $('#runBtn').disabled = true;
  const before = e.result;
  let partial = '';
  $('#result').innerHTML = '';
  const lensCount = (e.lenses || []).length;
  const started = Date.now();
  let prog = null;
  const secs = () => Math.round((Date.now() - started) / 1000);
  showProgress(null, 0);
  const tick = setInterval(() => { if (editor === e) showProgress(prog, secs()); }, 1000);
  $('#outCard').scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    if (!models) models = await findModels(profile.geminiKey);
    let result = null, lastErr = null;
    for (const model of models.slice(0, 4)) {
      try {
        result = await generate(model, prompt, ctrl.signal, (t) => {
          if (editor !== e) return;
          partial = t; $('#result').innerHTML = DOMPurify.sanitize(marked.parse(t));
          prog = progressOf(e.type, t, lensCount) || prog; showProgress(prog, secs());
        });
        break;
      } catch (err) {
        lastErr = err;
        // 사용량 초과나 모델 없음이면 다음 무료 모델로 넘어감
        if (!(err.status === 429 || err.status === 404 || err.status === 503) || partial) throw err;
      }
    }
    if (!result) throw lastErr;
    if (!result.text) throw new Error(result.finish === 'BLOCKED' || result.finish === 'SAFETY'
      ? '구글의 안전 기준 때문에 답변이 만들어지지 않았어요. 표현을 조금 바꿔서 다시 시도해 주세요.'
      : '빈 답변이 돌아왔어요. 다시 시도해 주세요.');
    if (editor !== e) return;
    e.result = result.text;
    e.dirty = true; e.rev = (e.rev || 0) + 1;   // 결과는 반드시 저장되도록 표시
    await saveEditor(true);
    e.editing = false;
    renderEditor();
    setStatus(result.finish === 'MAX_TOKENS'
      ? '답변이 길어서 중간에 끊겼어요. 이론 수를 줄여서 다시 만들어 보세요. (자동 저장됨)'
      : '완성해서 저장했어요. 꼭 검토한 뒤 사용해 주세요.', false);
  } catch (err) {
    if (editor !== e) return;
    if (partial) {
      e.result = partial; markDirty(true);
      setStatus(friendlyError(err) + ' (여기까지 작성됐어요. 필요하면 저장을 눌러주세요)', false);
    } else {
      e.result = before;
      setStatus('', false);
      $('#result').innerHTML = `<div class="error-box">${esc(friendlyError(err))}</div>`;
    }
  } finally {
    clearInterval(tick);
    if (running === ctrl) running = null;
    const btn = $('#runBtn'); if (btn) btn.disabled = false;
  }
}

// ---------- 설정 ----------
let keyEdit = false;   // 설정: 등록된 키가 있을 때 [키 변경]을 눌러야 입력칸이 나옴
const maskKey = (k) => (k.length > 8 ? '••••••••' + k.slice(-4) : '••••••••');
function viewSettings() {
  const hasKey = !!profile.geminiKey, showForm = !hasKey || keyEdit;
  view.main = `
    <div class="page-head"><h2>설정</h2></div>
    <div class="stack">
      <div class="card">
        <h3>AI 이용 키 (처음 한 번만)</h3>
        <p class="sub">구글의 무료 키예요. 카드 등록 없이 한 번만 등록하면 어느 기기에서든 쓸 수 있어요.</p>
        ${showForm ? `<ol class="steps">
          <li><span><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">구글 AI 스튜디오${ic('ext', 13)}</a>를 열고 같은 구글 계정으로 로그인</span></li>
          <li><span>약관 동의 화면이 나오면 동의</span></li>
          <li><span><b>Create API key</b>(API 키 만들기) 누르기</span></li>
          <li><span>만든 키를 복사해 아래 칸에 붙여넣고 <b>저장</b></span></li>
        </ol>
        <div class="field">
          <label for="keyInput">${hasKey ? '새 이용 키' : '이용 키'}</label>
          <input type="password" id="keyInput" placeholder="복사한 키를 붙여넣으세요" autocomplete="off">
          <div class="key-state" id="keyState"></div>
        </div>
        <div class="row">
          <button class="btn small" id="saveKey">저장</button>
          ${hasKey ? '<button class="btn ghost small" id="cancelKey">취소</button>' : ''}
        </div>` : `
        <div class="key-row">
          <div><div class="key-ok">${ic('check', 14)}등록됨</div><code class="key-mask">${esc(maskKey(profile.geminiKey))}</code></div>
          <div class="row">
            <button class="btn ghost small" id="editKey">키 변경</button>
            <button class="btn danger small" id="removeKey">키 삭제</button>
          </div>
        </div>`}
      </div>
      <div class="card">
        <h3>기록 내보내기</h3>
        <p class="sub">내담자와 기록 전체를 파일로 받아요. 가끔 받아두면 실수로 지워도 안심이에요.</p>
        <div class="row">
          <button class="btn small" id="exportTxt">읽기용 파일(.txt) 받기</button>
          <button class="btn ghost small" id="exportJson">백업용 파일(.json) 받기</button>
        </div>
      </div>
      <div class="card">
        <h3>계정</h3>
        <p class="sub">${esc(user.email || '')} · 내담자 ${clients.length}명 · 기록 ${records.length}건</p>
      </div>
    </div>`;

  $('#exportTxt').onclick = () => exportRecords('txt');
  $('#exportJson').onclick = () => exportRecords('json');
  const state = (msg, cls) => { const s = $('#keyState'); s.className = 'key-state ' + (cls || ''); s.textContent = msg; };
  on('#editKey', 'click', () => { keyEdit = true; viewSettings(); $('#keyInput')?.focus(); });
  on('#cancelKey', 'click', () => { keyEdit = false; viewSettings(); });
  if ($('#saveKey')) $('#saveKey').onclick = async () => {
    const k = $('#keyInput').value.trim();
    if (!k) return state('키를 붙여넣어 주세요', 'bad');
    $('#saveKey').disabled = true;
    state('키를 확인하는 중…');
    try {
      models = await findModels(k);
      await setDoc(doc(db, 'users', user.uid, 'private', 'settings'), { geminiKey: k }, { merge: true });
      profile.geminiKey = k; keyEdit = false;
      viewSettings(); toast('키를 저장했어요. 이제 결과를 만들 수 있어요');
    } catch (e) {
      state(friendlyError(e), 'bad');
    } finally { if ($('#saveKey')) $('#saveKey').disabled = false; }
  };
  const rm = $('#removeKey');
  if (rm) rm.onclick = async () => {
    if (!(await confirmModal({ title: '이용 키 삭제', message: '저장된 AI 이용 키를 지워요. 다시 쓰려면 새로 등록해야 해요.', okLabel: '키 삭제', danger: true }))) return;
    await setDoc(doc(db, 'users', user.uid, 'private', 'settings'), { geminiKey: '' }, { merge: true });
    profile.geminiKey = ''; models = null; keyEdit = false;
    viewSettings();
  };
}

boot();
