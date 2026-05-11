(function () {
    const USER_PASSWORD = '0401';
    const STORAGE_KEY = 'userAccessGranted';

    const gate = document.getElementById('accessGate');
    const input = document.getElementById('accessGateInput');
    const btn = document.getElementById('accessGateBtn');
    const errEl = document.getElementById('accessGateError');
    if (!gate || !input || !btn) return;

    let granted = false;
    try { granted = localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) {}

    if (granted) {
        gate.classList.add('hidden');
        document.documentElement.classList.add('access-granted');
        return;
    }

    document.documentElement.classList.remove('access-granted');
    setTimeout(() => input.focus(), 50);

    function unlock() {
        const pw = (input.value || '').trim();
        if (pw === USER_PASSWORD) {
            try { localStorage.setItem(STORAGE_KEY, '1'); } catch (e) {}
            document.documentElement.classList.add('access-granted');
            gate.classList.add('hidden');
            errEl.textContent = '';
        } else {
            errEl.textContent = '비밀번호가 일치하지 않습니다.';
            input.focus();
            input.select();
        }
    }

    btn.addEventListener('click', unlock);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); unlock(); }
        if (errEl.textContent) errEl.textContent = '';
    });
})();
