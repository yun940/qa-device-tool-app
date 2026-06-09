/**
 * 디바이스 정보 추출 — Capacitor + 브라우저 양쪽 지원
 *
 * Capacitor 환경 (앱): @capacitor/device 플러그인으로 고유ID/모델 추출
 * 브라우저 환경 (개발/테스트): localStorage 기반 가짜 고유ID 생성 + UA 파싱
 *
 * 모델 코드 → 마케팅명 매핑 테이블 일부 동봉
 *   필요 시 데이터 추가/갱신 (https://gist.github.com/adamawolf/3048717 등 참고)
 */
(function () {
    'use strict';

    const STORAGE_FAKE_ID = 'qa-device-tool.fake-unique-id';

    /**
     * iOS 머신 코드 → 마케팅명 매핑 (대표 모델 위주, 필요 시 확장)
     */
    const IOS_MODEL_MAP = {
        // iPhone 16 시리즈 (2024)
        'iPhone17,1': 'iPhone 16 Pro',
        'iPhone17,2': 'iPhone 16 Pro Max',
        'iPhone17,3': 'iPhone 16',
        'iPhone17,4': 'iPhone 16 Plus',
        'iPhone17,5': 'iPhone 16e',
        // iPhone 15 시리즈
        'iPhone15,4': 'iPhone 15',
        'iPhone15,5': 'iPhone 15 Plus',
        'iPhone16,1': 'iPhone 15 Pro',
        'iPhone16,2': 'iPhone 15 Pro Max',
        // iPhone 14
        'iPhone14,7': 'iPhone 14',
        'iPhone14,8': 'iPhone 14 Plus',
        'iPhone15,2': 'iPhone 14 Pro',
        'iPhone15,3': 'iPhone 14 Pro Max',
        // iPhone 13
        'iPhone14,5': 'iPhone 13',
        'iPhone14,4': 'iPhone 13 mini',
        'iPhone14,2': 'iPhone 13 Pro',
        'iPhone14,3': 'iPhone 13 Pro Max',
        // iPad (대표)
        'iPad13,1': 'iPad Air 4',
        'iPad13,2': 'iPad Air 4',
        'iPad13,16': 'iPad Air 5',
        'iPad13,17': 'iPad Air 5'
    };

    /**
     * 삼성 모델 코드 → 마케팅명 (대표 모델, 한국 내수)
     */
    const ANDROID_MODEL_MAP = {
        // Galaxy S25 시리즈 (2025)
        'SM-S931N': 'Galaxy S25',
        'SM-S936N': 'Galaxy S25+',
        'SM-S937N': 'Galaxy S25 Edge',
        'SM-S938N': 'Galaxy S25 Ultra',
        // Galaxy S24
        'SM-S921N': 'Galaxy S24',
        'SM-S926N': 'Galaxy S24+',
        'SM-S928N': 'Galaxy S24 Ultra',
        // Galaxy S23
        'SM-S911N': 'Galaxy S23',
        'SM-S916N': 'Galaxy S23+',
        'SM-S918N': 'Galaxy S23 Ultra',
        'SM-S711N': 'Galaxy S23 FE',
        // Galaxy S22
        'SM-S901N': 'Galaxy S22',
        'SM-S906N': 'Galaxy S22+',
        'SM-S908N': 'Galaxy S22 Ultra',
        // Galaxy Z Flip (폴더블)
        'SM-F721N': 'Galaxy Z Flip 4',
        'SM-F731N': 'Galaxy Z Flip 5',
        'SM-F741N': 'Galaxy Z Flip 6',
        'SM-F761N': 'Galaxy Z Flip 7',
        // Galaxy Z Fold
        'SM-F936N': 'Galaxy Z Fold 4',
        'SM-F946N': 'Galaxy Z Fold 5',
        'SM-F956N': 'Galaxy Z Fold 6',
        'SM-F966N': 'Galaxy Z Fold 7'
    };

    /**
     * Capacitor 환경 여부
     */
    function isNative() {
        return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
    }

    /**
     * 브라우저용 가짜 고유ID — localStorage에 저장 (한 번 만들면 같은 브라우저에서 유지)
     */
    function getFakeUniqueId() {
        let id = localStorage.getItem(STORAGE_FAKE_ID);
        if (!id) {
            id = 'web-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
            localStorage.setItem(STORAGE_FAKE_ID, id);
        }
        return id;
    }

    /**
     * 모델 코드 → 사람 이름 변환 (없으면 모델 코드 그대로)
     */
    function modelToFriendlyName(platform, modelCode) {
        if (!modelCode) return '';
        const map = platform === 'ios' ? IOS_MODEL_MAP : ANDROID_MODEL_MAP;
        return map[modelCode] || modelCode;
    }

    /**
     * UA 기반 간단 추측 (브라우저용) — osVersion 도 함께 추출
     *   - iOS Safari UA 예: "...CPU iPhone OS 17_5_1 like Mac OS X..."
     *   - Android Chrome UA 예: "...Linux; Android 14; SM-S921N..."
     */
    function guessFromUserAgent() {
        const ua = navigator.userAgent || '';
        let platform = 'web';
        let modelCode = '';
        let osVersion = '';
        if (/iPhone|iPad|iPod/i.test(ua)) {
            platform = 'ios';
            const v = ua.match(/CPU (?:iPhone )?OS (\d+(?:_\d+){0,2})/);
            if (v) osVersion = v[1].replace(/_/g, '.');
            // iOS Safari는 모델 코드 비공개 — 빈 값 유지
        } else if (/Android/i.test(ua)) {
            platform = 'android';
            const v = ua.match(/Android (\d+(?:\.\d+)?)/);
            if (v) osVersion = v[1];
            const m = ua.match(/Android[^;]+;\s+([^)]+)\)/);
            modelCode = m ? m[1].split('Build')[0].trim() : '';
        }
        return { platform, osVersion, modelCode };
    }

    /**
     * 광고 ID 추출 — iOS IDFA / Android GAID
     * Capacitor 환경에서만 동작. iOS의 경우 첫 호출 시 ATT 권한 팝업이 표시될 수 있음.
     * 반환: { adId, limitAdTracking, authStatus, _diag }
     *   _diag: 디버깅용 — 어디서 실패했는지 추적
     */
    async function getAdvertisingId() {
        if (!isNative()) {
            return { adId: '', limitAdTracking: false, authStatus: 'not-native', _diag: 'browser' };
        }
        if (!window.Capacitor || !window.Capacitor.Plugins) {
            return { adId: '', limitAdTracking: false, authStatus: 'no-capacitor', _diag: 'no Capacitor.Plugins' };
        }
        const AdId = window.Capacitor.Plugins.AdId;
        if (!AdId) {
            return { adId: '', limitAdTracking: false, authStatus: 'plugin-missing', _diag: 'AdId plugin not registered' };
        }
        if (typeof AdId.getAdvertisingId !== 'function') {
            return { adId: '', limitAdTracking: false, authStatus: 'method-missing', _diag: 'getAdvertisingId not function' };
        }
        try {
            const res = await AdId.getAdvertisingId();
            console.log('[AdId] result:', res);
            return {
                adId: res.id || '',
                limitAdTracking: !!res.limitAdTracking,
                authStatus: res.authStatus || ''
            };
        } catch (e) {
            console.warn('[AdId] 호출 예외', e);
            return { adId: '', limitAdTracking: true, authStatus: 'exception', _diag: String(e && e.message || e) };
        }
    }

    /**
     * 디바이스 정보 추출 (Promise)
     *   반환: { uniqueId, platform, osVersion, manufacturer, deviceName, modelCode, friendlyName, isNative, adId, raw }
     *
     *   - uniqueId: 백엔드 매핑용 식별자 (Android ANDROID_ID / iOS identifierForVendor)
     *   - osVersion: OS 버전 문자열 ("14", "17.5" 등)
     *   - manufacturer: 제조사 ("samsung", "Apple")
     *   - deviceName: 사용자가 설정한 폰 이름 ("철수's Galaxy") — 또는 OS 기본값
     *   - friendlyName: 모델 코드 → 사람 친화적 이름 매핑 (자동 추천용)
     *   - adId: { adId, limitAdTracking, authStatus } 또는 null
     */
    async function getDeviceInfo() {
        if (isNative()) {
            try {
                // Capacitor v5+ 동적 로드 (앱 셋업 후에만 사용 가능)
                const Device = window.Capacitor.Plugins.Device;
                const idResult = await Device.getId();             // { identifier }
                const info    = await Device.getInfo();            // { platform, model, manufacturer, osVersion, name, ... }
                const uniqueId = idResult.identifier || idResult.uuid || '';
                const platform = (info.platform || '').toLowerCase();
                const modelCode = info.model || '';
                const adId = await getAdvertisingId();
                return {
                    uniqueId,
                    platform,
                    osVersion: info.osVersion || '',
                    manufacturer: info.manufacturer || '',
                    deviceName: info.name || '',
                    modelCode,
                    friendlyName: modelToFriendlyName(platform, modelCode),
                    isNative: true,
                    adId,
                    raw: info
                };
            } catch (e) {
                console.warn('Capacitor Device 플러그인 실패 — 브라우저 모드로 폴백', e);
            }
        }

        // 브라우저(또는 플러그인 실패) 모드 — UA + 가짜 고유ID
        const guess = guessFromUserAgent();
        return {
            uniqueId: getFakeUniqueId(),
            platform: guess.platform,
            osVersion: guess.osVersion || '',
            manufacturer: '',
            deviceName: '',
            modelCode: guess.modelCode,
            friendlyName: modelToFriendlyName(guess.platform, guess.modelCode),
            isNative: false,
            adId: null,
            raw: { userAgent: navigator.userAgent }
        };
    }

    // 전역 노출
    window.QaDeviceInfo = {
        getDeviceInfo,
        getAdvertisingId,
        modelToFriendlyName,
        isNative
    };
})();
