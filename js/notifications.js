/**
 * 로컬 알림 관리 — Capacitor LocalNotifications 플러그인 래퍼
 *
 * 대여 한 건당 최대 4개 알림 예약:
 *   1) 사전 알림  — 만료 하루 전 10:00
 *   2) 만료 알림  — 실제 만료 시각
 *   3) 연체 알림  — 만료 +1일 10:00
 *   4) 자동 반납  — 만료 +2일 12:00
 *
 * 갱신 시 기존 알림 취소 후 새 만료시각 기준 재예약.
 * 반납 시 모든 알림 취소.
 *
 * 브라우저(비-Capacitor) 환경에선 모든 함수가 no-op.
 */
window.NotificationManager = (function () {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    function isAvailable() {
        return !!(
            window.Capacitor &&
            typeof window.Capacitor.isNativePlatform === 'function' &&
            window.Capacitor.isNativePlatform() &&
            window.Capacitor.Plugins &&
            window.Capacitor.Plugins.LocalNotifications
        );
    }

    function getPlugin() {
        return window.Capacitor.Plugins.LocalNotifications;
    }

    /**
     * deviceId(문자열)를 5자리 숫자로 해시. 디바이스별로 알림 ID 4개를 base..base+3에 배치.
     */
    function hashDeviceId(deviceId) {
        let hash = 0;
        const s = String(deviceId || '');
        for (let i = 0; i < s.length; i++) {
            hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
        }
        return (Math.abs(hash) % 100000) * 10; // 0..999990, 끝자리 4개를 알림 종류로 사용
    }

    /**
     * 서버가 보낸 "YYYY-MM-DD HH:mm:ss" 문자열을 로컬 Date로 파싱
     */
    function parseExpiry(str) {
        if (!str) return null;
        const d = new Date(String(str).replace(' ', 'T'));
        return isNaN(d.getTime()) ? null : d;
    }

    /**
     * 알림 권한 확인/요청. 이미 부여돼 있으면 그대로 통과.
     * 반환: { granted: boolean }
     */
    async function requestPermission() {
        if (!isAvailable()) return { granted: false };
        try {
            const LN = getPlugin();
            const check = await LN.checkPermissions();
            if (check && check.display === 'granted') {
                return { granted: true };
            }
            const req = await LN.requestPermissions();
            return { granted: !!(req && req.display === 'granted') };
        } catch (e) {
            console.warn('NotificationManager.requestPermission 실패', e);
            return { granted: false };
        }
    }

    /**
     * 대여 1건에 대해 4개 알림 예약
     * @param {string} deviceId
     * @param {string} deviceName
     * @param {string} expiryDateStr - 서버가 보낸 만료일시 ("YYYY-MM-DD HH:mm:ss")
     */
    async function scheduleRentalNotifications(deviceId, deviceName, expiryDateStr) {
        if (!isAvailable()) return;

        const expiry = parseExpiry(expiryDateStr);
        if (!expiry) {
            console.warn('NotificationManager: 만료일시 파싱 실패', expiryDateStr);
            return;
        }

        const name = String(deviceName || deviceId || '디바이스');
        const base = hashDeviceId(deviceId);
        const now = new Date();

        // 테스트 모드 감지: 남은 시간이 1시간 미만이면 압축된 오프셋 사용
        const remainingMs = expiry.getTime() - now.getTime();
        const isTestMode = remainingMs < 60 * 60 * 1000;

        let preAlert, expiryAt, overdueAt, autoReturnAt;
        if (isTestMode) {
            // 테스트: 만료 -30s / 만료 / +30s / +60s
            preAlert     = new Date(expiry.getTime() - 30 * 1000);
            expiryAt     = new Date(expiry.getTime());
            overdueAt    = new Date(expiry.getTime() + 30 * 1000);
            autoReturnAt = new Date(expiry.getTime() + 60 * 1000);
            console.log('[Notif] 테스트 모드 — 압축 오프셋 사용');
        } else {
            // 운영: 만료 -1일 10:00 / 만료 / +1일 10:00 / +2일 12:00
            preAlert = new Date(expiry.getTime() - MS_PER_DAY);
            preAlert.setHours(10, 0, 0, 0);
            expiryAt = new Date(expiry.getTime());
            overdueAt = new Date(expiry.getTime() + MS_PER_DAY);
            overdueAt.setHours(10, 0, 0, 0);
            autoReturnAt = new Date(expiry.getTime() + 2 * MS_PER_DAY);
            autoReturnAt.setHours(12, 0, 0, 0);
        }

        const notifications = [];

        if (preAlert > now) {
            notifications.push({
                id: base + 1,
                title: '⏰ 내일 만료 예정',
                body: `${name} — 내일 대여가 만료됩니다`,
                schedule: { at: preAlert, allowWhileIdle: true },
                smallIcon: 'ic_stat_icon_config_sample',
                channelId: 'qa-rental'
            });
        }
        if (expiryAt > now) {
            notifications.push({
                id: base + 2,
                title: '🔔 만료',
                body: `${name} — 만료되었습니다. 갱신 또는 반납해주세요`,
                schedule: { at: expiryAt, allowWhileIdle: true },
                smallIcon: 'ic_stat_icon_config_sample',
                channelId: 'qa-rental'
            });
        }
        if (overdueAt > now) {
            notifications.push({
                id: base + 3,
                title: '🚨 연체 1일차',
                body: `${name} — 연체 중입니다. 빠른 반납 부탁드립니다`,
                schedule: { at: overdueAt, allowWhileIdle: true },
                smallIcon: 'ic_stat_icon_config_sample',
                channelId: 'qa-rental'
            });
        }
        if (autoReturnAt > now) {
            notifications.push({
                id: base + 4,
                title: '⚠️ 자동 반납 예정',
                body: `${name} — 곧 자동 반납됩니다`,
                schedule: { at: autoReturnAt, allowWhileIdle: true },
                smallIcon: 'ic_stat_icon_config_sample',
                channelId: 'qa-rental'
            });
        }

        if (!notifications.length) return;

        try {
            const LN = getPlugin();
            // 기존 예약 먼저 취소
            await cancelRentalNotifications(deviceId);
            await LN.schedule({ notifications });
            console.log(`[Notif] ${name} 알림 ${notifications.length}건 예약`);
        } catch (e) {
            console.warn('NotificationManager.scheduleRentalNotifications 실패', e);
        }
    }

    /**
     * 디바이스의 모든 예약 알림 취소 (반납/갱신 시 사용)
     */
    async function cancelRentalNotifications(deviceId) {
        if (!isAvailable()) return;
        const base = hashDeviceId(deviceId);
        try {
            const LN = getPlugin();
            await LN.cancel({
                notifications: [
                    { id: base + 1 },
                    { id: base + 2 },
                    { id: base + 3 },
                    { id: base + 4 }
                ]
            });
        } catch (e) {
            console.warn('NotificationManager.cancelRentalNotifications 실패', e);
        }
    }

    /**
     * Android용 알림 채널 생성 (앱 시작 시 1회 호출 권장)
     */
    async function ensureChannel() {
        if (!isAvailable()) return;
        try {
            const LN = getPlugin();
            if (typeof LN.createChannel === 'function') {
                await LN.createChannel({
                    id: 'qa-rental',
                    name: 'QA 대여 알림',
                    description: '대여 만료/연체/자동반납 알림',
                    importance: 4, // HIGH
                    visibility: 1  // PUBLIC
                });
            }
        } catch (e) {
            // iOS 또는 채널 미지원 환경에선 무시
        }
    }

    return {
        isAvailable,
        requestPermission,
        scheduleRentalNotifications,
        cancelRentalNotifications,
        ensureChannel
    };
})();
