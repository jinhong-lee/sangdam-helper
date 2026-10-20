import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const PREFS = 'sangdam-helper:prefs';
const TYPE = { analysis: '사례 분석', journal: '상담일지' };
const HISTORY_COUNT = 3;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ts) => new Date(ts).toLocaleString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts) => new Date(ts).toLocaleDateString('ko-KR');
const plain = (md) => (md || '').replace(/[#*|>`_-]+/g, ' ').replace(/\s+/g, ' ').trim();

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2000);
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
let models = null;
let editor = null;    // 작성 중인 기록
let running = null;   // 진행 중인 생성 요청
const prefs = loadPrefs();

const userCol = (name) => collection(db, 'users', user.uid, name);
const userDoc = (name, id) => doc(db, 'users', user.uid, name, id);
const clientName = (id) => clients.find((c) => c.id === id)?.name || '(삭제된 아동)';
const clientRecords = (id) => records.filter((r) => r.clientId === id);

// ---------- 시작 ----------
async function boot() {
  if (!firebaseConfig.apiKey) {
    $('#bootView').innerHTML = '<div class="card" style="max-width:480px">아직 로그인 서비스가 연결되지 않았습니다. 관리자에게 Firebase 설정을 요청해 주세요.</div>';
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
    $('#bootView').innerHTML = `<div class="error-box">자료를 불러오지 못했습니다. 새로고침해 주세요. (${esc(e.message)})</div>`;
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
      $('#bootView').innerHTML = `<div class="error-box">기록을 불러오지 못했습니다. (${esc(e.message)})</div>`;
      return;
    }
    $('#userMail').textContent = u.email || '';
    show('#appView');
    route();
  });
}

async function loadData() {
  const pref = doc(db, 'users', user.uid);
  const snap = await getDoc(pref);
  profile = snap.exists() ? snap.data() : {};
  if (!snap.exists()) await setDoc(pref, { email: user.email || '', createdAt: Date.now() });
  const [cs, rs] = await Promise.all([getDocs(userCol('clients')), getDocs(userCol('records'))]);
  clients = cs.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  records = rs.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAt - a.createdAt);
  models = null;
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
      ? '이 주소에서는 아직 로그인이 허용되지 않았습니다. 관리자에게 알려주세요.'
      : '로그인하지 못했습니다. (' + e.code + ')';
    err.classList.remove('hidden');
  }
};
$('#logoutBtn').onclick = async () => {
  if (editor?.dirty && !confirm('저장하지 않은 내용이 있습니다. 로그아웃할까요?')) return;
  running?.abort();
  await signOut(auth);
  location.hash = '';
};

// ---------- 화면 이동 ----------
let lastHash = location.hash;
let skipHash = false;
window.addEventListener('hashchange', () => {
  if (skipHash) { skipHash = false; return; }
  if (editor?.dirty && !confirm('저장하지 않은 내용이 있습니다. 이동할까요?')) {
    skipHash = true; location.hash = lastHash; return;
  }
  lastHash = location.hash;
  route();
});
window.addEventListener('beforeunload', (e) => { if (editor?.dirty) { e.preventDefault(); e.returnValue = ''; } });
function setHashSilently(h) { history.replaceState(null, '', h); lastHash = h; }

function route() {
  if (!user) return;
  running?.abort();
  editor = null;
  const [, page, a, b] = (location.hash || '#/').split('/');
  if (page === 'c' && clients.some((c) => c.id === a)) viewClient(a);
  else if (page === 'new' && clients.some((c) => c.id === a) && TYPE[b]) openEditor({ clientId: a, type: b });
  else if (page === 'r' && records.some((r) => r.id === a)) openEditor(records.find((r) => r.id === a));
  else if (page === 'settings') viewSettings();
  else viewHome();
  renderNav();
  window.scrollTo(0, 0);
}

function renderNav() {
  const h = location.hash || '#/';
  const curClient = editor?.clientId;
  $('#nav').innerHTML = `
    <a href="#/" class="${h === '#/' || h === '' ? 'on' : ''}">전체 기록 <span class="cnt">${records.length}</span></a>
    <div class="nav-gap"></div>
    <div class="side-title">아동</div>
    ${clients.map((c) => `<a href="#/c/${c.id}" class="${h === '#/c/' + c.id || curClient === c.id ? 'on' : ''}">${esc(c.name)} <span class="cnt">${clientRecords(c.id).length}</span></a>`).join('')}
    <a href="#" data-add-client style="color:var(--primary)">+ 아동 추가</a>`;
  $('#nav [data-add-client]').onclick = (e) => { e.preventDefault(); addClient(); };
}

// ---------- 아동 ----------
async function addClient() {
  const name = (prompt('아동 별칭을 입력하세요 (예: A-1)') || '').trim();
  if (!name) return;
  if (clients.some((c) => c.name === name)) return toast('같은 이름의 아동이 이미 있습니다');
  const data = { name, memo: '', createdAt: Date.now(), updatedAt: Date.now() };
  const ref = await addDoc(userCol('clients'), data);
  clients.push({ id: ref.id, ...data });
  clients.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  location.hash = '#/c/' + ref.id;
}

function viewClient(id) {
  const c = clients.find((x) => x.id === id);
  const list = clientRecords(id);
  $('#main').innerHTML = `
    <div class="page-head">
      <div><div class="eyebrow">아동</div><h2>${esc(c.name)}</h2></div>
      <div class="row">
        <button class="btn ghost small" id="renameBtn">이름 바꾸기</button>
        <button class="btn danger small" id="delClientBtn">아동 삭제</button>
      </div>
    </div>
    <div class="stack">
      <div class="card">
        <h3>메모</h3>
        <p class="sub">이 아동에 대해 기억해 둘 내용 (다른 사람은 볼 수 없습니다)</p>
        <textarea id="memo" placeholder="예) 2026년 9월 의뢰, 주 1회, 모 상담 격주">${esc(c.memo)}</textarea>
      </div>
      <div class="row">
        <a class="btn" href="#/new/${id}/journal">+ 새 상담일지</a>
        <a class="btn ghost" href="#/new/${id}/analysis">+ 새 사례 분석</a>
      </div>
      ${listHTML(list, false)}
    </div>`;
  $('#memo').onblur = async (e) => {
    if (e.target.value === c.memo) return;
    c.memo = e.target.value; c.updatedAt = Date.now();
    await updateDoc(userDoc('clients', id), { memo: c.memo, updatedAt: c.updatedAt });
    toast('메모를 저장했습니다');
  };
  $('#renameBtn').onclick = async () => {
    const name = (prompt('새 별칭', c.name) || '').trim();
    if (!name || name === c.name) return;
    c.name = name;
    await updateDoc(userDoc('clients', id), { name, updatedAt: Date.now() });
    clients.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    viewClient(id); renderNav();
  };
  $('#delClientBtn').onclick = async () => {
    if (!confirm(`"${c.name}"와 기록 ${list.length}건을 모두 삭제할까요? 되돌릴 수 없습니다.`)) return;
    const batch = writeBatch(db);
    list.forEach((r) => batch.delete(userDoc('records', r.id)));
    batch.delete(userDoc('clients', id));
    await batch.commit();
    records = records.filter((r) => r.clientId !== id);
    clients = clients.filter((x) => x.id !== id);
    toast('삭제했습니다');
    location.hash = '#/';
  };
  bindList();
}

function viewHome() {
  if (!clients.length) {
    $('#main').innerHTML = `
      <div class="card empty">
        <b>첫 아동을 추가해 주세요</b>
        아동별로 상담일지와 사례 분석을 모아서 관리합니다.<br>이름 대신 "A-1"처럼 나만 알아볼 수 있는 별칭을 쓰세요.
        <div style="margin-top:18px"><button class="btn" id="firstClient">+ 아동 추가</button></div>
        ${profile.geminiKey ? '' : '<p class="sub" style="margin:18px 0 0">AI 이용 키도 등록해야 합니다. <a href="#/settings">설정으로 가기</a></p>'}
      </div>`;
    $('#firstClient').onclick = addClient;
    return;
  }
  $('#main').innerHTML = `
    <div class="page-head"><h2>전체 기록</h2></div>
    ${profile.geminiKey ? '' : '<div class="card" style="margin-bottom:16px">결과를 만들려면 먼저 AI 이용 키를 등록해 주세요. <a href="#/settings">설정으로 가기</a></div>'}
    ${listHTML(records, true)}`;
  bindList();
}

// ---------- 기록 목록 ----------
function listHTML(list, showClient) {
  if (!list.length) return '<div class="card empty"><b>아직 기록이 없습니다</b>위 버튼으로 첫 기록을 만들어 보세요.</div>';
  return `<div class="list">${list.map((r) => `
    <div class="item" data-open="${r.id}">
      <div class="item-body">
        <div class="item-title"><span class="tag ${r.type}">${TYPE[r.type]}</span>${esc(r.title)}</div>
        <div class="item-meta">${showClient ? esc(clientName(r.clientId)) + ' · ' : ''}${fmtDate(r.createdAt)}${r.updatedAt - r.createdAt > 60000 ? ' · 수정됨' : ''}</div>
        <div class="item-preview">${esc(plain(r.result).slice(0, 160)) || '(아직 결과 없음)'}</div>
      </div>
      <div class="item-actions">
        <button class="btn ghost small" data-copy="${r.id}" title="결과를 클립보드에 복사">복사</button>
        <button class="btn ghost small" data-dup="${r.id}" title="같은 내용으로 새 기록 만들기">복제</button>
        <button class="btn danger small" data-del="${r.id}">삭제</button>
      </div>
    </div>`).join('')}</div>`;
}

function bindList() {
  $('#main').querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = (e) => { if (!e.target.closest('button')) location.hash = '#/r/' + el.dataset.open; };
  });
  $('#main').querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => copyText(records.find((r) => r.id === b.dataset.copy).result); });
  $('#main').querySelectorAll('[data-dup]').forEach((b) => { b.onclick = () => duplicate(b.dataset.dup); });
  $('#main').querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => removeRecord(b.dataset.del); });
}

async function copyText(text) {
  if (!text) return toast('복사할 결과가 없습니다');
  try { await navigator.clipboard.writeText(text); toast('복사했습니다'); }
  catch { toast('복사하지 못했습니다. 직접 드래그해서 복사해 주세요'); }
}

async function duplicate(id) {
  const src = records.find((r) => r.id === id);
  const { id: _, ...rest } = src;
  const data = { ...rest, title: src.title + ' (복사본)', createdAt: Date.now(), updatedAt: Date.now() };
  const ref = await addDoc(userCol('records'), data);
  records.unshift({ id: ref.id, ...data });
  toast('복제했습니다');
  location.hash = '#/r/' + ref.id;
}

async function removeRecord(id) {
  const r = records.find((x) => x.id === id);
  if (!confirm(`"${r.title}" 기록을 삭제할까요? 되돌릴 수 없습니다.`)) return;
  await deleteDoc(userDoc('records', id));
  records = records.filter((x) => x.id !== id);
  toast('삭제했습니다');
  if (editor) editor.dirty = false;
  if (location.hash === '#/r/' + id) location.hash = '#/c/' + r.clientId;
  else route();
}

// ---------- 작성 · 수정 화면 ----------
function defaultTitle(clientId, type) {
  if (type === 'journal') return `${clientRecords(clientId).filter((r) => r.type === 'journal').length + 1}회기 상담일지`;
  return `사례 분석 (${fmtDay(Date.now())})`;
}

function openEditor(src) {
  const type = src.type;
  const hasHistory = clientRecords(src.clientId).some((r) => r.id !== src.id && r.result);
  editor = {
    id: src.id || null,
    clientId: src.clientId,
    type,
    title: src.title || defaultTitle(src.clientId, type),
    inputs: { ...(src.inputs || {}) },
    lenses: src.lenses || prefs['lenses_' + type] || manifest.lenses.filter((l) => l[type]).map((l) => l.id),
    useHistory: src.useHistory ?? hasHistory,
    result: src.result || '',
    createdAt: src.createdAt || null,
    dirty: false,
    editingResult: false,
  };
  renderEditor();
}

function renderEditor() {
  const e = editor;
  const prevCount = clientRecords(e.clientId).filter((r) => r.id !== e.id && r.result).length;
  $('#main').innerHTML = `
    <a class="back" href="#/c/${e.clientId}">← ${esc(clientName(e.clientId))}</a>
    <div class="page-head" style="align-items:center">
      <div style="flex:1;min-width:240px">
        <div class="eyebrow">${TYPE[e.type]}${e.createdAt ? ' · ' + fmtDate(e.createdAt) : ' · 새 기록'}</div>
        <input type="text" class="title-input" id="title" value="${esc(e.title)}" aria-label="제목">
      </div>
    </div>
    <div class="grid">
      <div class="card">
        <h3>${e.type === 'analysis' ? '내담자 정보' : '회기 키워드'}</h3>
        <p class="sub">아는 것만 키워드로 적어도 됩니다. 빈 칸은 건너뜁니다.</p>
        ${manifest.fields[e.type].map((f, i) => `
          <div class="field">
            <label for="f${i}">${esc(f.label)}</label>
            <textarea id="f${i}" data-label="${esc(f.label)}" placeholder="${esc(f.hint || '')}">${esc(e.inputs[f.label] || '')}</textarea>
          </div>`).join('')}
      </div>
      <aside class="side">
        <div class="card">
          <h3>적용할 이론</h3>
          <p class="sub">체크한 이론을 번호 순서대로 빠짐없이 적용합니다.</p>
          <div class="row" style="margin:-4px 0 8px"><button class="link-btn" id="allOn">모두 선택</button><button class="link-btn" id="allOff">모두 해제</button></div>
          <div id="lenses">${manifest.lenses.map((l) => `
            <label class="lens">
              <input type="checkbox" value="${l.id}" ${e.lenses.includes(l.id) ? 'checked' : ''}>
              <span><span class="num">${l.id.slice(0, 2)}</span> <span class="t">${esc(l.title)}</span><div class="d">${esc(l.desc)}</div></span>
            </label>`).join('')}</div>
        </div>
        <div class="card">
          <label class="check">
            <input type="checkbox" id="useHistory" ${e.useHistory ? 'checked' : ''} ${prevCount ? '' : 'disabled'}>
            <span>이 아동의 이전 기록 참고하기
              <small>${prevCount ? `최근 기록 ${Math.min(prevCount, HISTORY_COUNT)}건을 함께 보내 변화와 흐름을 반영합니다` : '아직 참고할 이전 기록이 없습니다'}</small>
            </span>
          </label>
        </div>
        <button class="btn block" id="runBtn">${e.result ? '다시 만들기' : TYPE[e.type] + ' 바로 만들기'}</button>
      </aside>
    </div>

    <div class="card ${e.result ? '' : 'hidden'}" id="outCard" style="margin-top:18px">
      <div class="out-head">
        <h3>${TYPE[e.type]} 결과</h3>
        <div class="row">
          <button class="btn small" id="copyBtn">복사</button>
          <button class="btn ghost small" id="editResultBtn">${e.editingResult ? '수정 완료' : '직접 수정'}</button>
        </div>
      </div>
      <div class="status" id="status"></div>
      <div class="result" id="result"></div>
    </div>

    <div class="savebar">
      <div class="row">
        <button class="btn" id="saveBtn">저장</button>
        <span class="dirty" id="dirtyMark"></span>
      </div>
      <div class="row">
        ${e.id ? '<button class="btn ghost small" id="dupBtn">복제</button><button class="btn danger small" id="delBtn">삭제</button>' : ''}
      </div>
    </div>`;

  renderResult();
  markDirty(e.dirty);

  $('#title').oninput = (ev) => { e.title = ev.target.value; markDirty(true); };
  $('#main').querySelectorAll('textarea[data-label]').forEach((t) => {
    t.oninput = () => { e.inputs[t.dataset.label] = t.value; markDirty(true); };
  });
  const syncLenses = () => {
    e.lenses = [...document.querySelectorAll('#lenses input:checked')].map((i) => i.value);
    prefs['lenses_' + e.type] = e.lenses; savePrefs(prefs); markDirty(true);
  };
  $('#lenses').onchange = syncLenses;
  $('#allOn').onclick = () => { document.querySelectorAll('#lenses input').forEach((i) => (i.checked = true)); syncLenses(); };
  $('#allOff').onclick = () => { document.querySelectorAll('#lenses input').forEach((i) => (i.checked = false)); syncLenses(); };
  $('#useHistory').onchange = (ev) => { e.useHistory = ev.target.checked; markDirty(true); };
  $('#runBtn').onclick = run;
  $('#copyBtn').onclick = () => copyText(e.result);
  $('#editResultBtn').onclick = () => {
    if (e.editingResult) e.result = $('#resultEdit').value;
    e.editingResult = !e.editingResult;
    $('#editResultBtn').textContent = e.editingResult ? '수정 완료' : '직접 수정';
    renderResult();
  };
  $('#saveBtn').onclick = () => saveEditor(false);
  if (e.id) {
    $('#dupBtn').onclick = async () => {
      if (e.dirty) await saveEditor(true);
      duplicate(e.id);
    };
    $('#delBtn').onclick = () => removeRecord(e.id);
  }
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

function markDirty(on) {
  if (!editor) return;
  editor.dirty = on;
  const m = $('#dirtyMark'); if (m) m.textContent = on ? '저장하지 않은 변경 사항이 있습니다' : '';
}

async function saveEditor(silent) {
  const e = editor;
  if (e.editingResult) e.result = $('#resultEdit').value;
  const data = {
    clientId: e.clientId, type: e.type, title: e.title.trim() || defaultTitle(e.clientId, e.type),
    inputs: e.inputs, lenses: e.lenses, useHistory: e.useHistory, result: e.result, updatedAt: Date.now(),
  };
  try {
    if (e.id) {
      await updateDoc(userDoc('records', e.id), data);
      Object.assign(records.find((r) => r.id === e.id), data);
    } else {
      data.createdAt = Date.now();
      const ref = await addDoc(userCol('records'), data);
      e.id = ref.id; e.createdAt = data.createdAt;
      records.unshift({ id: ref.id, ...data });
      setHashSilently('#/r/' + ref.id);
    }
    markDirty(false);
    if (!silent) { toast('저장했습니다'); renderEditor(); }
    renderNav();
  } catch (err) {
    toast('저장하지 못했습니다: ' + err.message);
    throw err;
  }
}

// ---------- 질문문 조립 ----------
function buildPrompt() {
  const e = editor;
  const lenses = manifest.lenses.filter((l) => e.lenses.includes(l.id));
  const filled = manifest.fields[e.type]
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
    const prev = clientRecords(e.clientId)
      .filter((r) => r.id !== e.id && r.result && (!e.createdAt || r.createdAt < e.createdAt))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, HISTORY_COUNT)
      .reverse();
    if (prev.length) {
      out += sep + `# [이전 기록] 같은 아동의 최근 기록 ${prev.length}건 (오래된 순)\n\n이전 기록과 비교해 **변화, 반복되는 주제, 연속성**을 반영하십시오. 이전 기록과 이번 입력 정보가 다르면 이번 입력 정보를 우선하십시오.\n\n`
        + prev.map((r) => `## ${TYPE[r.type]} · ${r.title} · ${fmtDay(r.createdAt)}\n\n${r.result.slice(0, 4000)}`).join('\n\n');
    }
  }

  out += sep + `# [입력 정보]\n\n아동: ${clientName(e.clientId)}\n\n` + filled.map(([k, v]) => `## ${k}\n${v}`).join('\n\n');
  out += sep + `${lenses.length ? '[참고자료]의 이론을 순서대로 빠짐없이 적용해 ' : ''}[출력 양식]에 맞춰 ${task}을 해주십시오. 답변은 한국어 마크다운으로 작성하십시오.`;
  return { system: docs[manifest.role.id], user: out, filledCount: filled.length };
}

// ---------- 제미나이 호출 ----------
async function findModels(key) {
  const res = await fetch(`${GEMINI}/models?pageSize=200&key=${encodeURIComponent(key)}`);
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
  if (!picked.length) throw new Error('이 키로 쓸 수 있는 모델을 찾지 못했습니다.');
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
  if (e.name === 'AbortError') return '중단했습니다.';
  if (e.status === 400 && /API key/i.test(e.message)) return '이용 키가 올바르지 않습니다. 설정에서 키를 다시 확인해 주세요.';
  if (e.status === 403) return '이 키로는 사용할 수 없습니다. 구글 AI 스튜디오에서 키를 새로 만들어 등록해 주세요.';
  if (e.status === 429) return '무료 사용량을 잠시 초과했습니다. 1분 뒤에 다시 시도해 주세요. (하루 사용량을 넘었다면 다음 날 오후 4~5시쯤 초기화됩니다)';
  if (e.status >= 500) return '구글 서버가 잠시 불안정합니다. 조금 뒤 다시 시도해 주세요.';
  if (e instanceof TypeError) return '인터넷 연결을 확인해 주세요.';
  return '문제가 생겼습니다: ' + e.message;
}

async function generate(model, prompt, signal, onText) {
  const res = await fetch(`${GEMINI}/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(profile.geminiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

function setStatus(msg, busy) {
  const s = $('#status'); if (!s) return;
  s.innerHTML = (busy ? '<span class="spinner"></span>' : '') + esc(msg);
}

async function run() {
  const e = editor;
  if (!profile.geminiKey) { toast('먼저 설정에서 AI 이용 키를 등록해 주세요'); location.hash = '#/settings'; return; }
  const prompt = buildPrompt();
  if (!prompt.filledCount) return toast('내용을 하나 이상 입력해 주세요');
  if (e.result && !confirm('지금 결과를 새 결과로 바꿀까요?')) return;

  running?.abort();
  const ctrl = new AbortController(); running = ctrl;
  e.editingResult = false;
  $('#editResultBtn').textContent = '직접 수정';
  $('#outCard').classList.remove('hidden');
  $('#runBtn').disabled = true;
  const before = e.result;
  let partial = '';
  $('#result').innerHTML = '';
  setStatus('자료를 읽고 작성하고 있습니다. 1~2분 정도 걸릴 수 있어요.', true);
  $('#outCard').scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    if (!models) models = await findModels(profile.geminiKey);
    let result = null, lastErr = null;
    for (const model of models.slice(0, 4)) {
      try {
        result = await generate(model, prompt, ctrl.signal, (t) => {
          if (editor !== e) return;
          partial = t; $('#result').innerHTML = DOMPurify.sanitize(marked.parse(t));
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
      ? '구글의 안전 기준 때문에 답변이 만들어지지 않았습니다. 표현을 조금 바꿔서 다시 시도해 주세요.'
      : '빈 답변이 돌아왔습니다. 다시 시도해 주세요.');
    if (editor !== e) return;
    e.result = result.text;
    await saveEditor(true);
    renderEditor();
    setStatus(result.finish === 'MAX_TOKENS'
      ? '답변이 길어서 중간에 끊겼습니다. 이론 수를 줄여서 다시 만들어 보세요. (자동 저장됨)'
      : '완성되어 자동 저장했습니다. 내용을 꼭 검토한 뒤 사용해 주세요.', false);
  } catch (err) {
    if (editor !== e) return;
    if (partial) {
      e.result = partial; markDirty(true);
      setStatus(friendlyError(err) + ' (여기까지 작성된 내용입니다. 필요하면 저장을 눌러주세요)', false);
    } else {
      e.result = before;
      setStatus('', false);
      $('#result').innerHTML = `<div class="error-box">${esc(friendlyError(err))}</div>`;
    }
  } finally {
    if (running === ctrl) running = null;
    const btn = $('#runBtn'); if (btn) btn.disabled = false;
  }
}

// ---------- 설정 ----------
function viewSettings() {
  $('#main').innerHTML = `
    <div class="page-head"><h2>설정</h2></div>
    <div class="stack">
      <div class="card">
        <h3>AI 이용 키 (처음 한 번만)</h3>
        <p class="sub">구글의 무료 AI 이용 키입니다. 카드 등록이 필요 없고, 한 번 등록하면 어느 기기에서 로그인해도 그대로 쓸 수 있습니다.</p>
        <ol class="steps">
          <li><span><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">구글 AI 스튜디오 열기 ↗</a> 를 누르고 같은 구글 계정으로 로그인합니다.</span></li>
          <li><span>약관 동의 화면이 나오면 동의합니다.</span></li>
          <li><span><b>Create API key</b>(API 키 만들기)를 누릅니다.</span></li>
          <li><span>만들어진 키를 복사해서 아래 칸에 붙여넣고 <b>저장</b>을 누릅니다.</span></li>
        </ol>
        <div class="field">
          <label for="keyInput">이용 키</label>
          <input type="password" id="keyInput" placeholder="복사한 키를 붙여넣으세요" autocomplete="off" value="${esc(profile.geminiKey || '')}">
          <div class="key-state ${profile.geminiKey ? 'ok' : ''}" id="keyState">${profile.geminiKey ? '✓ 등록된 키가 있습니다' : ''}</div>
        </div>
        <div class="row">
          <button class="btn small" id="saveKey">저장</button>
          ${profile.geminiKey ? '<button class="btn ghost small" id="removeKey">키 삭제</button>' : ''}
        </div>
      </div>
      <div class="card">
        <h3>계정</h3>
        <p class="sub">${esc(user.email || '')} 으로 로그인되어 있습니다. 아동 ${clients.length}명, 기록 ${records.length}건</p>
      </div>
    </div>`;

  const state = (msg, cls) => { const s = $('#keyState'); s.className = 'key-state ' + (cls || ''); s.textContent = msg; };
  $('#saveKey').onclick = async () => {
    const k = $('#keyInput').value.trim();
    if (!k) return state('키를 붙여넣어 주세요', 'bad');
    $('#saveKey').disabled = true;
    state('키를 확인하고 있습니다…');
    try {
      models = await findModels(k);
      await setDoc(doc(db, 'users', user.uid), { geminiKey: k }, { merge: true });
      profile.geminiKey = k;
      state('✓ 저장했습니다. 이제 기록을 만들 수 있어요', 'ok');
    } catch (e) {
      state(friendlyError(e), 'bad');
    } finally { $('#saveKey').disabled = false; }
  };
  const rm = $('#removeKey');
  if (rm) rm.onclick = async () => {
    if (!confirm('저장된 키를 지울까요?')) return;
    await setDoc(doc(db, 'users', user.uid), { geminiKey: '' }, { merge: true });
    profile.geminiKey = ''; models = null;
    viewSettings();
  };
}

boot();
