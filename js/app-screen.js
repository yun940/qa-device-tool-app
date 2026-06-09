/**
 * QA 디바이스 대여 — 앱 전용 화면 로직 (app.html)
 *
 * 화면 흐름:
 *   로그인 → (디바이스 미바인딩이면 등록) → 메인 (대여/반납/연장)
 */
(function () {
    'use strict';

    const API = () => window.CONFIG && window.CONFIG.API_URL;

    let state = {
        session: null,
        deviceInfo: null,        // QaDeviceInfo.getDeviceInfo() 결과
        resolved: null,          // GAS resolveDevice 결과 (bound: true 일 때 device 포함)
        availableDevices: []     // 디바이스목록 시트의 디바이스명 배열 (등록 화면 드롭다운용)
    };

    // viewport height 보정 (모바일 주소창 가림 대응)
    function setVH() {
        const vh = window.innerHeight * 0.01;
        document.documentElement.style.setProperty('--vh', vh + 'px');
    }
    setVH();
    window.addEventListener('resize', setVH);

    // ============ 유틸 ============

    function $(id) { return document.getElementById(id); }

    function showScreen(id) {
        document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
        const s = $(id);
        if (s) s.classList.add('active');
    }

    function setLoading(on, text) {
        const el = $('appLoading');
        $('appLoadingText').textContent = text || '처리 중…';
        el.classList.toggle('active', !!on);
    }

    function showNotice(text, kind) {
        const el = $('mainNotice');
        if (!el) return;
        el.textContent = text || '';
        el.classList.remove('is-success', 'is-error', 'is-info');
        if (kind) el.classList.add('is-' + kind);
    }

    async function apiCall(action, payload) {
        const url = API();
        if (!url) throw new Error('API_URL이 설정되지 않았습니다.');
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(Object.assign({ action }, payload || {}))
        });
        const data = await res.json();
        return data;
    }

    /**
     * iOS Safari(비-Capacitor) 환경에서는 UA가 보고하는 OS 버전이
     * Apple의 freezing 정책으로 실제 OS 버전과 다를 수 있음.
     * 따라서 정확한 값을 보장할 수 없는 경우 숫자 대신 안내 문구를 표시.
     */
    function osVersionLabel(info) {
        if (info.platform === 'ios' && !info.isNative) {
            return 'iOS (정확한 버전은 IPA 빌드 시 표시)';
        }
        return info.osVersion || '-';
    }

    function fillDebug(targetId, obj) {
        const dl = $(targetId);
        if (!dl) return;
        dl.innerHTML = '';
        Object.keys(obj || {}).forEach(k => {
            const dt = document.createElement('dt');
            dt.textContent = k;
            const dd = document.createElement('dd');
            const v = obj[k];
            dd.textContent = (v && typeof v === 'object') ? JSON.stringify(v) : String(v);
            dl.appendChild(dt);
            dl.appendChild(dd);
        });
    }

    // ============ 1단계: 로그인 화면 ============

    function bindLoginScreen() {
        const form = $('loginForm');
        form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const userId = $('loginUserId').value.trim();
            const errEl = $('loginError');
            errEl.textContent = '';
            if (!userId) { errEl.textContent = '아이디를 입력해주세요.'; return; }

            try {
                setLoading(true, '로그인 중…');
                const session = await window.QaAuth.login(userId);
                state.session = session;
                await afterLogin();
            } catch (e) {
                errEl.textContent = e.message || '로그인 실패';
            } finally {
                setLoading(false);
            }
        });
    }

    // ============ 2단계: 로그인 후 분기 ============

    async function afterLogin() {
        // 디바이스 정보 추출
        setLoading(true, '디바이스 정보 확인 중…');
        state.deviceInfo = await window.QaDeviceInfo.getDeviceInfo();

        // 바인딩 조회
        const res = await apiCall('resolveDevice', { uniqueId: state.deviceInfo.uniqueId });
        if (!res.success) {
            setLoading(false);
            alert('서버 오류: ' + (res.message || '알 수 없음'));
            return;
        }

        if (res.bound) {
            state.resolved = res.device;
            renderMain();
            showScreen('screenMain');
        } else {
            await prepareBindScreen();
            showScreen('screenBindDevice');
        }
        setLoading(false);
    }

    // ============ 3단계: 디바이스 최초 등록 화면 ============

    async function prepareBindScreen() {
        // 디바이스 후보 목록 + 기존 바인딩 동시 조회
        const [statusRes, bindingsRes] = await Promise.all([
            apiCall('getStatus', {}),
            apiCall('listBindings', {})
        ]);
        const devices = (statusRes && statusRes.devices) || [];
        const bindings = (bindingsRes && bindingsRes.bindings) || [];
        state.availableDevices = devices;

        // 디바이스명 → 바인딩된 고유ID 매핑
        const boundMap = {};
        bindings.forEach(b => { boundMap[b.deviceName] = b.uniqueId; });
        const myUniqueId = state.deviceInfo.uniqueId;

        // 중복명 제거 (디바이스목록 + 대여중 합치면 중복 가능)
        const seen = new Set();
        const select = $('bindDeviceSelect');
        select.innerHTML = '<option value="">— 선택 —</option>';

        let hiddenCount = 0;
        devices.forEach(d => {
            if (seen.has(d.deviceName)) return;
            seen.add(d.deviceName);

            const boundTo = boundMap[d.deviceName];
            // 다른 폰에 등록된 디바이스는 숨김
            if (boundTo && boundTo !== myUniqueId) { hiddenCount++; return; }

            const opt = document.createElement('option');
            opt.value = d.deviceName;
            const labelParts = [d.deviceName];
            if (d.category) labelParts.push('(' + d.category + ')');
            if (boundTo === myUniqueId) labelParts.push('· 현재 등록됨');
            opt.textContent = labelParts.join(' ');
            select.appendChild(opt);
        });

        // 자동 추천 — friendlyName이 디바이스명에 포함되는 (필터 후 남은) 항목
        const hint = $('bindGuessHint');
        const visibleOptions = Array.from(select.options).slice(1).map(o => o.value);
        const guessed = state.deviceInfo.friendlyName ? visibleOptions.find(name =>
            name.toLowerCase().includes(state.deviceInfo.friendlyName.toLowerCase())
        ) : null;

        const hiddenSuffix = hiddenCount > 0 ? ` (다른 폰에 이미 등록된 ${hiddenCount}개는 숨김)` : '';
        if (guessed) {
            hint.textContent = `자동 추천: ${guessed} — 맞으면 선택 후 등록하세요.${hiddenSuffix}`;
            select.value = guessed;
        } else if (state.deviceInfo.friendlyName) {
            hint.textContent = `이 폰으로 추정: ${state.deviceInfo.friendlyName} — 정확한 디바이스를 선택하세요.${hiddenSuffix}`;
        } else {
            hint.textContent = `목록에서 이 폰에 해당하는 디바이스를 선택하세요.${hiddenSuffix}`;
        }

        fillDebug('bindDebugInfo', {
            '플랫폼': state.deviceInfo.platform,
            'OS 버전': osVersionLabel(state.deviceInfo),
            '모델 코드': state.deviceInfo.modelCode || '-',
            '숨겨진 디바이스 수': hiddenCount
        });
        // 광고 ID 행 — 복사 버튼 포함이라 fillDebug 뒤에 직접 append
        renderAdIdRow('bindDebugInfo', state.deviceInfo);
    }

    /**
     * 광고 ID 행을 dl에 추가 — 값 표시 + '복사' 버튼
     * 복사 시: 클립보드에 복사 + GAS notifyAdIdCopy 호출 (카카오워크 발송)
     */
    function renderAdIdRow(targetId, info) {
        const dl = document.getElementById(targetId);
        if (!dl || !info) return;
        const platform = (info.platform || '').toLowerCase();
        const label = platform === 'ios' ? 'IDFA' : platform === 'android' ? 'GAID' : '광고 ID';
        const ad = info.adId;

        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.style.display = 'flex';
        dd.style.alignItems = 'center';
        dd.style.gap = '8px';
        dd.style.flexWrap = 'wrap';

        const valueSpan = document.createElement('span');
        valueSpan.style.wordBreak = 'break-all';
        let copyable = false;
        if (!ad) {
            valueSpan.textContent = '(정보 없음)';
        } else if (ad.adId) {
            valueSpan.textContent = ad.adId;
            copyable = true;
            if (ad.limitAdTracking) {
                valueSpan.textContent += ` (제한 ${ad.authStatus || ''})`;
            }
        } else {
            // adId가 비어있는 경우 — 진단 상태별 안내
            const st = ad.authStatus || '';
            const diag = ad._diag || '';
            let msg;
            switch (st) {
                case 'not-native':     msg = '(브라우저 모드)'; break;
                case 'no-capacitor':   msg = '(Capacitor 없음)'; break;
                case 'plugin-missing': msg = '(플러그인 미등록 — 앱 재설치 필요)'; break;
                case 'method-missing': msg = '(메서드 누락 — 앱 재설치 필요)'; break;
                case 'exception':      msg = `(예외: ${diag || 'unknown'})`; break;
                case 'denied':         msg = '(권한 거부)'; break;
                case 'restricted':     msg = '(권한 제한)'; break;
                case 'notDetermined':  msg = '(권한 미결정)'; break;
                case 'error':          msg = `(오류: ${diag || 'GMS 없음'})`; break;
                default:               msg = `(빈 값 / ${st || diag || '?'})`;
            }
            valueSpan.textContent = msg;
        }
        dd.appendChild(valueSpan);

        if (copyable) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = '복사';
            btn.style.padding = '4px 10px';
            btn.style.fontSize = '12px';
            btn.style.border = '1px solid #1976d2';
            btn.style.background = '#fff';
            btn.style.color = '#1976d2';
            btn.style.borderRadius = '6px';
            btn.style.cursor = 'pointer';
            btn.addEventListener('click', () => onCopyAdId(btn, info, label));
            dd.appendChild(btn);
        }

        dl.appendChild(dt);
        dl.appendChild(dd);
    }

    /**
     * 광고 ID 복사 처리 — 클립보드 복사 + 카카오워크 발송
     */
    async function onCopyAdId(btn, info, label) {
        const ad = info && info.adId;
        const value = ad && ad.adId ? String(ad.adId) : '';
        if (!value) return;

        const origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '복사 중…';

        // 1) 클립보드 복사
        let clipboardOK = false;
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(value);
                clipboardOK = true;
            } else {
                // 폴백: 임시 textarea
                const ta = document.createElement('textarea');
                ta.value = value;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                clipboardOK = document.execCommand('copy');
                document.body.removeChild(ta);
            }
        } catch (e) {
            console.warn('클립보드 복사 실패', e);
        }

        // 2) 카카오워크로 전송
        try {
            await apiCall('notifyAdIdCopy', {
                userName: state.session ? state.session.name : '',
                platform: info.platform || '',
                deviceName: info.deviceName || '',
                modelCode: info.modelCode || '',
                adId: value,
                limitAdTracking: !!ad.limitAdTracking,
                authStatus: ad.authStatus || ''
            });
        } catch (e) {
            console.warn('notifyAdIdCopy 호출 실패', e);
        }

        btn.textContent = clipboardOK ? '복사됨' : '복사 실패';
        setTimeout(() => {
            btn.disabled = false;
            btn.textContent = origText;
        }, 1800);
    }

    function bindBindScreen() {
        $('bindConfirmBtn').addEventListener('click', async () => {
            const deviceName = $('bindDeviceSelect').value;
            const errEl = $('bindError');
            errEl.textContent = '';
            if (!deviceName) { errEl.textContent = '디바이스를 선택해주세요.'; return; }

            try {
                setLoading(true, '등록 중…');
                const res = await apiCall('bindDevice', {
                    uniqueId: state.deviceInfo.uniqueId,
                    deviceName: deviceName,
                    platform: state.deviceInfo.platform,
                    modelCode: state.deviceInfo.modelCode
                });
                if (!res.success) { errEl.textContent = res.message || '등록 실패'; return; }
                state.resolved = res.device;

                // 메인 화면 진입 — 상태 재조회
                const r = await apiCall('resolveDevice', { uniqueId: state.deviceInfo.uniqueId });
                if (r.success && r.bound) state.resolved = r.device;
                renderMain();
                showScreen('screenMain');
            } catch (e) {
                errEl.textContent = e.message || '오류 발생';
            } finally {
                setLoading(false);
            }
        });

        $('bindLogoutBtn').addEventListener('click', () => {
            window.QaAuth.logout();
            location.reload();
        });
    }

    // ============ 4단계: 메인 화면 (대여/반납/연장) ============

    function renderMain() {
        const cellSuffix = state.session.cell ? ` · ${state.session.cell}` : '';
        const roleSuffix = state.session.role === 'admin' ? ' (관리자)' : '';
        $('mainGreeting').textContent = `${state.session.name}님${cellSuffix}${roleSuffix}`;
        $('mainDeviceName').textContent = state.resolved.deviceName;
        $('mainDeviceMeta').textContent = [state.resolved.category, state.resolved.modelCode].filter(Boolean).join(' · ');

        const rental = state.resolved.currentRental; // null 또는 { renter, cell, rentDate, expiryDate, ... }
        const statusEl = $('mainDeviceStatus');
        const actionsEl = $('mainActions');
        statusEl.classList.remove('is-available', 'is-rented-mine', 'is-rented-other', 'is-expired');
        actionsEl.innerHTML = '';

        if (!rental) {
            statusEl.textContent = '대여 가능';
            statusEl.classList.add('is-available');
            actionsEl.appendChild(makeBtn('대여하기', 'primary', onRentClick));
        } else {
            const isMine = rental.renter === state.session.name;
            const isAdmin = state.session.role === 'admin';

            if (isMine) {
                statusEl.textContent = `${rental.renter}님이 대여중\n만료 ${rental.expiryDate || '-'}`;
                statusEl.classList.add('is-rented-mine');
                actionsEl.appendChild(makeBtn('연장하기', 'primary', onRenewClick));
                actionsEl.appendChild(makeBtn('반납하기', 'warn', onReturnClick));
            } else {
                statusEl.textContent = `${rental.renter}님이 대여중\n만료 ${rental.expiryDate || '-'}`;
                statusEl.classList.add('is-rented-other');
                if (isAdmin) {
                    actionsEl.appendChild(makeBtn('관리자 반납 (강제)', 'danger', onReturnClick));
                } else {
                    actionsEl.appendChild(makeInfoText('타인 대여 중이라 이 폰에서는 반납할 수 없어요. 관리자에게 문의하세요.'));
                }
            }
        }

        fillDebug('mainDebugInfo', {
            '디바이스명': state.resolved.deviceName,
            '카테고리': state.resolved.category || '-',
            '플랫폼': state.deviceInfo.platform,
            'OS 버전': osVersionLabel(state.deviceInfo),
            '모델 코드': state.deviceInfo.modelCode || '-'
        });
        // 광고 ID 행 — 복사 버튼 포함
        renderAdIdRow('mainDebugInfo', state.deviceInfo);

        showNotice('');
    }

    function makeBtn(text, kind, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'app-btn app-btn-' + kind;
        b.textContent = text;
        b.addEventListener('click', onClick);
        return b;
    }

    function makeInfoText(text) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.style.textAlign = 'center';
        p.style.marginTop = '8px';
        p.textContent = text;
        return p;
    }

    async function refreshCurrent() {
        const r = await apiCall('resolveDevice', { uniqueId: state.deviceInfo.uniqueId });
        if (r.success && r.bound) state.resolved = r.device;
        renderMain();
    }

    /**
     * 대여/갱신 성공 응답을 받아 로컬 알림 4개를 예약 (Capacitor 환경에서만)
     */
    async function scheduleLocalAlerts(data) {
        if (!window.NotificationManager || !window.NotificationManager.isAvailable()) return;
        if (!data || !data.expiryDate) return;
        try {
            const perm = await window.NotificationManager.requestPermission();
            if (!perm.granted) {
                console.log('[Notif] 알림 권한 없음 — 예약 생략');
                return;
            }
            await window.NotificationManager.scheduleRentalNotifications(
                data.deviceId || data.deviceName,
                data.deviceName,
                data.expiryDate
            );
        } catch (e) {
            console.warn('[Notif] 예약 실패', e);
        }
    }

    // 액션: 대여 — 사용자 셀이 등록되어 있으면 바로 대여, 없으면 셀 선택 모달
    function onRentClick() {
        const userCell = state.session && state.session.cell;
        if (userCell) {
            doRent(userCell);
        } else {
            $('cellModal').classList.add('active');
        }
    }

    async function doRent(cell) {
        try {
            setLoading(true, '대여 중…');
            const res = await apiCall('rent', {
                deviceId: state.resolved.deviceName,
                deviceName: state.resolved.deviceName,
                renterName: state.session.name,
                cell: cell
            });
            if (!res.success) { showNotice(res.message || '대여 실패', 'error'); return; }
            showNotice(res.message || '대여 완료', 'success');
            await scheduleLocalAlerts(res.data);
            await refreshCurrent();
        } catch (e) {
            showNotice(e.message || '오류', 'error');
        } finally {
            setLoading(false);
        }
    }

    function bindCellModal() {
        $('cellCancelBtn').addEventListener('click', () => $('cellModal').classList.remove('active'));
        document.querySelectorAll('.app-cell-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const cell = btn.dataset.cell;
                $('cellModal').classList.remove('active');
                await doRent(cell);
            });
        });
    }

    async function onRenewClick() {
        if (!confirm('이 디바이스 대여를 연장할까요?')) return;
        try {
            setLoading(true, '연장 중…');
            const res = await apiCall('renew', { deviceId: state.resolved.deviceName });
            if (!res.success) { showNotice(res.message || '연장 실패', 'error'); return; }
            showNotice(res.message || '연장 완료', 'success');
            await scheduleLocalAlerts(res.data);
            await refreshCurrent();
        } catch (e) {
            showNotice(e.message || '오류', 'error');
        } finally {
            setLoading(false);
        }
    }

    async function onReturnClick() {
        const rental = state.resolved.currentRental;
        const isMine = rental && rental.renter === state.session.name;
        const msg = isMine ? '반납하시겠어요?' : `[관리자] ${rental.renter}님이 빌린 디바이스를 강제 반납합니다. 진행할까요?`;
        if (!confirm(msg)) return;
        try {
            setLoading(true, '반납 중…');
            const res = await apiCall('return', { deviceId: state.resolved.deviceName });
            if (!res.success) { showNotice(res.message || '반납 실패', 'error'); return; }

            // 예약된 로컬 알림 제거 (반납자 본인 폰 기준)
            if (window.NotificationManager) {
                await window.NotificationManager.cancelRentalNotifications(state.resolved.deviceName);
            }

            if (isMine) {
                // 본인 반납 — 다음 사용자를 위해 자동 로그아웃
                showNotice('반납 완료 — 다음 사용자를 위해 로그아웃됩니다.', 'success');
                setLoading(false);
                setTimeout(() => {
                    window.QaAuth.logout();
                    location.reload();
                }, 1800);
                return;
            }

            // 관리자 강제 반납 — 그대로 머묾 (여러 건 처리 편의)
            showNotice(res.message || '반납 완료', 'success');
            await refreshCurrent();
        } catch (e) {
            showNotice(e.message || '오류', 'error');
        } finally {
            setLoading(false);
        }
    }

    function bindMainScreen() {
        $('mainLogoutBtn').addEventListener('click', () => {
            if (!confirm('로그아웃하시겠어요?')) return;
            window.QaAuth.logout();
            location.reload();
        });
        $('mainRebindBtn').addEventListener('click', async () => {
            if (!confirm('이 폰의 디바이스 등록을 다시 진행할까요?')) return;
            await prepareBindScreen();
            showScreen('screenBindDevice');
        });
    }

    // ============ 초기화 ============

    async function init() {
        bindLoginScreen();
        bindBindScreen();
        bindMainScreen();
        bindCellModal();

        // 로컬 알림 채널 준비 (Android) — 비-Capacitor 환경에선 no-op
        if (window.NotificationManager) {
            window.NotificationManager.ensureChannel().catch(() => {});
        }

        const session = window.QaAuth.loadSession();
        if (session) {
            state.session = session;
            await afterLogin();
        } else {
            showScreen('screenLogin');
        }
    }

    document.addEventListener('DOMContentLoaded', init);
})();
