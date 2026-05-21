/**
 * 설정 파일
 * Google Apps Script 웹 앱 URL을 여기에 입력하세요.
 */

window.CONFIG = {
    // Google Apps Script 웹 앱 URL (배포 후 생성되는 URL을 입력)
    // 예: 'https://script.google.com/macros/s/AKfycb.../exec'
    API_URL: 'https://script.google.com/macros/s/AKfycbx1Z5jsVzmnbAKz0FQIlucxQ48cW84M554fhdaxJe20MO_FIlh5_RUbwJOvDmlNpzdT/exec',

    // QR 코드에 담길 기본 URL (GitHub Pages 배포 URL)
    APP_BASE_URL: 'https://yun940.github.io/qa-device-tool-app/',

    // QR 생성기 관리자 비밀번호
    ADMIN_PASSWORD: '0000',

    // 메시지
    MESSAGES: {
        ERROR_NO_NAME: '이름을 입력해주세요.'
    }
};

// 하위 호환: 기존 코드에서 CONFIG로 직접 참조하는 경우 대비
var CONFIG = window.CONFIG;
