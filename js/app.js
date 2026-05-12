/**
 * 디바이스 대여/반납 시스템 - 메인 애플리케이션
 */

function setVH() {
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
}
setVH();
window.addEventListener('resize', setVH);

class DeviceRentalApp {
    constructor() {
        this._rentStatusDevice = null;
        this._selectionMode = false;
        this._selectedIds = new Set();
        this._searchQuery = '';
        this._bulkRentMode = false;
        this._bulkRentDevices = [];
        this._filters = { rented: 'all', available: 'all' };
        this.init();
    }

    init() {
        this._applyRole();
        this.bindEvents();
        this.checkApiConfig();
        this.handleQrDeepLink();
        this.loadDevices();
        this._startHeartbeat();
        this._startStatusTicker();
    }

    /**
     * 페이지를 열어둔 채로 시간이 지나면 '곧 만료'/'연체' 태그가 자동 갱신되도록
     * 30초마다 _rerender 호출 (API 재호출 없이 현재 데이터만 재계산)
     * 5분마다 loadDevices로 서버 데이터까지 갱신
     */
    _startStatusTicker() {
        if (this._statusTicker) clearInterval(this._statusTicker);
        if (this._statusRefreshTimer) clearInterval(this._statusRefreshTimer);

        this._statusTicker = setInterval(() => {
            if (document.hidden) return;
            if (this._allDevices && this._allDevices.length > 0) {
                this._rerender();
            }
        }, 30 * 1000);

        this._statusRefreshTimer = setInterval(() => {
            if (document.hidden) return;
            this.loadDevices();
        }, 5 * 60 * 1000);
    }

    /**
     * 관리자 여부 확인 (sessionStorage 플래그)
     */
    _isAdmin() {
        return sessionStorage.getItem('isAdmin') === '1';
    }

    /**
     * 현재 역할을 body[data-role]에 반영 + 역할 배지 갱신
     */
    _applyRole() {
        const isAdmin = this._isAdmin();
        document.body.dataset.role = isAdmin ? 'admin' : 'general';
        const badge = document.getElementById('roleBadge');
        if (badge) {
            badge.textContent = isAdmin ? '관리자' : '일반';
            badge.classList.toggle('role-admin', isAdmin);
            badge.classList.toggle('role-general', !isAdmin);
        }
    }

    /**
     * 관리자 로그인 모달 열기
     */
    _openAdminLogin() {
        const modal = document.getElementById('adminLoginModal');
        const input = document.getElementById('adminPasswordInput');
        const errEl = document.getElementById('adminLoginError');
        if (input) input.value = '';
        if (errEl) errEl.textContent = '';
        modal.classList.add('active');
        setTimeout(() => { if (input) input.focus(); }, 50);
    }

    _closeAdminLogin() {
        document.getElementById('adminLoginModal').classList.remove('active');
    }

    /**
     * 비밀번호 검증 후 관리자 모드 전환
     */
    _confirmAdminLogin() {
        const input = document.getElementById('adminPasswordInput');
        const errEl = document.getElementById('adminLoginError');
        const pw = (input && input.value) || '';
        if (pw === CONFIG.ADMIN_PASSWORD) {
            sessionStorage.setItem('isAdmin', '1');
            this._applyRole();
            this._closeAdminLogin();
            if (document.getElementById('mainScreen').classList.contains('active')) {
                this._rerender();
            }
        } else {
            if (errEl) errEl.textContent = '비밀번호가 일치하지 않습니다.';
            if (input) { input.focus(); input.select(); }
        }
    }

    _logoutAdmin() {
        sessionStorage.removeItem('isAdmin');
        this._applyRole();
        if (this._selectionMode) this.exitSelectionMode();
        if (document.getElementById('mainScreen').classList.contains('active')) {
            this._rerender();
        }
    }

    /**
     * 디바이스 추가 모달 열기 — 시트 1행에서 받아온 카테고리들을 select에 채움
     */
    _openAddDevice() {
        const modal = document.getElementById('addDeviceModal');
        const catSelect = document.getElementById('addDeviceCategory');
        const nameInput = document.getElementById('addDeviceName');
        const errEl = document.getElementById('addDeviceError');

        if (nameInput) nameInput.value = '';
        if (errEl) errEl.textContent = '';

        if (catSelect) {
            // 서버에서 받은 카테고리(시트 1행) 우선, 없으면 _allDevices에서 추출
            let cats = Array.isArray(this._categories) ? this._categories.slice() : [];
            if (cats.length === 0) {
                cats = [...new Set((this._allDevices || []).map(d => this._getCategory(d)))]
                    .filter(c => c);
            }
            const esc = (s) => this._escapeHtml(s);
            catSelect.innerHTML = `<option value="" disabled selected>카테고리를 선택하세요</option>`
                + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
        }

        modal.classList.add('active');
        setTimeout(() => { if (catSelect) catSelect.focus(); }, 50);
    }

    _closeAddDevice() {
        document.getElementById('addDeviceModal').classList.remove('active');
    }

    async _confirmAddDevice() {
        const catInput = document.getElementById('addDeviceCategory');
        const nameInput = document.getElementById('addDeviceName');
        const errEl = document.getElementById('addDeviceError');
        const category = (catInput.value || '').trim();
        const deviceName = (nameInput.value || '').trim();

        if (!category) { errEl.textContent = '카테고리를 입력해주세요.'; catInput.focus(); return; }
        if (!deviceName) { errEl.textContent = '디바이스명을 입력해주세요.'; nameInput.focus(); return; }

        errEl.textContent = '';
        this.showLoading(true);
        try {
            const response = await this.callApi({
                action: 'addDevice',
                category: category,
                deviceName: deviceName
            });
            this.showLoading(false);

            if (response && response.success) {
                this._closeAddDevice();
                alert(`디바이스 추가 완료\n${category} / ${deviceName}`);
                this.loadDevices();
            } else {
                errEl.textContent = (response && response.message) || '추가 실패';
                nameInput.focus();
            }
        } catch (error) {
            this.showLoading(false);
            errEl.textContent = '오류: ' + (error.message || error);
        }
    }

    /**
     * 접속 인원 heartbeat — 30초마다 sessionId 전송, 응답의 활성 세션 수 표시
     */
    _startHeartbeat() {
        if (!this._sessionId) {
            this._sessionId = sessionStorage.getItem('sessionId');
            if (!this._sessionId) {
                this._sessionId = 'sess_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
                sessionStorage.setItem('sessionId', this._sessionId);
            }
        }
        this._sendHeartbeat();
        if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = setInterval(() => this._sendHeartbeat(), 30000);
    }

    async _sendHeartbeat() {
        try {
            const response = await this.callApi({ action: 'heartbeat', sessionId: this._sessionId });
            if (response && response.success && typeof response.count === 'number') {
                const countEl = document.getElementById('visitorCount');
                if (countEl) countEl.textContent = response.count;
            }
        } catch (err) {
            // heartbeat 실패는 조용히 무시 (배지에 - 유지)
        }
    }

    /**
     * QR 스캔으로 진입한 경우(?id=... 파라미터) 자동으로 대여/반납 모달 표시
     */
    async handleQrDeepLink() {
        const params = new URLSearchParams(window.location.search);
        const deviceId = params.get('d') || params.get('id');
        if (!deviceId) return;

        const deviceName = params.get('name') || '';
        history.replaceState(null, '', window.location.pathname);

        await this.openDeviceActionById(deviceId, deviceName);
    }

    /**
     * deviceId로 현재 상태 조회 후 대여/반납 모달 표시 (QR 스캔 공통)
     * 저장된 이름·셀이 있으면 모달 없이 바로 진행
     */
    async openDeviceActionById(deviceId, deviceName) {
        this.showLoading(true);
        try {
            const response = await this.callApi({ action: 'getStatus' });
            this.showLoading(false);

            if (!response || !response.success) {
                alert('디바이스 정보를 불러오지 못했습니다.');
                return;
            }

            const device = (response.devices || []).find(d => d.deviceId === deviceId);
            if (!device) {
                alert(`등록되지 않은 디바이스입니다: ${deviceName || deviceId}`);
                return;
            }

            // 저장된 이름·셀이 있을 때:
            //  - 디바이스가 비어있으면 자동 대여
            //  - 현재 대여자와 저장된 이름이 같으면 자동 갱신
            //  - 그 외 (다른 사람이 대여 중) 모달 표시 — 반납 선택 가능
            if (this._hasAutoRent()) {
                const savedName = localStorage.getItem('rentRenterName');
                if (device.status !== 'rented') {
                    await this._autoRentOrReturn(device);
                    return;
                }
                if (savedName && device.renter && String(device.renter).trim() === savedName.trim()) {
                    await this._autoRenew(device);
                    return;
                }
            }

            this.showDeviceAction(device, 'qr');
        } catch (error) {
            this.showLoading(false);
            alert('오류 발생: ' + (error.message || error));
        }
    }

    _hasAutoRent() {
        return localStorage.getItem('rentAutoSkip') === '1'
            && !!localStorage.getItem('rentRenterName')
            && !!localStorage.getItem('rentRenterCell');
    }

    async _autoRenew(device) {
        const label = device.deviceName || device.deviceId;
        this.showLoading(true);
        try {
            const response = await this.callApi({
                action: 'renew',
                deviceId: device.deviceId,
                deviceName: device.deviceName
            });
            this.showLoading(false);

            if (response && response.success) {
                const newExpiry = (response.data && response.data.expiryDate) || '';
                alert(`${label} 갱신 완료${newExpiry ? `\n새 만료일시: ${newExpiry}` : ''}`);
                this.loadDevices();
            } else {
                alert('갱신 실패: ' + ((response && response.message) || '알 수 없는 오류'));
            }
        } catch (err) {
            this.showLoading(false);
            alert('오류: ' + (err.message || err));
        }
    }

    async _autoRentOrReturn(device) {
        const isRented = device.status === 'rented';
        const name = localStorage.getItem('rentRenterName');
        const cell = localStorage.getItem('rentRenterCell');
        const label = device.deviceName || device.deviceId;

        this.showLoading(true);
        try {
            const payload = isRented
                ? { action: 'return', deviceId: device.deviceId, deviceName: device.deviceName }
                : { action: 'rent', deviceId: device.deviceId, deviceName: device.deviceName, renterName: name, cell: cell };
            const response = await this.callApi(payload);
            this.showLoading(false);

            if (response && response.success) {
                alert(`${label} ${isRented ? '반납' : '대여'} 완료 (${isRented ? '' : cell + ' · '}${name})`);
                this.loadDevices();
            } else {
                alert((isRented ? '반납' : '대여') + ' 실패: ' + ((response && response.message) || '알 수 없는 오류'));
            }
        } catch (err) {
            this.showLoading(false);
            alert('오류: ' + (err.message || err));
        }
    }

    /**
     * 촬영된 이미지에서 QR 디코딩 → 대여/반납 모달 열기
     */
    /**
     * 라이브 스캐너 시작 — getUserMedia 직접 호출 + BarcodeDetector/jsQR 디코딩 루프
     */
    async startLiveScanner() {
        this.showScreen('qrScanScreen');
        const statusEl = document.getElementById('qrScanStatus');
        const video = document.getElementById('qrVideo');

        statusEl.textContent = '카메라를 여는 중...';
        await this.stopLiveScanner();
        this._qrDetected = false;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1920 },
                    height: { ideal: 1080 }
                },
                audio: false
            });
            this._qrStream = stream;
            video.srcObject = stream;
            await video.play();

            const track = stream.getVideoTracks()[0];
            const { width, height } = track.getSettings();
            statusEl.textContent = `QR을 중앙에 맞추면 자동 인식됩니다. (${width}×${height})`;

            // BarcodeDetector 우선, 없으면 jsQR
            const hasDetector = 'BarcodeDetector' in window;
            const detector = hasDetector ? new BarcodeDetector({ formats: ['qr_code'] }) : null;

            this._qrCanvas = document.createElement('canvas');
            this._qrCtx = this._qrCanvas.getContext('2d', { willReadFrequently: true });

            const loop = async () => {
                if (!this._qrStream || this._qrDetected) return;
                if (video.readyState >= 2) {
                    try {
                        const decoded = await this._scanVideoFrame(video, detector);
                        if (decoded) {
                            this._qrDetected = true;
                            await this.stopLiveScanner();
                            this.showScreen('mainScreen');
                            await this._handleDecodedQr(decoded);
                            return;
                        }
                    } catch (e) {
                        console.warn('scan error:', e);
                    }
                }
                this._qrRafId = requestAnimationFrame(loop);
            };
            this._qrRafId = requestAnimationFrame(loop);
        } catch (err) {
            console.error('getUserMedia failed:', err);
            statusEl.textContent = '카메라 시작 실패: ' + (err.message || err);
        }
    }

    async stopLiveScanner() {
        if (this._qrRafId) {
            cancelAnimationFrame(this._qrRafId);
            this._qrRafId = null;
        }
        if (this._qrStream) {
            this._qrStream.getTracks().forEach(t => t.stop());
            this._qrStream = null;
        }
        const video = document.getElementById('qrVideo');
        if (video) { video.pause(); video.srcObject = null; }
    }

    async _scanVideoFrame(video, detector) {
        // BarcodeDetector가 있으면 video 요소 직접 사용 (빠름)
        if (detector) {
            try {
                const results = await detector.detect(video);
                if (results && results.length > 0) return results[0].rawValue;
                return null;
            } catch (e) {
                // iOS 등에서 video 직접 입력 실패 시 canvas 경유
            }
        }

        // canvas로 프레임 캡처
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) return null;

        // 긴 변 800px로 다운스케일 (성능)
        const scale = Math.min(1, 800 / Math.max(vw, vh));
        const w = Math.round(vw * scale);
        const h = Math.round(vh * scale);
        this._qrCanvas.width = w;
        this._qrCanvas.height = h;
        this._qrCtx.drawImage(video, 0, 0, w, h);

        if (detector) {
            try {
                const results = await detector.detect(this._qrCanvas);
                if (results && results.length > 0) return results[0].rawValue;
            } catch {}
        }

        if (typeof jsQR !== 'undefined') {
            const imageData = this._qrCtx.getImageData(0, 0, w, h);
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: 'dontInvert'
            });
            if (code) return code.data;
        }
        return null;
    }

    async _handleDecodedQr(decoded) {
        let deviceId = '';
        let deviceName = '';
        try {
            const url = new URL(decoded);
            deviceId = url.searchParams.get('d') || url.searchParams.get('id') || '';
            deviceName = url.searchParams.get('name') || '';
        } catch {
            deviceId = decoded.trim();
        }

        if (!deviceId) {
            alert('인식된 QR에 디바이스 정보가 없습니다.\n내용: ' + decoded);
            return;
        }

        await this.openDeviceActionById(deviceId, deviceName);
    }

    checkApiConfig() {
        if (CONFIG.API_URL === 'YOUR_GOOGLE_APPS_SCRIPT_URL_HERE') {
            console.warn('⚠️ Google Apps Script URL이 설정되지 않았습니다.');
        }
    }

    formatDate(dateString) {
        if (!dateString) return '-';
        try {
            const date = new Date(dateString);
            if (isNaN(date.getTime())) return dateString;

            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            const seconds = String(date.getSeconds()).padStart(2, '0');

            return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
        } catch {
            return dateString;
        }
    }

    bindEvents() {
        // 햄버거 메뉴
        const hamburgerBtn = document.getElementById('hamburgerBtn');
        const sidebar = document.getElementById('sidebar');
        const sidebarOverlay = document.getElementById('sidebarOverlay');
        const sidebarClose = document.getElementById('sidebarClose');

        const openSidebar = () => {
            sidebar.classList.add('open');
            sidebarOverlay.classList.add('open');
            hamburgerBtn.classList.add('open');
        };
        const closeSidebar = () => {
            sidebar.classList.remove('open');
            sidebarOverlay.classList.remove('open');
            hamburgerBtn.classList.remove('open');
        };

        hamburgerBtn.addEventListener('click', () => {
            if (sidebar.classList.contains('open')) closeSidebar();
            else openSidebar();
        });
        sidebarClose.addEventListener('click', closeSidebar);
        sidebarOverlay.addEventListener('click', closeSidebar);

        // 사이드바 메뉴: QR 인식 (관리자)
        const qrScanMenuBtn = document.getElementById('qrScanMenuBtn');
        if (qrScanMenuBtn) qrScanMenuBtn.addEventListener('click', () => {
            closeSidebar();
            this.startLiveScanner();
        });

        // 사이드바 메뉴: 디바이스 추가 (관리자)
        const addDeviceMenuBtn = document.getElementById('addDeviceMenuBtn');
        if (addDeviceMenuBtn) addDeviceMenuBtn.addEventListener('click', () => {
            closeSidebar();
            this._openAddDevice();
        });

        // 디바이스 추가 모달
        const closeAddDeviceBtn = document.getElementById('closeAddDeviceModal');
        if (closeAddDeviceBtn) closeAddDeviceBtn.addEventListener('click', () => this._closeAddDevice());
        const addDeviceConfirmBtn = document.getElementById('addDeviceConfirmBtn');
        if (addDeviceConfirmBtn) addDeviceConfirmBtn.addEventListener('click', () => this._confirmAddDevice());
        const addCatInput = document.getElementById('addDeviceCategory');
        const addNameInput = document.getElementById('addDeviceName');
        const onEnterAdd = (e) => { if (e.key === 'Enter') this._confirmAddDevice(); };
        if (addCatInput) addCatInput.addEventListener('keypress', onEnterAdd);
        if (addNameInput) addNameInput.addEventListener('keypress', onEnterAdd);

        // 사이드바 메뉴: 저장 정보 초기화
        document.getElementById('clearSavedBtn').addEventListener('click', () => {
            closeSidebar();
            if (!confirm('저장된 이름과 셀을 초기화합니다. 다음 대여 시 다시 입력이 필요합니다.')) return;
            localStorage.removeItem('rentRenterName');
            localStorage.removeItem('rentRenterCell');
            localStorage.removeItem('rentAutoSkip');
            alert('초기화되었습니다.');
        });

        // 관리자 로그인 메뉴
        const loginMenuBtn = document.getElementById('adminLoginMenuBtn');
        if (loginMenuBtn) loginMenuBtn.addEventListener('click', () => {
            closeSidebar();
            this._openAdminLogin();
        });
        const logoutMenuBtn = document.getElementById('adminLogoutMenuBtn');
        if (logoutMenuBtn) logoutMenuBtn.addEventListener('click', () => {
            closeSidebar();
            if (confirm('관리자 모드를 종료하시겠습니까?')) this._logoutAdmin();
        });

        // 관리자 로그인 모달
        const closeLoginBtn = document.getElementById('closeAdminLoginModal');
        if (closeLoginBtn) closeLoginBtn.addEventListener('click', () => this._closeAdminLogin());
        const loginConfirmBtn = document.getElementById('adminLoginConfirmBtn');
        if (loginConfirmBtn) loginConfirmBtn.addEventListener('click', () => this._confirmAdminLogin());
        const pwInput = document.getElementById('adminPasswordInput');
        if (pwInput) pwInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this._confirmAdminLogin();
        });

        // QR 스캔 → 현황
        document.getElementById('backFromScanBtn').addEventListener('click', async () => {
            await this.stopLiveScanner();
            this.showScreen('mainScreen');
        });

        // 메인 새로고침
        document.getElementById('refreshMainBtn').addEventListener('click', () => this.loadDevices(true));

        // 다중 선택 토글
        document.getElementById('selectModeBtn').addEventListener('click', () => this.toggleSelectionMode());

        // 검색
        const searchInput = document.getElementById('searchInput');
        const searchBar = searchInput.closest('.search-bar');
        searchInput.addEventListener('input', () => {
            this._searchQuery = searchInput.value;
            searchBar.classList.toggle('has-value', !!this._searchQuery);
            if (this._allDevices) this._rerender();
        });
        document.getElementById('searchClearBtn').addEventListener('click', () => {
            searchInput.value = '';
            this._searchQuery = '';
            searchBar.classList.remove('has-value');
            if (this._allDevices) this._rerender();
            searchInput.focus();
        });

        // 다중 대여/반납
        document.getElementById('bulkRentBtn').addEventListener('click', () => this.openBulkRent());
        document.getElementById('bulkReturnBtn').addEventListener('click', () => this.processBulkReturn());

        // 디바이스 액션 모달
        document.getElementById('closeDeviceActionModal').addEventListener('click', () => {
            document.getElementById('deviceActionModal').classList.remove('active');
        });
        // 외부 클릭으로 닫지 않음 — X 버튼으로만 닫기

        // 대여 정보 입력 모달
        const closeRentModal = () => {
            document.getElementById('rentFromStatusModal').classList.remove('active');
            this._bulkRentMode = false;
            this._bulkRentDevices = [];
            const title = document.querySelector('#rentFromStatusModal .modal-header h2');
            if (title) title.textContent = '대여 정보 입력';
        };
        document.getElementById('closeRentFromStatusModal').addEventListener('click', closeRentModal);
        // 외부 클릭으로 닫지 않음 — X 또는 취소 버튼으로만 닫기
        document.getElementById('cancelRentFromStatus').addEventListener('click', closeRentModal);
        document.getElementById('rentCell1Btn').addEventListener('click', () => this.confirmRentFromStatus('1셀'));
        document.getElementById('rentCell2Btn').addEventListener('click', () => this.confirmRentFromStatus('2셀'));
        document.getElementById('modalRenterName').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.confirmRentFromStatus('1셀');
        });
    }

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.remove('active');
        });
        document.getElementById(screenId).classList.add('active');
    }

    /**
     * 디바이스 목록 로드 및 메인 화면 렌더링
     */
    async loadDevices(animate = false) {
        const container = document.getElementById('mainDeviceList');
        const refreshBtn = document.getElementById('refreshMainBtn');

        if (animate) {
            refreshBtn.classList.add('rotating');
            setTimeout(() => refreshBtn.classList.remove('rotating'), 600);
        }

        if (!container.querySelector('.device-row')) {
            container.innerHTML = '<div class="status-loading">불러오는 중...</div>';
        }

        try {
            const response = await this.callApi({ action: 'getStatus' });
            if (response && response.success && response.devices) {
                this._categories = Array.isArray(response.categories) ? response.categories : [];
                this.renderDeviceList(response.devices);
            } else {
                container.innerHTML = '<div class="status-empty">데이터를 불러올 수 없습니다.</div>';
            }
        } catch (error) {
            console.error('현황 조회 오류:', error);
            container.innerHTML = '<div class="status-empty">서버 연결에 실패했습니다.</div>';
        }
    }

    _escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    renderDeviceList(devices) {
        const container = document.getElementById('mainDeviceList');

        if (!devices || devices.length === 0) {
            container.innerHTML = '<div class="status-empty">등록된 디바이스가 없습니다.</div>';
            this._allDevices = [];
            this.updateSelectionBar();
            return;
        }

        this._allDevices = devices;

        // 이전 선택이 존재하지 않는 디바이스를 가리키면 제거
        const existingIds = new Set(devices.map(d => d.deviceId));
        for (const id of [...this._selectedIds]) {
            if (!existingIds.has(id)) this._selectedIds.delete(id);
        }

        this._rerender();
    }

    _getCategory(d) {
        return (d.category && d.category.trim()) || '기타';
    }

    _rerender() {
        const container = document.getElementById('mainDeviceList');
        const devices = this._allDevices || [];
        const esc = (s) => this._escapeHtml(s);
        const q = (this._searchQuery || '').trim().toLowerCase();
        const isSearching = q.length > 0;

        // 검색어가 있으면 검색어로 1차 필터, 없으면 전체
        const searchFiltered = isSearching
            ? devices.filter(d => (d.deviceName || d.deviceId || '').toLowerCase().includes(q))
            : devices;

        const rentedAll = searchFiltered.filter(d => d.status === 'rented');
        const availableAll = searchFiltered.filter(d => d.status !== 'rented');

        // 검색 중에는 필터 칩 숨김 (선택된 필터 무시하고 전체 표시)
        const rented = (isSearching || this._filters.rented === 'all')
            ? rentedAll : rentedAll.filter(d => this._getCategory(d) === this._filters.rented);
        const available = (isSearching || this._filters.available === 'all')
            ? availableAll : availableAll.filter(d => this._getCategory(d) === this._filters.available);

        const sectionHtml = (key, label, all, filtered) => {
            const filterValue = this._filters[key];
            // 카테고리 목록은 해당 섹션 내 디바이스 기준
            const cats = [];
            const seen = new Set();
            all.forEach(d => {
                const c = this._getCategory(d);
                if (!seen.has(c)) { seen.add(c); cats.push(c); }
            });

            const chipsHtml = (!isSearching && cats.length > 0) ? `
                <div class="filter-chips" data-section-key="${key}">
                    <button class="filter-chip${filterValue === 'all' ? ' active' : ''}" data-cat="all">
                        <span>전체</span><span class="chip-count">${all.length}</span>
                    </button>
                    ${cats.map(c => {
                        const count = all.filter(d => this._getCategory(d) === c).length;
                        return `<button class="filter-chip${filterValue === c ? ' active' : ''}" data-cat="${esc(c)}">
                            <span>${esc(c)}</span><span class="chip-count">${count}</span>
                        </button>`;
                    }).join('')}
                </div>` : '';

            const emptyMsg = isSearching
                ? '검색 결과가 없습니다.'
                : (all.length === 0
                    ? (key === 'rented' ? '대여 중인 디바이스가 없습니다.' : '사용 가능한 디바이스가 없습니다.')
                    : '해당 카테고리에 디바이스가 없습니다.');

            const bodyHtml = filtered.length === 0
                ? `<div class="status-empty">${emptyMsg}</div>`
                : filtered.map(d => this._rowHtml(d)).join('');

            return `<div class="status-section" data-section-key="${key}">
                <div class="status-section-head">
                    <span class="status-section-title">${label}</span>
                    <span class="status-section-count">${all.length}</span>
                </div>
                ${chipsHtml}
                <div class="status-section-body">${bodyHtml}</div>
            </div>`;
        };

        const html = sectionHtml('rented', '현재 대여 중', rentedAll, rented)
                   + sectionHtml('available', '대여 가능', availableAll, available);

        container.innerHTML = html;

        // 필터 칩 클릭
        container.querySelectorAll('.filter-chips').forEach(chipsEl => {
            this._enableTabDragAndWheel(chipsEl);
            chipsEl.addEventListener('click', (e) => {
                const btn = e.target.closest('.filter-chip');
                if (!btn || !chipsEl.contains(btn)) return;
                if (chipsEl.dataset.dragged === '1') {
                    chipsEl.dataset.dragged = '0';
                    e.preventDefault();
                    return;
                }
                const sectionKey = chipsEl.dataset.sectionKey;
                this._filters[sectionKey] = btn.dataset.cat;
                this._rerender();
            });
        });

        // 디바이스 행 클릭
        container.querySelectorAll('.device-row').forEach(row => {
            row.addEventListener('click', () => {
                const deviceId = row.dataset.deviceId;
                const device = this._allDevices.find(d => d.deviceId === deviceId);
                if (!device) return;
                if (this._selectionMode) {
                    this.toggleDeviceSelection(deviceId);
                } else {
                    this.showDeviceAction(device);
                }
            });
        });

        this.updateSelectionBar();
    }

    _rowHtml(device) {
        const esc = (s) => this._escapeHtml(s);
        const name = device.deviceName || device.deviceId;
        const subtitle = device.category || '';
        const showSub = subtitle && subtitle !== name;
        const isSelected = this._selectionMode && this._selectedIds.has(device.deviceId);
        const checkbox = this._selectionMode ? `
            <div class="device-row-checkbox">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                </svg>
            </div>` : '';

        let badgeClass = 'available';
        let badgeText = '사용 가능';
        if (device.status === 'rented') {
            const exp = this._expiryStatusText(device.expiryDate);
            if (exp && exp.cls === 'overdue') {
                badgeClass = 'overdue'; badgeText = '연체';
            } else if (exp && exp.cls === 'soon') {
                badgeClass = 'soon'; badgeText = '곧 만료';
            } else {
                badgeClass = 'rented'; badgeText = '대여 중';
            }
        }

        return `
        <div class="device-row${this._selectionMode ? ' selectable' : ''}${isSelected ? ' selected' : ''}" data-device-id="${esc(device.deviceId)}">
            ${checkbox}
            <div class="device-row-left">
                <span class="device-row-name">${esc(name)}</span>
                ${showSub ? `<span class="device-row-id">${esc(subtitle)}</span>` : ''}
            </div>
            <div class="device-row-right">
                ${device.status === 'rented' ? `<span class="device-row-renter">${esc(device.renter || '')}</span>` : ''}
                <span class="status-badge ${badgeClass}">${badgeText}</span>
            </div>
        </div>`;
    }

    _enableTabDragAndWheel(tabsEl) {
        tabsEl.addEventListener('wheel', (e) => {
            if (e.deltaY !== 0 && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
                e.preventDefault();
                tabsEl.scrollLeft += e.deltaY;
            }
        }, { passive: false });

        let isDown = false;
        let startX = 0;
        let startScroll = 0;
        let moved = 0;

        const onMove = (e) => {
            if (!isDown) return;
            const dx = e.clientX - startX;
            moved = Math.abs(dx);
            if (moved > 3) {
                tabsEl.scrollLeft = startScroll - dx;
                e.preventDefault();
            }
        };

        const onUp = () => {
            if (!isDown) return;
            isDown = false;
            tabsEl.classList.remove('dragging');
            if (moved > 5) tabsEl.dataset.dragged = '1';
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };

        tabsEl.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            isDown = true;
            moved = 0;
            startX = e.clientX;
            startScroll = tabsEl.scrollLeft;
            tabsEl.classList.add('dragging');
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });
    }

    toggleSelectionMode() {
        this._selectionMode = !this._selectionMode;
        this._selectedIds.clear();
        document.getElementById('selectModeBtn').classList.toggle('active', this._selectionMode);
        this._rerender();
    }

    exitSelectionMode() {
        this._selectionMode = false;
        this._selectedIds.clear();
        document.getElementById('selectModeBtn').classList.remove('active');
        this._rerender();
    }

    toggleDeviceSelection(deviceId) {
        if (this._selectedIds.has(deviceId)) this._selectedIds.delete(deviceId);
        else this._selectedIds.add(deviceId);
        this._rerender();
    }

    updateSelectionBar() {
        const bar = document.getElementById('selectionBar');
        if (!this._selectionMode) {
            bar.classList.remove('active');
            return;
        }
        bar.classList.add('active');

        const selectedDevices = [...this._selectedIds]
            .map(id => (this._allDevices || []).find(d => d.deviceId === id))
            .filter(Boolean);
        const availableCount = selectedDevices.filter(d => d.status !== 'rented').length;
        const rentedCount = selectedDevices.filter(d => d.status === 'rented').length;

        document.getElementById('selectedCount').textContent = selectedDevices.length;
        document.getElementById('bulkRentCount').textContent = availableCount;
        document.getElementById('bulkReturnCount').textContent = rentedCount;
        document.getElementById('bulkRentBtn').disabled = availableCount === 0;
        document.getElementById('bulkReturnBtn').disabled = rentedCount === 0;
    }

    openBulkRent() {
        const selected = [...this._selectedIds]
            .map(id => this._allDevices.find(d => d.deviceId === id))
            .filter(d => d && d.status !== 'rented');
        if (selected.length === 0) {
            alert('대여 가능한 디바이스가 선택되지 않았습니다.');
            return;
        }
        this._bulkRentMode = true;
        this._bulkRentDevices = selected;
        const title = document.querySelector('#rentFromStatusModal .modal-header h2');
        if (title) title.textContent = `${selected.length}개 디바이스 대여`;

        const nameInput = document.getElementById('modalRenterName');
        const rememberCheck = document.getElementById('rememberNameCheck');
        const saved = localStorage.getItem('rentRenterName') || '';
        nameInput.value = saved;
        if (rememberCheck) {
            rememberCheck.checked = localStorage.getItem('rentAutoSkip') === '1';
        }

        document.getElementById('rentFromStatusModal').classList.add('active');
        if (!saved) nameInput.focus();
    }

    async confirmBulkRent(cell) {
        const name = document.getElementById('modalRenterName').value.trim();
        if (!name) {
            alert(CONFIG.MESSAGES.ERROR_NO_NAME);
            document.getElementById('modalRenterName').focus();
            return;
        }

        const rememberCheck = document.getElementById('rememberNameCheck');
        if (rememberCheck && rememberCheck.checked) {
            localStorage.setItem('rentRenterName', name);
            localStorage.setItem('rentRenterCell', cell);
            localStorage.setItem('rentAutoSkip', '1');
        } else {
            localStorage.removeItem('rentRenterName');
            localStorage.removeItem('rentRenterCell');
            localStorage.removeItem('rentAutoSkip');
        }

        const devices = this._bulkRentDevices;

        document.getElementById('rentFromStatusModal').classList.remove('active');
        this.showLoading(true);

        let success = 0, failed = 0;
        const failedNames = [];
        for (const device of devices) {
            try {
                const response = await this.callApi({
                    action: 'rent',
                    deviceId: device.deviceId,
                    deviceName: device.deviceName,
                    renterName: name,
                    cell: cell
                });
                if (response && response.success) success++;
                else { failed++; failedNames.push(device.deviceName || device.deviceId); }
            } catch {
                failed++; failedNames.push(device.deviceName || device.deviceId);
            }
        }

        this.showLoading(false);
        this._bulkRentMode = false;
        this._bulkRentDevices = [];
        const title = document.querySelector('#rentFromStatusModal .modal-header h2');
        if (title) title.textContent = '대여 정보 입력';

        if (failed === 0) alert(`${success}개 디바이스 대여 완료`);
        else alert(`대여 ${success}건 성공, ${failed}건 실패\n실패: ${failedNames.join(', ')}`);

        this.exitSelectionMode();
        this.loadDevices();
    }

    async processBulkReturn() {
        const selected = [...this._selectedIds]
            .map(id => this._allDevices.find(d => d.deviceId === id))
            .filter(d => d && d.status === 'rented');
        if (selected.length === 0) {
            alert('반납할 디바이스가 선택되지 않았습니다.');
            return;
        }
        if (!confirm(`${selected.length}개 디바이스를 반납하시겠습니까?`)) return;

        this.showLoading(true);

        let success = 0, failed = 0;
        const failedNames = [];
        for (const device of selected) {
            try {
                const response = await this.callApi({
                    action: 'return',
                    deviceId: device.deviceId,
                    deviceName: device.deviceName
                });
                if (response && response.success) success++;
                else { failed++; failedNames.push(device.deviceName || device.deviceId); }
            } catch {
                failed++; failedNames.push(device.deviceName || device.deviceId);
            }
        }

        this.showLoading(false);

        if (failed === 0) alert(`${success}개 디바이스 반납 완료`);
        else alert(`반납 ${success}건 성공, ${failed}건 실패\n실패: ${failedNames.join(', ')}`);

        this.exitSelectionMode();
        this.loadDevices();
    }

    showDeviceAction(device, source = 'row') {
        const modal = document.getElementById('deviceActionModal');
        const title = document.getElementById('deviceActionTitle');
        const info = document.getElementById('deviceActionInfo');
        const buttons = document.getElementById('deviceActionButtons');
        const isRented = device.status === 'rented';
        const esc = (s) => this._escapeHtml(s);
        // 일반 사용자가 디바이스 행을 클릭한 경우엔 액션 버튼 숨김 (QR 경로는 항상 표시)
        const canShowActions = source === 'qr' || this._isAdmin();

        title.textContent = device.deviceName || device.deviceId;

        let infoHtml = '';
        if (device.category) {
            infoHtml += `
            <div class="detail-row">
                <span class="detail-label">카테고리</span>
                <span class="detail-value">${esc(device.category)}</span>
            </div>`;
        }
        infoHtml += `
            <div class="detail-row">
                <span class="detail-label">상태</span>
                <span class="detail-value">${isRented ? '대여 중' : '사용 가능'}</span>
            </div>
        `;

        if (isRented) {
            const expiryStatus = this._expiryStatusText(device.expiryDate);
            infoHtml += `
                <div class="detail-row">
                    <span class="detail-label">대여자</span>
                    <span class="detail-value">${esc(device.renter || '')}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">셀</span>
                    <span class="detail-value">${esc(device.cell || '-')}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">대여일시</span>
                    <span class="detail-value">${esc(this.formatDate(device.rentDate))}</span>
                </div>
                ${device.expiryDate ? `
                <div class="detail-row">
                    <span class="detail-label">만료일시</span>
                    <span class="detail-value">${esc(this.formatDate(device.expiryDate))}${expiryStatus ? ` <span class="expiry-tag ${expiryStatus.cls}">${esc(expiryStatus.text)}</span>` : ''}</span>
                </div>` : ''}
            `;
        }
        info.innerHTML = infoHtml;

        if (!canShowActions) {
            buttons.innerHTML = '';
        } else if (isRented) {
            buttons.innerHTML = `
                <button class="action-renew-btn">갱신</button>
                <button class="action-return-btn">반납</button>
            `;
            buttons.querySelector('.action-renew-btn').addEventListener('click', () => {
                this.processRenewFromStatus(device);
            });
            buttons.querySelector('.action-return-btn').addEventListener('click', () => {
                this.processReturnFromStatus(device);
            });
        } else {
            buttons.innerHTML = `<button class="action-rent-btn">대여</button>`;
            buttons.querySelector('.action-rent-btn').addEventListener('click', () => {
                this.openRentFromStatus(device);
            });
        }

        modal.classList.add('active');
    }

    /**
     * 만료일시 기준으로 표시할 상태 태그를 반환 (없으면 null)
     * - 만료 후: '연체'
     * - 만료까지 24시간 이내: '곧 만료'
     */
    _expiryStatusText(expiryStr) {
        if (!expiryStr) return null;
        const expiry = new Date(expiryStr);
        if (isNaN(expiry.getTime())) return null;
        const now = Date.now();
        const ms = expiry.getTime() - now;
        if (ms < 0) return { text: '연체', cls: 'overdue' };
        if (ms <= 24 * 60 * 60 * 1000) return { text: '곧 만료', cls: 'soon' };
        return null;
    }

    async processRenewFromStatus(device) {
        document.getElementById('deviceActionModal').classList.remove('active');
        this.showLoading(true);
        try {
            const response = await this.callApi({
                action: 'renew',
                deviceId: device.deviceId,
                deviceName: device.deviceName
            });
            this.showLoading(false);
            if (response && response.success) {
                const newExpiry = (response.data && response.data.expiryDate) || '';
                alert(`${device.deviceName || device.deviceId} 갱신이 완료되었습니다.${newExpiry ? `\n새 만료일시: ${newExpiry}` : ''}`);
                this.loadDevices();
            } else {
                alert('갱신 실패: ' + ((response && response.message) || '알 수 없는 오류'));
            }
        } catch (error) {
            this.showLoading(false);
            alert('오류 발생: ' + (error.message || error));
        }
    }

    openRentFromStatus(device) {
        this._rentStatusDevice = device;
        this._bulkRentMode = false;
        this._bulkRentDevices = [];
        const title = document.querySelector('#rentFromStatusModal .modal-header h2');
        if (title) title.textContent = device.deviceName || device.deviceId;
        document.getElementById('deviceActionModal').classList.remove('active');

        const nameInput = document.getElementById('modalRenterName');
        const rememberCheck = document.getElementById('rememberNameCheck');
        const saved = localStorage.getItem('rentRenterName') || '';
        nameInput.value = saved;
        if (rememberCheck) {
            rememberCheck.checked = localStorage.getItem('rentAutoSkip') === '1';
        }

        document.getElementById('rentFromStatusModal').classList.add('active');
        if (!saved) nameInput.focus();
    }

    async confirmRentFromStatus(cell) {
        if (this._bulkRentMode) return this.confirmBulkRent(cell);
        const name = document.getElementById('modalRenterName').value.trim();
        if (!name) {
            alert(CONFIG.MESSAGES.ERROR_NO_NAME);
            document.getElementById('modalRenterName').focus();
            return;
        }

        const rememberCheck = document.getElementById('rememberNameCheck');
        if (rememberCheck && rememberCheck.checked) {
            localStorage.setItem('rentRenterName', name);
            localStorage.setItem('rentRenterCell', cell);
            localStorage.setItem('rentAutoSkip', '1');
        } else {
            localStorage.removeItem('rentRenterName');
            localStorage.removeItem('rentRenterCell');
            localStorage.removeItem('rentAutoSkip');
        }

        const device = this._rentStatusDevice;

        document.getElementById('rentFromStatusModal').classList.remove('active');
        this.showLoading(true);

        try {
            const response = await this.callApi({
                action: 'rent',
                deviceId: device.deviceId,
                deviceName: device.deviceName,
                renterName: name,
                cell: cell
            });

            this.showLoading(false);

            if (response && response.success) {
                alert(`${device.deviceName || device.deviceId} 대여가 완료되었습니다.`);
                this.loadDevices();
            } else {
                alert('대여 실패: ' + ((response && response.message) || '알 수 없는 오류'));
            }
        } catch (error) {
            this.showLoading(false);
            alert('오류 발생: ' + (error.message || error));
        }
    }

    async processReturnFromStatus(device) {
        if (!confirm(`${device.deviceName || device.deviceId}을(를) 반납하시겠습니까?`)) {
            return;
        }

        document.getElementById('deviceActionModal').classList.remove('active');
        this.showLoading(true);

        try {
            const response = await this.callApi({
                action: 'return',
                deviceId: device.deviceId,
                deviceName: device.deviceName
            });

            this.showLoading(false);

            if (response && response.success) {
                alert(`${device.deviceName || device.deviceId} 반납이 완료되었습니다.`);
                this.loadDevices();
            } else {
                alert('반납 실패: ' + ((response && response.message) || '알 수 없는 오류'));
            }
        } catch (error) {
            this.showLoading(false);
            alert('오류 발생: ' + (error.message || error));
        }
    }

    /**
     * API 호출
     */
    async callApi(data) {
        if (CONFIG.API_URL === 'YOUR_GOOGLE_APPS_SCRIPT_URL_HERE') {
            return this.simulateApiResponse(data);
        }
        try {
            const response = await fetch(CONFIG.API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: JSON.stringify(data)
            });
            return await response.json();
        } catch (error) {
            console.error('API 호출 오류:', error);
            throw error;
        }
    }

    simulateApiResponse(data) {
        console.log('📌 테스트 모드:', data);
        const now = new Date().toLocaleString('ko-KR');

        if (data.action === 'getStatus') {
            return {
                success: true,
                devices: [
                    { deviceId: 'DEV001', deviceName: 'iPhone 15 Pro', status: 'available', renter: '', cell: '', rentDate: '' },
                    { deviceId: 'DEV002', deviceName: 'Galaxy S24', status: 'rented', renter: '홍길동', cell: '1셀', rentDate: '2026-04-13 10:00:00' },
                    { deviceId: 'DEV003', deviceName: 'iPad Pro 12.9', status: 'available', renter: '', cell: '', rentDate: '' }
                ]
            };
        }
        if (data.action === 'rent') {
            return { success: true, message: `${data.deviceId} 대여 완료`, data: { ...data, rentDate: now } };
        }
        if (data.action === 'return') {
            return { success: true, message: `${data.deviceId} 반납 완료`, data: { ...data, returnDate: now } };
        }
        if (data.action === 'renew') {
            const exp = new Date(Date.now() + 3 * 60 * 1000).toLocaleString('ko-KR');
            return { success: true, message: `${data.deviceId} 갱신 완료`, data: { ...data, expiryDate: exp } };
        }
        if (data.action === 'addDevice') {
            return { success: true, message: `${data.deviceName} 추가 완료`, data: { category: data.category, deviceName: data.deviceName } };
        }
        if (data.action === 'heartbeat') {
            return { success: true, count: 1 };
        }
        return { success: false, message: '알 수 없는 액션' };
    }

    showLoading(show) {
        const overlay = document.getElementById('loadingOverlay');
        if (show) overlay.classList.add('active');
        else overlay.classList.remove('active');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new DeviceRentalApp();
});
