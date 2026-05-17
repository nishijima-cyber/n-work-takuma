// ═══════════════════════════════════════════════
// N-WORK 軽量認証モジュール  auth.js  v2.1
// ═══════════════════════════════════════════════
'use strict';

const AUTH = (() => {
  /* ── storage keys ── */
  const SESSION_KEY       = 'nw_session';
  const PIN_KEY           = 'nw_pins';
  const LOGIN_MEMBERS_KEY = 'nw_login_members';
  const ADMIN_KEY         = 'nw_admins';

  /* ── djb2 hash ── */
  function _hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
    return (h >>> 0).toString(16);
  }

  /* ── session ── */
  function _setSession(name) { localStorage.setItem(SESSION_KEY, name); }
  function getSession()      { return localStorage.getItem(SESSION_KEY) || ''; }
  function logout()          { localStorage.removeItem(SESSION_KEY); location.reload(); }

  /* ── PIN ── */
  function _getPins() {
    try { return JSON.parse(localStorage.getItem(PIN_KEY) || '{}'); } catch(e) { return {}; }
  }
  function hasPin(name)      { return !!_getPins()[name]; }
  function setPin(name, pin) {
    const pins = _getPins();
    pins[name] = _hash(pin);
    localStorage.setItem(PIN_KEY, JSON.stringify(pins));
  }
  function _checkPin(name, pin) { return _getPins()[name] === _hash(pin); }

  /* ── login members ── */
  function getLoginMembers() {
    try { return JSON.parse(localStorage.getItem(LOGIN_MEMBERS_KEY) || '[]'); } catch(e) { return []; }
  }
  function addLoginMember(name) {
    const members = getLoginMembers();
    if (!members.includes(name)) {
      members.push(name);
      localStorage.setItem(LOGIN_MEMBERS_KEY, JSON.stringify(members));
    }
  }
  function removeLoginMember(name) {
    const members = getLoginMembers().filter(m => m !== name);
    localStorage.setItem(LOGIN_MEMBERS_KEY, JSON.stringify(members));
    const pins = _getPins(); delete pins[name];
    localStorage.setItem(PIN_KEY, JSON.stringify(pins));
    _setAdmin(name, false);
  }

  /* ── admins ── */
  function getAdmins() {
    try { return JSON.parse(localStorage.getItem(ADMIN_KEY) || '[]'); } catch(e) { return []; }
  }
  function isAdmin(name) {
    name = name || getSession();
    const admins = getAdmins();
    if (admins.length === 0) return true;
    return admins.includes(name);
  }
  function _setAdmin(name, flag) {
    let admins = getAdmins();
    if (flag) { if (!admins.includes(name)) admins.push(name); }
    else       { admins = admins.filter(a => a !== name); }
    localStorage.setItem(ADMIN_KEY, JSON.stringify(admins));
  }

  /* ── compat ── */
  function syncUsers() {}
  function log(msg) { console.log('[AUTH]', msg); }

  /* ── updateUserChip ── */
  function updateUserChip() {
    const chip     = document.getElementById('userChip');
    const chipName = document.getElementById('userChipName');
    const session  = getSession();
    if (!chip) return;
    if (session) {
      if (chipName) chipName.textContent = session;
      chip.classList.remove('hidden');
    } else {
      chip.classList.add('hidden');
    }
  }

  /* ── _setupChipMenu ── */
  function _setupChipMenu() {
    updateUserChip();
    const chip         = document.getElementById('userChip');
    const menu         = document.getElementById('userMenu');
    const changePinBtn = document.getElementById('changePinBtn');
    const logoutBtn    = document.getElementById('logoutBtn');
    if (!chip || !menu) return;

    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });
    document.addEventListener('click', () => menu.classList.add('hidden'));

    if (isAdmin()) {
      let mgmtBtn = document.getElementById('userMgmtBtn');
      if (!mgmtBtn) {
        mgmtBtn = document.createElement('button');
        mgmtBtn.type = 'button';
        mgmtBtn.id   = 'userMgmtBtn';
        mgmtBtn.textContent = '👥 ユーザー管理';
        mgmtBtn.addEventListener('click', () => {
          menu.classList.add('hidden');
          showUserManagement();
        });
        menu.insertBefore(mgmtBtn, changePinBtn || menu.firstChild);
      }
    }

    if (changePinBtn) {
      changePinBtn.addEventListener('click', () => {
        menu.classList.add('hidden');
        showChangePin();
      });
    }
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        menu.classList.add('hidden');
        if (confirm('ログアウトしますか？')) logout();
      });
    }
  }

  /* ── showChangePin ── */
  function showChangePin() {
    const name = getSession();
    if (!name) return;
    const pin = prompt('新しいPINを4桁で入力してください');
    if (pin === null) return;
    if (!/^\d{4}$/.test(pin)) { alert('4桁の数字を入力してください'); return; }
    setPin(name, pin);
    alert('PINを変更しました');
  }

  /* ── showUserManagement ── */
  function showUserManagement() {
    const existing = document.getElementById('userMgmtModal');
    if (existing) existing.remove();

    const ov = document.createElement('div');
    ov.id = 'userMgmtModal';
    ov.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.75);' +
      'z-index:9999;display:flex;align-items:center;justify-content:center;';

    const card = document.createElement('div');
    card.style.cssText =
      'background:#1a1a2e;border:1px solid rgba(255,255,255,0.2);' +
      'border-radius:16px;padding:24px;width:360px;max-height:80vh;' +
      'overflow-y:auto;color:#fff;font-family:sans-serif;';

    function renderModal() {
      card.innerHTML = '';

      const title = document.createElement('h2');
      title.textContent = '👥 ユーザー管理';
      title.style.cssText = 'margin:0 0 16px;font-size:18px;text-align:center;';
      card.appendChild(title);

      const addRow = document.createElement('div');
      addRow.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;';
      const addInput = document.createElement('input');
      addInput.type = 'text';
      addInput.placeholder = '名前を入力';
      addInput.style.cssText =
        'flex:1;padding:8px;border-radius:8px;' +
        'border:1px solid rgba(255,255,255,0.3);' +
        'background:rgba(255,255,255,0.1);color:#fff;font-size:14px;';
      const addBtn = document.createElement('button');
      addBtn.textContent = '追加';
      addBtn.style.cssText =
        'padding:8px 14px;border-radius:8px;border:none;' +
        'background:#4a9eff;color:#fff;cursor:pointer;font-size:14px;';
      addBtn.addEventListener('click', () => {
        const n = addInput.value.trim();
        if (!n) { alert('名前を入力してください'); return; }
        addLoginMember(n);
        addInput.value = '';
        renderModal();
      });
      addRow.appendChild(addInput);
      addRow.appendChild(addBtn);
      card.appendChild(addRow);

      const members = getLoginMembers();
      const admins  = getAdmins();
      if (members.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = 'ユーザーが登録されていません';
        empty.style.cssText = 'text-align:center;opacity:0.6;font-size:13px;';
        card.appendChild(empty);
      } else {
        members.forEach(m => {
          const row = document.createElement('div');
          row.style.cssText =
            'display:flex;align-items:center;gap:8px;' +
            'padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.1);';

          const nameSpan = document.createElement('span');
          nameSpan.textContent = m;
          nameSpan.style.cssText = 'flex:1;font-size:14px;';
          row.appendChild(nameSpan);

          const adminChk = document.createElement('input');
          adminChk.type    = 'checkbox';
          adminChk.title   = '管理者';
          adminChk.checked = (admins.length === 0) || admins.includes(m);
          adminChk.style.cssText = 'cursor:pointer;width:16px;height:16px;';
          adminChk.addEventListener('change', () => {
            _setAdmin(m, adminChk.checked);
            renderModal();
          });
          row.appendChild(adminChk);

          const adminLabel = document.createElement('label');
          adminLabel.textContent = '管理';
          adminLabel.style.cssText = 'font-size:11px;opacity:0.7;cursor:pointer;margin-right:4px;';
          adminLabel.addEventListener('click', () => adminChk.click());
          row.appendChild(adminLabel);

          const delBtn = document.createElement('button');
          delBtn.textContent = '削除';
          delBtn.style.cssText =
            'padding:4px 10px;border-radius:6px;border:none;' +
            'background:#e74c3c;color:#fff;cursor:pointer;font-size:12px;';
          delBtn.addEventListener('click', () => {
            if (confirm('「' + m + '」を削除しますか？')) {
              removeLoginMember(m);
              renderModal();
            }
          });
          row.appendChild(delBtn);
          card.appendChild(row);
        });
      }

      const closeBtn = document.createElement('button');
      closeBtn.textContent = '閉じる';
      closeBtn.style.cssText =
        'display:block;width:100%;margin-top:16px;padding:10px;' +
        'border-radius:8px;border:none;background:rgba(255,255,255,0.15);' +
        'color:#fff;cursor:pointer;font-size:14px;';
      closeBtn.addEventListener('click', () => ov.remove());
      card.appendChild(closeBtn);
    }

    renderModal();
    ov.appendChild(card);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
  }

  /* ── showLoginIfNeeded ── */
  function showLoginIfNeeded(onSuccess) {
    if (getSession()) { onSuccess(); _setupChipMenu(); return; }

    const overlay = document.getElementById('loginOverlay');
    if (!overlay) {
      console.error('[AUTH] #loginOverlay が見つかりません');
      onSuccess(); return;
    }
    overlay.classList.remove('hidden');
    overlay.style.display = '';

    const step1     = document.getElementById('loginStep1');
    const step2     = document.getElementById('loginStep2');
    const nameGrid  = document.getElementById('loginNameGrid');
    const selNameEl = document.getElementById('loginSelName');
    const pinLabel  = document.getElementById('loginPinLabel');
    const pinDots   = document.getElementById('loginPinDots');
    const loginMsg  = document.getElementById('loginMsg');
    const keypad    = document.getElementById('loginKeypad');
    const backBtn   = document.getElementById('loginBack');

    let who = '', buf = '', tmp = '', mode = 'enter';

    function setMsg(m) { if (loginMsg) loginMsg.textContent = m; }
    function resetBuf() { buf = ''; _renderDots(); }
    function _renderDots() {
      if (!pinDots) return;
      pinDots.innerHTML = '';
      for (let i = 0; i < 4; i++) {
        const d = document.createElement('span');
        d.className = 'pin-dot' + (i < buf.length ? ' filled' : '');
        pinDots.appendChild(d);
      }
    }
    _renderDots();

    function _success() {
      overlay.classList.add('hidden');
      overlay.style.display = 'none';
      onSuccess();
      _setupChipMenu();
    }

    function selectName(name) {
      who = name;
      if (selNameEl) selNameEl.textContent = name;
      resetBuf(); tmp = '';
      mode = hasPin(name) ? 'enter' : 'setup';
      if (pinLabel) pinLabel.textContent = mode === 'enter' ? 'PIN を入力' : 'PIN 設定（4桁）';
      setMsg(mode === 'enter' ? '' : '初回です。自分のPINを決めてください');
      if (step1) step1.style.display = 'none';
      if (step2) step2.style.display = '';
    }

    function renderNames() {
      const names = getLoginMembers();
      if (!nameGrid) return;
      nameGrid.innerHTML = '';
      if (names.length === 0) {
        nameGrid.innerHTML =
          '<p class="login-no-member">ユーザー未登録<br>' +
          '<small>管理者にユーザー登録を依頼してください</small></p>';
        const sk = document.createElement('button');
        sk.className   = 'login-name-btn login-skip';
        sk.textContent = 'スキップ（初回設定）';
        sk.addEventListener('click', () => { _setSession('管理者'); _success(); });
        nameGrid.appendChild(sk);
      } else {
        names.forEach(n => {
          const btn = document.createElement('button');
          btn.className   = 'login-name-btn';
          btn.textContent = n;
          btn.addEventListener('click', () => selectName(n));
          nameGrid.appendChild(btn);
        });
      }
    }
    renderNames();

    if (keypad) {
      keypad.addEventListener('click', (e) => {
        const key = e.target.closest('button') && e.target.closest('button').dataset.key;
        if (!key) return;
        if (key === 'back') { buf = buf.slice(0, -1); _renderDots(); return; }
        if (key === 'C')    { resetBuf(); return; }
        if (buf.length >= 4) return;
        buf += key; _renderDots();

        if (buf.length === 4) {
          if (mode === 'enter') {
            if (_checkPin(who, buf)) {
              _setSession(who); _success();
            } else {
              setMsg('PINが違います'); resetBuf();
            }
          } else if (mode === 'setup') {
            tmp = buf; buf = ''; _renderDots();
            if (pinLabel) pinLabel.textContent = 'もう一度入力';
            setMsg('確認のため、もう一度入力してください');
            mode = 'confirm';
          } else if (mode === 'confirm') {
            if (buf === tmp) {
              setPin(who, buf); _setSession(who); _success();
            } else {
              setMsg('一致しません。もう一度');
              tmp = ''; resetBuf(); mode = 'setup';
              if (pinLabel) pinLabel.textContent = 'PIN 設定（4桁）';
            }
          }
        }
      });
    }

    if (backBtn) {
      backBtn.addEventListener('click', () => {
        if (step2) step2.style.display = 'none';
        if (step1) step1.style.display = '';
        resetBuf(); who = ''; tmp = ''; mode = 'enter';
        setMsg('');
        renderNames();
      });
    }
  }

  /* ── public API ── */
  return {
    getSession,
    login: () => {},
    setPin,
    hasPin,
    logout,
    syncUsers,
    log,
    updateUserChip,
    showLoginIfNeeded,
    showChangePin,
    getLoginMembers,
    addLoginMember,
    removeLoginMember,
    isAdmin,
    showUserManagement
  };
})();
