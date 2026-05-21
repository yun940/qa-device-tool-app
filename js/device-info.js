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
        'SM-S901N': 'Galaxy S22',
        'SM-S906N': 'Galaxy S22+',
        'SM-S908N': 'Galaxy S22 Ultra',
        'SM-S911N': 'Galaxy S23',
        'SM-S916N': 'Galaxy S23+',
        'SM-S918N': 'Galaxy S23 Ultra',
        'SM-S921N': 'Galaxy S24',
        'SM-S926N': 'Galaxy S24+',
        'SM-S928N': 'Galaxy S24 Ultra',
        'SM-F721N': 'Galaxy Z Flip 4',
        'SM-F731N': 'Galaxy Z Flip 5',
        'SM-F741N': 'Galaxy Z Flip 6',
        'SM-F936N': 'Galaxy Z Fold 4',
        'SM-F946N': 'Galaxy Z Fold 5',
        'SM-F956N': 'Galaxy Z Fold 6'
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
     * UA 기반 간단 추측 (브라우저용)
     */
    function guessFromUserAgent() {
        const ua = navigator.userAgent || '';
        let platform = 'web';
        let modelCode = '';
        if (/iPhone|iPad|iPod/i.test(ua)) {
            platform = 'ios';
            const m = ua.match(/CPU (iPhone )?OS (\d+_\d+)/);
            modelCode = m ? 'iOS' + m[2].replace('_', '.') : '';
        } else if (/Android/i.test(ua)) {
            platform = 'android';
            const m = ua.match(/Android[^;]+;\s+([^)]+)\)/);
            modelCode = m ? m[1].split('Build')[0].trim() : '';
        }
        return { platform, modelCode };
    }

    /**
     * 디바이스 정보 추출 (Promise)
     *   반환: { uniqueId, platform, modelCode, friendlyName, isNative, raw }
     */
    async function getDeviceInfo() {
        if (isNative()) {
            try {
                // Capacitor v5+ 동적 로드 (앱 셋업 후에만 사용 가능)
                const Device = window.Capacitor.Plugins.Device;
                const idResult = await Device.getId();             // { identifier }
                const info    = await Device.getInfo();            // { platform, model, manufacturer, ... }
                const uniqueId = idResult.identifier || idResult.uuid || '';
                const platform = (info.platform || '').toLowerCase();
                const modelCode = info.model || '';
                return {
                    uniqueId,
                    platform,
                    modelCode,
                    friendlyName: modelToFriendlyName(platform, modelCode),
                    isNative: true,
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
            modelCode: guess.modelCode,
            friendlyName: modelToFriendlyName(guess.platform, guess.modelCode),
            isNative: false,
            raw: { userAgent: navigator.userAgent }
        };
    }

    // 전역 노출
    window.QaDeviceInfo = {
        getDeviceInfo,
        modelToFriendlyName,
        isNative
    };
})();
