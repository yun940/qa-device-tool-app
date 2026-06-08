/**
 * 디바이스 대여/반납 관리 시스템 - Google Apps Script
 * 이 코드를 Google Spreadsheet의 Apps Script에 붙여넣으세요.
 */

// 스프레드시트 설정
const SHEET_NAME = '대여기록';
const DEVICE_SHEET_NAME = '디바이스목록';
const USER_SHEET_NAME = '사용자목록';
const BINDING_SHEET_NAME = '디바이스바인딩';

// 권한 상수
const ROLE_USER = 'user';
const ROLE_ADMIN = 'admin';

// 스크립트 속성에서 값을 읽음 (프로젝트 설정 > 스크립트 속성에서 등록)
// - KAKAOWORK_WEBHOOK_URL: 카카오워크 Incoming Webhook URL
// - RENTAL_STATUS_URL: 알림 버튼이 열 대여 현황 페이지 URL (미설정 시 버튼 숨김)
// - RENTAL_DURATION_MIN: 대여 기간(분). 기본 운영값 43200(30일)
// - PRE_ALERT_BEFORE_MIN: 사전 알림 시점(분). 기본 운영값 1440(만료 24h 전)
// - OVERDUE_INTERVAL_MIN: 연체 알림 간격(분). 기본 운영값 1440(만료 후 24h마다)
// - AUTO_RETURN_AFTER_MIN: 만료 후 자동 반납 시점(분). 기본 운영값 2880(2일)
// - ENFORCE_HOUR: '1'이면 10시 알림/12시 자동반납 시각 제약 활성 (운영 기본 1)
function getConfig_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

// 대여 기간 관련 상수 도우미 — 테스트 기본값 (운영 전환 시 스크립트 속성으로 덮어쓰기)
// 운영값: 43200/1440/1440/2880, ENFORCE_HOUR=1
const DEFAULTS = {
  RENTAL_DURATION_MIN: 3,        // 테스트: 3분 대여
  PRE_ALERT_BEFORE_MIN: 1,       // 테스트: 만료 1분 전
  OVERDUE_INTERVAL_MIN: 1,       // 테스트: 만료 후 1분 간격
  AUTO_RETURN_AFTER_MIN: 4       // 테스트: 만료 후 4분 뒤 자동반납
};

function getMinutesConfig_(key) {
  const raw = getConfig_(key);
  if (!raw) return DEFAULTS[key];
  const n = parseFloat(raw);
  return isNaN(n) ? DEFAULTS[key] : n;
}

function getRentalDurationMs_()  { return getMinutesConfig_('RENTAL_DURATION_MIN')  * 60 * 1000; }
function getPreAlertBeforeMs_()  { return getMinutesConfig_('PRE_ALERT_BEFORE_MIN') * 60 * 1000; }
function getOverdueIntervalMs_() { return getMinutesConfig_('OVERDUE_INTERVAL_MIN') * 60 * 1000; }
function getAutoReturnAfterMs_() { return getMinutesConfig_('AUTO_RETURN_AFTER_MIN')* 60 * 1000; }
function isEnforceHour_()        { return getConfig_('ENFORCE_HOUR') === '1'; }

function formatTimestamp_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function parseSheetDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 시트 셀 값을 'yyyy-MM-dd HH:mm:ss' 문자열로 변환.
 * 시트에서 Date 객체로 반환된 셀이 JSON으로 ISO(...T07:45:59.000Z)가 되는 것을 방지.
 */
function asTimestampString_(v) {
  if (!v) return '';
  if (v instanceof Date) return formatTimestamp_(v);
  return String(v);
}

/**
 * 웹 앱 초기 설정 - GET 요청 처리
 */
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    message: '디바이스 대여/반납 API가 정상 작동 중입니다.'
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST 요청 처리 - 대여/반납 기록
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action; // 'rent' 또는 'return'

    let result;
    if (action === 'rent') {
      result = processRent(data);
    } else if (action === 'return') {
      result = processReturn(data);
    } else if (action === 'renew') {
      result = processRenew(data);
    } else if (action === 'addDevice') {
      result = processAddDevice(data);
    } else if (action === 'getDeviceInfo') {
      result = getDeviceInfo(data.deviceId);
    } else if (action === 'getStatus') {
      result = getAllDeviceStatus();
    } else if (action === 'heartbeat') {
      result = processHeartbeat(data);
    } else if (action === 'login') {
      result = processLogin(data);
    } else if (action === 'bindDevice') {
      result = processBindDevice(data);
    } else if (action === 'resolveDevice') {
      result = processResolveDevice(data);
    } else if (action === 'registerPushToken') {
      result = processRegisterPushToken(data);
    } else if (action === 'listBindings') {
      result = processListBindings(data);
    } else if (action === 'notifyAdIdCopy') {
      result = processNotifyAdIdCopy(data);
    } else {
      result = { success: false, message: '알 수 없는 액션입니다.' };
    }

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: '오류가 발생했습니다: ' + error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * 대여 처리
 */
function processRent(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);

  // 시트가 없으면 생성 (10개 컬럼)
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, 10).setValues([[
      '번호', '디바이스ID', '디바이스명', '대여자', '셀', '대여일시', '반납일시',
      '만료일시', '마지막알림', '알림단계'
    ]]);
    sheet.getRange(1, 1, 1, 10).setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else {
    // 기존 시트라면 새 컬럼이 있는지 확인하고 없으면 헤더 확장
    ensureExpiryColumns_(sheet);
  }

  const deviceName = data.deviceName || data.deviceId;

  // 현재 대여 중인지 확인
  const currentRental = findCurrentRental(data.deviceId);
  if (currentRental.isRented) {
    return {
      success: false,
      message: `이 디바이스는 현재 ${currentRental.renter}님이 대여 중입니다. (${currentRental.rentDate})`
    };
  }

  // 새 행 번호 계산
  const lastRow = sheet.getLastRow();
  const newRowNum = lastRow; // 헤더 제외한 행 수

  // 현재 시간 + 만료일시 계산
  const now = new Date();
  const expiry = new Date(now.getTime() + getRentalDurationMs_());
  const dateStr = formatTimestamp_(now);
  const expiryStr = formatTimestamp_(expiry);

  // 새 행 추가 (10개 컬럼)
  sheet.appendRow([
    newRowNum,
    data.deviceId,
    deviceName,
    data.renterName,
    data.cell,
    dateStr,
    '',          // 반납일시
    expiryStr,   // 만료일시
    '',          // 마지막알림
    0            // 알림단계: 0=없음, 1=사전, 2/3/4=연체 1/2/3일차
  ]);

  Logger.log('processRent: calling sendKakaoWorkNotification(rent) for ' + deviceName);
  try {
    sendKakaoWorkNotification('rent', {
      deviceName: deviceName,
      renterName: data.renterName,
      cell: data.cell,
      rentDate: dateStr,
      expiryDate: expiryStr
    });
    Logger.log('processRent: sendKakaoWorkNotification(rent) returned');
  } catch (e) {
    Logger.log('processRent: sendKakaoWorkNotification(rent) threw: ' + e);
  }

  return {
    success: true,
    message: `${deviceName} 대여가 완료되었습니다.`,
    data: {
      deviceId: data.deviceId,
      deviceName: deviceName,
      renterName: data.renterName,
      cell: data.cell,
      rentDate: dateStr,
      expiryDate: expiryStr
    }
  };
}

/**
 * 기존 시트에 만료일시/마지막알림/알림단계 컬럼이 없으면 추가
 */
function ensureExpiryColumns_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol >= 10) return;
  const allHeaders = ['만료일시', '마지막알림', '알림단계'];
  const need = 10 - lastCol;
  const startCol = lastCol + 1;
  const newHeaders = allHeaders.slice(3 - need);
  sheet.getRange(1, startCol, 1, need).setValues([newHeaders]);
  sheet.getRange(1, 1, 1, 10).setFontWeight('bold');
}

/**
 * 반납 처리
 */
function processReturn(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    return { success: false, message: '대여 기록이 없습니다.' };
  }

  // 현재 대여 중인 행 찾기
  const currentRental = findCurrentRental(data.deviceId);

  if (!currentRental.isRented) {
    return { success: false, message: '이 디바이스는 현재 대여 중이 아닙니다.' };
  }

  // 반납일시 기록
  const now = new Date();
  const dateStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');

  sheet.getRange(currentRental.row, 7).setValue(dateStr);

  sendKakaoWorkNotification('return', {
    deviceName: currentRental.deviceName,
    renterName: currentRental.renter,
    cell: currentRental.cell,
    rentDate: currentRental.rentDate,
    returnDate: dateStr
  });

  return {
    success: true,
    message: `${currentRental.deviceName} 반납이 완료되었습니다.`,
    data: {
      deviceId: data.deviceId,
      deviceName: currentRental.deviceName,
      renterName: currentRental.renter,
      rentDate: currentRental.rentDate,
      returnDate: dateStr
    }
  };
}

/**
 * 현재 대여 중인 기록 찾기
 */
function findCurrentRental(deviceId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    return { isRented: false };
  }

  const data = sheet.getDataRange().getValues();

  // 아래서부터 위로 검색 (최신 기록부터)
  for (let i = data.length - 1; i >= 1; i--) {
    const rowDeviceId = String(data[i][1]).trim();
    const returnDate = data[i][6];

    // 반납일시가 비어있는지 확인 (빈 문자열, null, undefined 모두 체크)
    const isNotReturned = !returnDate || String(returnDate).trim() === '';

    if (rowDeviceId === String(deviceId).trim() && isNotReturned) {
      // 디바이스ID가 일치하고 반납일시가 비어있으면 대여 중
      return {
        isRented: true,
        row: i + 1,
        deviceName: data[i][2],
        renter: data[i][3],
        cell: data[i][4],
        rentDate: asTimestampString_(data[i][5]),
        expiryDate: asTimestampString_(data[i][7])
      };
    }
  }

  return { isRented: false };
}

/**
 * 갱신 처리 — 현재 대여 행의 만료일시를 (현재 시각 + RENTAL_DURATION)으로 갱신
 * 알림 단계도 초기화하여 새 사이클의 사전 알림이 다시 발송되도록 함
 */
function processRenew(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    return { success: false, message: '대여 기록이 없습니다.' };
  }
  ensureExpiryColumns_(sheet);

  const rental = findCurrentRental(data.deviceId);
  if (!rental.isRented) {
    return { success: false, message: '이 디바이스는 현재 대여 중이 아닙니다.' };
  }

  const now = new Date();
  const newExpiry = new Date(now.getTime() + getRentalDurationMs_());
  const newExpiryStr = formatTimestamp_(newExpiry);

  sheet.getRange(rental.row, 8).setValue(newExpiryStr); // 만료일시
  sheet.getRange(rental.row, 9).setValue('');           // 마지막알림 리셋
  sheet.getRange(rental.row, 10).setValue(0);           // 알림단계 리셋

  sendKakaoWorkNotification('renew', {
    deviceName: rental.deviceName,
    renterName: rental.renter,
    cell: rental.cell,
    rentDate: rental.rentDate,
    expiryDate: newExpiryStr
  });

  return {
    success: true,
    message: `${rental.deviceName} 갱신이 완료되었습니다.`,
    data: {
      deviceId: data.deviceId,
      deviceName: rental.deviceName,
      renterName: rental.renter,
      cell: rental.cell,
      rentDate: rental.rentDate,
      expiryDate: newExpiryStr
    }
  };
}

/**
 * 광고 ID 복사 알림 — 사용자가 앱에서 광고 ID(IDFA/GAID) 복사 시 카카오워크로 발송
 * data: { userName, platform, deviceName, modelCode, adId, limitAdTracking, authStatus }
 */
function processNotifyAdIdCopy(data) {
  try {
    sendKakaoWorkNotification('adIdCopy', {
      userName:        data.userName || '',
      platform:        data.platform || '',
      deviceName:      data.deviceName || data.modelCode || '',
      modelCode:       data.modelCode || '',
      adId:            data.adId || '',
      limitAdTracking: !!data.limitAdTracking,
      authStatus:      data.authStatus || ''
    });
    return { success: true };
  } catch (e) {
    Logger.log('processNotifyAdIdCopy 실패: ' + e);
    return { success: false, message: '알림 발송 실패: ' + e.message };
  }
}

/**
 * 광고 ID 복사 전용 카카오워크 메시지 빌더
 * info: { userName, platform, deviceName, modelCode, adId, limitAdTracking, authStatus }
 */
function sendAdIdCopyKakaoWorkMessage_(info) {
  const webhookUrl = getConfig_('KAKAOWORK_WEBHOOK_URL');
  if (!webhookUrl) return;

  const platformRaw = String(info.platform || '').toLowerCase();
  const idLabel = platformRaw === 'ios' ? 'IDFA' : platformRaw === 'android' ? 'GAID' : '광고 ID';
  const platformLabel = platformRaw === 'ios' ? 'iOS' : platformRaw === 'android' ? 'Android' : (platformRaw || '-');
  const limitedNote = info.limitAdTracking ? ` (권한: ${info.authStatus || 'denied'})` : '';

  const userLabel = String(info.userName || '-');
  const deviceLabel = info.deviceName || info.modelCode || '-';

  const fallbackText = `[광고ID복사] ${userLabel} — ${idLabel}: ${info.adId || '(빈 값)'}`;

  const descriptions = [
    { type: 'description', term: '사용자',     content: { type: 'text', text: userLabel,            markdown: false }, accent: true },
    { type: 'description', term: '플랫폼',     content: { type: 'text', text: platformLabel,        markdown: false }, accent: true },
    { type: 'description', term: '디바이스',   content: { type: 'text', text: deviceLabel,          markdown: false }, accent: true },
    { type: 'description', term: idLabel,      content: { type: 'text', text: String(info.adId || '(빈 값)') + limitedNote, markdown: false }, accent: true }
  ];

  const blocks = [
    { type: 'header', text: `🏷️ ${idLabel} 공유`, style: 'blue' },
    { type: 'divider' },
    ...descriptions
  ];

  const payload = { text: fallbackText, blocks: blocks };

  try {
    const response = UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    Logger.log('KakaoWork adIdCopy status: ' + response.getResponseCode());
    Logger.log('KakaoWork adIdCopy body: ' + response.getContentText());
  } catch (err) {
    Logger.log('KakaoWork adIdCopy failed: ' + err);
  }
}

/**
 * 신규 디바이스 추가 — 디바이스목록(컬럼=카테고리) 레이아웃에 맞춰 처리
 *   1행: 카테고리 이름들 (예: A1=애플, B1=삼성, C1=기타, D1=노트북)
 *   2행 이하: 각 카테고리 컬럼 세로로 디바이스명 나열
 *
 * 동작:
 * - 카테고리가 기존 컬럼에 있으면 → 해당 컬럼의 첫 빈 칸에 디바이스명 기록
 * - 카테고리가 없으면 → 우측에 새 컬럼 추가 후 2행에 디바이스명 기록
 * - 디바이스명 중복(전 컬럼 통틀어)이면 거부
 */
function processAddDevice(data) {
  const category   = (data.category   || '').toString().trim();
  const deviceName = (data.deviceName || '').toString().trim();

  if (!category)   return { success: false, message: '카테고리를 입력해주세요.' };
  if (!deviceName) return { success: false, message: '디바이스명을 입력해주세요.' };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DEVICE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(DEVICE_SHEET_NAME);
    sheet.getRange(1, 1, 1, 1).setValue(category).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  const values = sheet.getDataRange().getValues();
  const headers = values.length > 0 ? values[0] : [];

  // 전 컬럼 통틀어 디바이스명 중복 검사
  for (let r = 1; r < values.length; r++) {
    for (let c = 0; c < headers.length; c++) {
      if (String(values[r][c] || '').trim() === deviceName) {
        return { success: false, message: `이미 등록된 디바이스명입니다: ${deviceName}` };
      }
    }
  }

  // 카테고리 컬럼 찾기 (없으면 우측에 새 컬럼 추가)
  let catCol = -1;
  for (let c = 0; c < headers.length; c++) {
    if (String(headers[c]).trim() === category) { catCol = c; break; }
  }
  if (catCol === -1) {
    catCol = headers.length;
    sheet.getRange(1, catCol + 1).setValue(category).setFontWeight('bold');
  }

  // 해당 컬럼의 첫 빈 칸 찾기 (2행부터 검색, 없으면 데이터 마지막 다음 행)
  let targetRow = -1;
  for (let r = 1; r < values.length; r++) {
    if (!String(values[r][catCol] || '').trim()) { targetRow = r + 1; break; }
  }
  if (targetRow === -1) targetRow = values.length + 1;

  sheet.getRange(targetRow, catCol + 1).setValue(deviceName);

  return {
    success: true,
    message: `${deviceName} 추가 완료`,
    data: { category: category, deviceName: deviceName }
  };
}

/**
 * 디바이스 정보 가져오기 — 컬럼=카테고리 레이아웃 기준으로 디바이스명을 모든 컬럼에서 탐색
 * (deviceId == deviceName 으로 사용)
 */
function getDeviceInfo(deviceId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DEVICE_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(DEVICE_SHEET_NAME);
    sheet.getRange(1, 1, 1, 4).setValues([['애플', '삼성', '기타', '노트북']]);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return { success: false, message: '디바이스 목록이 생성되었습니다. 디바이스를 등록해주세요.' };
  }

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    return { success: false, message: '등록되지 않은 디바이스입니다.', deviceId: deviceId };
  }

  const headers = data[0];
  const target = String(deviceId).trim();
  for (let r = 1; r < data.length; r++) {
    for (let c = 0; c < headers.length; c++) {
      const name = String(data[r][c] || '').trim();
      if (name && name === target) {
        return {
          success: true,
          deviceId: name,
          deviceName: name,
          category: String(headers[c] || '').trim()
        };
      }
    }
  }
  return { success: false, message: '등록되지 않은 디바이스입니다.', deviceId: deviceId };
}

/**
 * 현재 대여 현황 조회
 */
function getCurrentRentals() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    return { success: true, rentals: [] };
  }

  const data = sheet.getDataRange().getValues();
  const rentals = [];

  for (let i = 1; i < data.length; i++) {
    if (data[i][6] === '') {
      rentals.push({
        deviceId: data[i][1],
        deviceName: data[i][2],
        renter: data[i][3],
        cell: data[i][4],
        rentDate: asTimestampString_(data[i][5])
      });
    }
  }

  return { success: true, rentals: rentals };
}

/**
 * 시트 값을 읽되, 병합된 셀의 값을 병합 범위 내 모든 셀로 펼쳐서 반환
 */
function getExpandedValues(sheet) {
  const range = sheet.getDataRange();
  const values = range.getValues();
  const mergedRanges = range.getMergedRanges();
  const baseRow = range.getRow();
  const baseCol = range.getColumn();

  for (const mr of mergedRanges) {
    const rOffset = mr.getRow() - baseRow;
    const cOffset = mr.getColumn() - baseCol;
    const numRows = mr.getNumRows();
    const numCols = mr.getNumColumns();
    const value = values[rOffset][cOffset];

    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < numCols; c++) {
        values[rOffset + r][cOffset + c] = value;
      }
    }
  }
  return values;
}

/**
 * 전체 디바이스 현황 조회 (대여 중 + 미대여 디바이스 모두)
 */
function getAllDeviceStatus() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rentSheet = ss.getSheetByName(SHEET_NAME);
  const deviceSheet = ss.getSheetByName(DEVICE_SHEET_NAME);

  const devices = [];
  const rentedMap = {};

  // 대여 기록에서 현재 대여 중인 디바이스 수집
  if (rentSheet) {
    const rentData = rentSheet.getDataRange().getValues();
    for (let i = 1; i < rentData.length; i++) {
      const deviceId = String(rentData[i][1]).trim();
      const returnDate = rentData[i][6];
      const isNotReturned = !returnDate || String(returnDate).trim() === '';

      if (isNotReturned && deviceId) {
        rentedMap[deviceId] = {
          deviceId: deviceId,
          deviceName: rentData[i][2],
          renter: rentData[i][3],
          cell: rentData[i][4],
          rentDate: asTimestampString_(rentData[i][5]),
          expiryDate: asTimestampString_(rentData[i][7]),
          status: 'rented'
        };
      }
    }
  }

  // 디바이스 목록 시트 — 컬럼=카테고리 레이아웃
  //   1행: 카테고리명 (A1=애플, B1=삼성, C1=기타, D1=노트북, ...)
  //   2행 이하: 각 컬럼 세로로 디바이스명
  const categories = [];
  if (deviceSheet) {
    const devData = deviceSheet.getDataRange().getValues();
    if (devData.length > 0) {
      const headers = devData[0];
      for (let c = 0; c < headers.length; c++) {
        const category = String(headers[c] || '').trim();
        if (!category) continue;
        categories.push(category);
        for (let r = 1; r < devData.length; r++) {
          const deviceName = String(devData[r][c] || '').trim();
          if (!deviceName) continue;

          const deviceId = deviceName;

          if (rentedMap[deviceId]) {
            const dev = rentedMap[deviceId];
            dev.category = category;
            devices.push(dev);
            delete rentedMap[deviceId];
          } else {
            devices.push({
              deviceId: deviceId,
              deviceName: deviceName,
              category: category,
              renter: '',
              cell: '',
              rentDate: '',
              status: 'available'
            });
          }
        }
      }
    }
  }

  // 디바이스 목록에 없지만 대여 중인 디바이스도 포함
  for (const id in rentedMap) {
    devices.push(rentedMap[id]);
  }

  return { success: true, devices: devices, categories: categories };
}

/**
 * 만료/연체 점검 — 시간 트리거로 호출
 *
 * ENFORCE_HOUR=1 (운영): 달력 일자 + 시간대 제약
 *  - 사전 알림: 만료 하루 전(dayDiff=-1) · 10시대
 *  - 만료 알림: 실제 만료 시각 직후 (msUntilExpiry ≤ 0)
 *  - 연체 알림: 만료 +1일(dayDiff=+1) · 10시대
 *  - 자동 반납: 만료 +2일 이상(dayDiff≥+2) · 12시대
 *
 * ENFORCE_HOUR≠1 (테스트): 분 단위 시간 기반 (스크립트 속성 값 사용)
 *  - 사전 알림: 만료 PRE_ALERT_BEFORE_MIN 이내
 *  - 만료 알림: 실제 만료 시각 직후
 *  - 연체 알림: 만료 후 OVERDUE_INTERVAL_MIN 경과
 *  - 자동 반납: 만료 후 AUTO_RETURN_AFTER_MIN 경과
 */
function checkExpiringRentals() {
  // 트리거 다중 소유로 인한 동시 실행 방지 — 5초 대기 후 못 잡으면 skip
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (e) {
    Logger.log('checkExpiringRentals: 다른 트리거가 점유 중 — skip');
    return;
  }

  try {
    _checkExpiringRentalsImpl();
  } finally {
    lock.releaseLock();
  }
}

function _checkExpiringRentalsImpl() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;

  const now = new Date();
  const tz = Session.getScriptTimeZone();
  const hourNow = parseInt(Utilities.formatDate(now, tz, 'H'), 10);
  const enforceHour = isEnforceHour_();

  // 분 단위 임계값 (테스트 모드에서 사용)
  const preAlertBeforeMs = getPreAlertBeforeMs_();
  const overdueIntervalMs = getOverdueIntervalMs_();
  const autoReturnAfterMs = getAutoReturnAfterMs_();

  // 오늘 자정 기준 (달력 일자 비교용 — 운영 모드)
  const todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const todayCal = new Date(todayStr + 'T00:00:00');
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  // 알림 취합 버킷 — 트리거 1회당 종류별로 모아서 1개 메시지로 발송
  const buckets = { preExpiry: [], expired: [], overdue: [], autoReturn: [] };

  for (let i = 1; i < data.length; i++) {
    const row = i + 1;
    const returnDate = data[i][6];
    if (returnDate && String(returnDate).trim() !== '') continue;

    const expiryRaw = data[i][7];
    if (!expiryRaw) continue; // 만료일시 없는 구(舊) 데이터는 skip

    const expiryDate = parseSheetDate_(expiryRaw);
    if (!expiryDate) continue;

    const alertStage = Number(data[i][9]) || 0;
    const deviceName = data[i][2];
    const renter = data[i][3];
    const cell = data[i][4];
    const rentDate = data[i][5];

    const msUntilExpiry = expiryDate.getTime() - now.getTime();
    const msAfterExpiry = -msUntilExpiry;

    // 운영 모드에서만 사용 — 만료일 자정 기준 달력 차이
    const expiryDayStr = Utilities.formatDate(expiryDate, tz, 'yyyy-MM-dd');
    const expiryCal = new Date(expiryDayStr + 'T00:00:00');
    const dayDiff = Math.round((todayCal.getTime() - expiryCal.getTime()) / MS_PER_DAY);

    // === 1) 자동 반납 ===
    let shouldAutoReturn;
    if (enforceHour) {
      shouldAutoReturn = (dayDiff >= 2) && (hourNow === 12);
    } else {
      shouldAutoReturn = msAfterExpiry >= autoReturnAfterMs;
    }
    if (shouldAutoReturn) {
      const returnStr = formatTimestamp_(now);
      sheet.getRange(row, 7).setValue(returnStr);
      buckets.autoReturn.push({
        deviceName: deviceName, renterName: renter, cell: cell,
        rentDate: rentDate, expiryDate: expiryRaw, returnDate: returnStr
      });
      continue;
    }

    // === 2) 만료 알림 (실제 만료 시각 직후, 시간 제약 없음) ===
    if (msUntilExpiry <= 0 && alertStage < 2) {
      buckets.expired.push({
        deviceName: deviceName, renterName: renter, cell: cell,
        rentDate: rentDate, expiryDate: expiryRaw
      });
      sheet.getRange(row, 9).setValue(formatTimestamp_(now));
      sheet.getRange(row, 10).setValue(2);
      continue;
    }

    // === 3) 사전 알림 ===
    let shouldPreExpiry;
    if (enforceHour) {
      shouldPreExpiry = (dayDiff === -1) && (hourNow === 10) && (alertStage < 1);
    } else {
      shouldPreExpiry = (msUntilExpiry > 0) && (msUntilExpiry <= preAlertBeforeMs) && (alertStage < 1);
    }
    if (shouldPreExpiry) {
      buckets.preExpiry.push({
        deviceName: deviceName, renterName: renter, cell: cell,
        rentDate: rentDate, expiryDate: expiryRaw
      });
      sheet.getRange(row, 9).setValue(formatTimestamp_(now));
      sheet.getRange(row, 10).setValue(1);
      continue;
    }

    // === 4) 연체 알림 ===
    let shouldOverdue;
    if (enforceHour) {
      shouldOverdue = (dayDiff === 1) && (hourNow === 10) && (alertStage < 3);
    } else {
      shouldOverdue = (msAfterExpiry >= overdueIntervalMs) && (alertStage < 3);
    }
    if (shouldOverdue) {
      buckets.overdue.push({
        deviceName: deviceName, renterName: renter, cell: cell,
        rentDate: rentDate, expiryDate: expiryRaw, overdueDay: 1
      });
      sheet.getRange(row, 9).setValue(formatTimestamp_(now));
      sheet.getRange(row, 10).setValue(3);
      continue;
    }
  }

  // 종류별 1개 메시지로 발송 (해당 건수가 1개면 단일 알림과 동일한 모양)
  if (buckets.preExpiry.length)  sendKakaoWorkBatchNotification('preExpiry',  buckets.preExpiry);
  if (buckets.expired.length)    sendKakaoWorkBatchNotification('expired',    buckets.expired);
  if (buckets.overdue.length)    sendKakaoWorkBatchNotification('overdue',    buckets.overdue);
  if (buckets.autoReturn.length) sendKakaoWorkBatchNotification('autoReturn', buckets.autoReturn);
}

/**
 * 트리거 설치 — GAS 에디터에서 1회 실행
 * 운영: 1시간 주기 (ENFORCE_HOUR=1 일 때 10시/12시에만 실제 동작)
 * 테스트: 함수 내부의 .everyHours(1) → .everyMinutes(1) 로 변경 가능
 */
function installExpiryTrigger() {
  uninstallExpiryTrigger();
  ScriptApp.newTrigger('checkExpiringRentals')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('checkExpiringRentals 트리거가 1시간 주기로 설치되었습니다.');
}

/**
 * 트리거 제거
 */
function uninstallExpiryTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'checkExpiringRentals') {
      ScriptApp.deleteTrigger(t);
    }
  }
}

/**
 * 접속 인원 heartbeat 처리
 * - 클라이언트가 30초마다 sessionId를 보내면 timestamp 갱신
 * - 60초 이상 신호 없는 세션은 제거
 * - 현재 활성 세션 수를 반환
 */
const HEARTBEAT_PROP_KEY = 'activeSessions';
const HEARTBEAT_TTL_MS = 60 * 1000; // 60초

function processHeartbeat(data) {
  const sessionId = data && data.sessionId ? String(data.sessionId) : '';
  if (!sessionId) {
    return { success: false, message: 'sessionId가 필요합니다.' };
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (e) {
    return { success: false, message: '잠시 후 다시 시도해주세요.' };
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(HEARTBEAT_PROP_KEY);
    let sessions = {};
    if (raw) {
      try { sessions = JSON.parse(raw) || {}; } catch (e) { sessions = {}; }
    }

    const now = Date.now();

    // 만료된 세션 제거
    for (const id in sessions) {
      if (now - sessions[id] > HEARTBEAT_TTL_MS) {
        delete sessions[id];
      }
    }

    // 현재 세션 갱신
    sessions[sessionId] = now;

    props.setProperty(HEARTBEAT_PROP_KEY, JSON.stringify(sessions));

    return { success: true, count: Object.keys(sessions).length };
  } catch (err) {
    return { success: false, message: '오류: ' + err.toString() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 멘션 텍스트 생성 — 사용자목록에 매칭되는 사용자가 있으면 @이름 형식, 없으면 빈 문자열
 * 카카오워크 채널에서 @텍스트는 멘션으로 인식될 수 있다 (워크스페이스 설정에 따라).
 */
function buildMentionText_(renterName) {
  if (!renterName) return '';
  const user = findUserByName_(renterName);
  return user ? '@' + user.name : '';
}

/**
 * 카카오워크 종합 알림 (배치) — 동일 액션에 여러 건이 모인 경우 1개 메시지로 발송
 * action: preExpiry | expired | overdue | autoReturn
 * items: [{ deviceName, renterName, cell, rentDate, expiryDate, returnDate?, overdueDay? }, ...]
 */
function sendKakaoWorkBatchNotification(action, items) {
  if (!items || !items.length) return;
  const webhookUrl = getConfig_('KAKAOWORK_WEBHOOK_URL');
  if (!webhookUrl) return;
  const rentalStatusUrl = getConfig_('RENTAL_STATUS_URL');

  const formatDate = (v) => {
    if (!v) return '-';
    if (v instanceof Date) return formatTimestamp_(v);
    return String(v);
  };

  const headerByAction = {
    preExpiry:  { header: `⏰ 내일 만료 예정 (${items.length}건)`,     style: 'yellow', subjectTerm: '대여자', tag: '사전알림' },
    expired:    { header: `🔔 만료 (${items.length}건)`,               style: 'yellow', subjectTerm: '대여자', tag: '만료알림' },
    overdue:    { header: `🚨 연체 발생 (${items.length}건)`,          style: 'red',    subjectTerm: '대여자', tag: '연체' },
    autoReturn: { header: `⚠️ 자동 반납 처리 (${items.length}건)`,      style: 'red',    subjectTerm: '대여자', tag: '자동반납' }
  };
  const meta = headerByAction[action] || headerByAction.preExpiry;

  // 디바이스별 블록 — 단일 알림과 동일한 라벨별 description 양식
  const itemBlocks = [];
  items.forEach((it, idx) => {
    // 디바이스 사이 구분선 (첫 항목 제외)
    if (idx > 0) itemBlocks.push({ type: 'divider' });

    itemBlocks.push(
      { type: 'description', term: '디바이스',       content: { type: 'text', text: String(it.deviceName || '-'),   markdown: false }, accent: true },
      { type: 'description', term: meta.subjectTerm, content: { type: 'text', text: String(it.renterName || '-'),   markdown: false }, accent: true },
      { type: 'description', term: '셀',             content: { type: 'text', text: String(it.cell || '-'),         markdown: false }, accent: true },
      { type: 'description', term: '대여일시',       content: { type: 'text', text: formatDate(it.rentDate),        markdown: false }, accent: true }
    );

    if (action === 'autoReturn') {
      itemBlocks.push(
        { type: 'description', term: '만료일시', content: { type: 'text', text: formatDate(it.expiryDate), markdown: false }, accent: true },
        { type: 'description', term: '반납일시', content: { type: 'text', text: formatDate(it.returnDate), markdown: false }, accent: true }
      );
    } else {
      itemBlocks.push(
        { type: 'description', term: '만료일시', content: { type: 'text', text: formatDate(it.expiryDate), markdown: false }, accent: true }
      );
      if (action === 'overdue') {
        itemBlocks.push(
          { type: 'description', term: '연체', content: { type: 'text', text: `${it.overdueDay || 1}일차`, markdown: false }, accent: true }
        );
      }
    }
  });

  const fallbackText = `[${meta.tag} ${items.length}건] ` + items.map((it) => it.deviceName).join(', ');

  const blocks = [
    { type: 'header', text: meta.header, style: meta.style },
    { type: 'divider' },
    ...itemBlocks
  ];

  if (rentalStatusUrl) {
    blocks.push({
      type: 'button',
      text: '대여 현황 보기',
      style: 'default',
      action_type: 'open_system_browser',
      value: rentalStatusUrl
    });
  }

  const payload = { text: fallbackText, blocks: blocks };

  try {
    const response = UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    Logger.log('KakaoWork batch ' + action + ' status: ' + response.getResponseCode());
  } catch (err) {
    Logger.log('KakaoWork batch ' + action + ' failed: ' + err);
  }
}

/**
 * 카카오워크 Incoming Webhook 알림 전송 (Block Kit)
 * action: rent | return | renew | preExpiry | overdue | autoReturn
 */
function sendKakaoWorkNotification(action, info) {
  // 광고 ID 복사는 전용 메시지로 분기
  if (action === 'adIdCopy') {
    return sendAdIdCopyKakaoWorkMessage_(info);
  }

  const webhookUrl = getConfig_('KAKAOWORK_WEBHOOK_URL');
  if (!webhookUrl) return;
  const rentalStatusUrl = getConfig_('RENTAL_STATUS_URL');

  const formatDate = (v) => {
    if (!v) return '-';
    if (v instanceof Date) {
      return formatTimestamp_(v);
    }
    return String(v);
  };

  const rentDateStr = formatDate(info.rentDate);
  const returnDateStr = formatDate(info.returnDate);
  const expiryDateStr = formatDate(info.expiryDate);

  // 액션별 메타 정의
  const metaByAction = {
    rent:       { header: '디바이스 대여',           style: 'blue',   subjectTerm: '대여자',   tag: '대여' },
    return:     { header: '디바이스 반납',           style: 'yellow', subjectTerm: '반납자',   tag: '반납' },
    renew:      { header: '디바이스 갱신',           style: 'blue',   subjectTerm: '대여자',   tag: '갱신' },
    preExpiry:  { header: '⏰ 내일 만료 예정',       style: 'yellow', subjectTerm: '대여자',   tag: '사전알림' },
    expired:    { header: '🔔 만료',                 style: 'yellow', subjectTerm: '대여자',   tag: '만료알림' },
    overdue:    { header: `🚨 연체 ${info.overdueDay || ''}일차 갱신/반납 필요`.trim(), style: 'red', subjectTerm: '대여자', tag: '연체' },
    autoReturn: { header: '⚠️ 자동 반납 처리됨',      style: 'red',    subjectTerm: '대여자',   tag: '자동반납' }
  };
  const meta = metaByAction[action] || metaByAction.rent;

  const fallbackText = `[${meta.tag}] ${info.deviceName} — ${info.renterName}${info.cell ? ' (' + info.cell + ')' : ''}`;

  // 공통 필드
  const descriptions = [
    { type: 'description', term: '디바이스', content: { type: 'text', text: String(info.deviceName), markdown: false }, accent: true },
    { type: 'description', term: meta.subjectTerm, content: { type: 'text', text: String(info.renterName), markdown: false }, accent: true },
    { type: 'description', term: '셀', content: { type: 'text', text: String(info.cell || '-'), markdown: false }, accent: true },
    { type: 'description', term: '대여일시', content: { type: 'text', text: rentDateStr, markdown: false }, accent: true }
  ];

  // 액션별 추가 필드
  if (action === 'return' || action === 'autoReturn') {
    descriptions.push({ type: 'description', term: '반납일시', content: { type: 'text', text: returnDateStr, markdown: false }, accent: true });
  }
  if (action === 'rent' || action === 'renew' || action === 'preExpiry' || action === 'overdue') {
    descriptions.push({ type: 'description', term: '만료일시', content: { type: 'text', text: expiryDateStr, markdown: false }, accent: true });
  }
  if (action === 'preExpiry') {
    descriptions.push({ type: 'description', term: '안내', content: { type: 'text', text: '계속 사용하려면 QR을 다시 찍어 갱신해주세요.', markdown: false }, accent: false });
  }
  if (action === 'overdue') {
    descriptions.push({ type: 'description', term: '안내', content: { type: 'text', text: '만료가 지났습니다. 갱신 또는 반납이 필요합니다.', markdown: false }, accent: false });
  }
  if (action === 'autoReturn') {
    descriptions.push({ type: 'description', term: '사유', content: { type: 'text', text: '3일 경과 후 자동 반납 처리되었습니다.', markdown: false }, accent: false });
  }

  const blocks = [
    { type: 'header', text: meta.header, style: meta.style },
    { type: 'divider' },
    ...descriptions
  ];

  if (rentalStatusUrl) {
    blocks.push({
      type: 'button',
      text: '대여 현황 보기',
      style: 'default',
      action_type: 'open_system_browser',
      value: rentalStatusUrl
    });
  }

  const payload = { text: fallbackText, blocks: blocks };

  try {
    const response = UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    Logger.log('KakaoWork webhook status: ' + response.getResponseCode());
    Logger.log('KakaoWork webhook body: ' + response.getContentText());
  } catch (err) {
    Logger.log('KakaoWork webhook failed: ' + err);
  }
}

/**
 * 웹훅 디버깅용 - Apps Script 에디터에서 직접 실행
 * 1) testKakaoWorkPlain — 단순 text만 전송 (가장 기본)
 * 2) testKakaoWorkBlocks — Block Kit 전송
 * 실행 후 '실행 기록(Executions)'에서 상태코드/응답 확인
 */
function testKakaoWorkPlain() {
  const webhookUrl = getConfig_('KAKAOWORK_WEBHOOK_URL');
  if (!webhookUrl) {
    Logger.log('KAKAOWORK_WEBHOOK_URL 스크립트 속성이 설정되지 않았습니다.');
    return;
  }
  const res = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    payload: JSON.stringify({ text: '디바이스 알림 테스트 (plain)' }),
    muteHttpExceptions: true
  });
  Logger.log('status=' + res.getResponseCode() + ' body=' + res.getContentText());
}

function testKakaoWorkBlocks() {
  sendKakaoWorkNotification('rent', {
    deviceName: '테스트 디바이스',
    renterName: '홍길동',
    cell: '1셀',
    rentDate: '2026-04-20 10:00:00'
  });
}

/**
 * 현재 GAS 동작 모드 진단 — 운영/테스트 어느 쪽인지 확실히 확인
 * 실행 후 Cloud 로그에서 결과 확인
 */
function diagnoseMode() {
  const enforceHourRaw = getConfig_('ENFORCE_HOUR');
  const enforceHour = isEnforceHour_();
  const mode = enforceHour ? '⚠️ 운영 모드 (달력 일자 기준 — 10시/12시에만 발사)' : '✅ 테스트 모드 (분 단위 즉시 발사)';

  Logger.log('================================================');
  Logger.log('GAS 동작 모드 진단');
  Logger.log('================================================');
  Logger.log('ENFORCE_HOUR 속성값 (raw): "' + enforceHourRaw + '"');
  Logger.log('isEnforceHour_() 반환: ' + enforceHour);
  Logger.log('현재 모드: ' + mode);
  Logger.log('------------------------------------------------');
  Logger.log('RENTAL_DURATION_MIN     : ' + getMinutesConfig_('RENTAL_DURATION_MIN') + '분');
  Logger.log('PRE_ALERT_BEFORE_MIN    : ' + getMinutesConfig_('PRE_ALERT_BEFORE_MIN') + '분');
  Logger.log('OVERDUE_INTERVAL_MIN    : ' + getMinutesConfig_('OVERDUE_INTERVAL_MIN') + '분');
  Logger.log('AUTO_RETURN_AFTER_MIN   : ' + getMinutesConfig_('AUTO_RETURN_AFTER_MIN') + '분');
  Logger.log('------------------------------------------------');
  Logger.log('KAKAOWORK_WEBHOOK_URL 설정됨: ' + !!getConfig_('KAKAOWORK_WEBHOOK_URL'));
  Logger.log('RENTAL_STATUS_URL    설정됨: ' + !!getConfig_('RENTAL_STATUS_URL'));
  Logger.log('================================================');

  if (enforceHour) {
    Logger.log('🚨 운영 모드입니다! 테스트하려면 ENFORCE_HOUR 속성을 삭제하거나 0으로 변경하세요.');
  } else {
    Logger.log('✅ 테스트 모드 정상. 분 단위로 알림이 발사돼야 합니다.');
  }
}

/**
 * 시트 상태와 알림 조건 매칭 진단
 * 시트에서 활성 대여건(G 비어있음)을 모두 읽고, 각 행에 대해 어떤 알림 조건이 매칭되는지 보여줌
 * 실행 후 Cloud 로그 확인
 */
function debugExpiryCheck() {
  Logger.log('================================================');
  Logger.log('만료/연체 점검 디버그 — 시트 상태 + 조건 매칭');
  Logger.log('================================================');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    Logger.log('대여기록 시트가 없습니다.');
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    Logger.log('대여기록이 비어있습니다.');
    return;
  }

  const now = new Date();
  const enforceHour = isEnforceHour_();
  const preAlertBeforeMs = getPreAlertBeforeMs_();
  const overdueIntervalMs = getOverdueIntervalMs_();
  const autoReturnAfterMs = getAutoReturnAfterMs_();

  Logger.log('현재 시각: ' + formatTimestamp_(now));
  Logger.log('모드: ' + (enforceHour ? '⚠️ 운영' : '✅ 테스트'));
  Logger.log('임계값: PRE=' + (preAlertBeforeMs/60000) + '분, OVERDUE=' + (overdueIntervalMs/60000) + '분, AUTO=' + (autoReturnAfterMs/60000) + '분');
  Logger.log('------------------------------------------------');

  let activeCount = 0;
  for (let i = 1; i < data.length; i++) {
    const row = i + 1;
    const returnDate = data[i][6];
    const isNotReturned = !returnDate || String(returnDate).trim() === '';
    if (!isNotReturned) continue;

    activeCount++;
    const expiryRaw = data[i][7];
    const alertStage = Number(data[i][9]) || 0;
    const deviceName = data[i][2];

    Logger.log('▶ 행 ' + row + ': ' + deviceName);

    if (!expiryRaw) {
      Logger.log('  ⚠️ 만료일시 없음 — skip');
      continue;
    }
    const expiryDate = parseSheetDate_(expiryRaw);
    if (!expiryDate) {
      Logger.log('  ⚠️ 만료일시 파싱 실패: ' + expiryRaw);
      continue;
    }
    const msUntilExpiry = expiryDate.getTime() - now.getTime();
    const msAfterExpiry = -msUntilExpiry;

    Logger.log('  만료일시: ' + formatTimestamp_(expiryDate));
    Logger.log('  만료까지: ' + Math.round(msUntilExpiry/1000) + '초 (만료 후 경과: ' + Math.round(msAfterExpiry/1000) + '초)');
    Logger.log('  알림단계(J): ' + alertStage);

    if (enforceHour) {
      Logger.log('  (운영 모드 — 달력 기준 로직 적용)');
    } else {
      const shouldPreExpiry = (msUntilExpiry > 0) && (msUntilExpiry <= preAlertBeforeMs) && (alertStage < 1);
      const shouldExpired = (msUntilExpiry <= 0) && (alertStage < 2);
      const shouldOverdue = (msAfterExpiry >= overdueIntervalMs) && (alertStage < 3);
      const shouldAutoReturn = msAfterExpiry >= autoReturnAfterMs;
      Logger.log('  → 사전알림 발사? ' + shouldPreExpiry);
      Logger.log('  → 만료알림 발사? ' + shouldExpired);
      Logger.log('  → 연체알림 발사? ' + shouldOverdue);
      Logger.log('  → 자동반납 발사? ' + shouldAutoReturn);
      const wouldFire = shouldAutoReturn ? '⚠️ autoReturn' : shouldExpired ? '🔔 expired' : shouldPreExpiry ? '⏰ preExpiry' : shouldOverdue ? '🚨 overdue' : '(없음)';
      Logger.log('  ✅ 발사될 알림: ' + wouldFire);
    }
    Logger.log('  --');
  }

  Logger.log('================================================');
  Logger.log('활성 대여건 총 ' + activeCount + '개');
  Logger.log('================================================');
}

/**
 * 광고 ID 복사 알림 단독 테스트 — 앱에서 복사 버튼 누른 것과 동일한 동작
 * Apps Script에서 직접 실행해서 카카오워크에 메시지가 도착하는지 확인
 *
 * 결과:
 *  - 카카오워크 채널에 '🏷️ GAID 공유' 메시지 도착 → notifyAdIdCopy 흐름 정상
 *  - 도착 안 함 → sendAdIdCopyKakaoWorkMessage_ 단계에서 문제
 */
function testNotifyAdIdCopy() {
  Logger.log('=== testNotifyAdIdCopy 시작 ===');
  const fakeData = {
    userName: '윤창식',
    platform: 'android',
    deviceName: '갤럭시S23',
    modelCode: 'SM-S931N',
    adId: '12345678-1234-1234-1234-123456789ABC',
    limitAdTracking: false,
    authStatus: 'authorized'
  };
  const result = processNotifyAdIdCopy(fakeData);
  Logger.log('processNotifyAdIdCopy 반환: ' + JSON.stringify(result));
  Logger.log('=== 완료 — 카카오워크 채널 확인 ===');
}

/**
 * doPost 자체를 시뮬레이션 — 앱에서 fetch 호출한 것과 동일하게 흉내
 * 실제 앱의 요청이 GAS에 도달하지 못하는지를 GAS 측면에서 검증
 */
function testDoPostSimulation() {
  Logger.log('=== doPost 시뮬레이션 ===');
  const fakeEvent = {
    postData: {
      contents: JSON.stringify({
        action: 'notifyAdIdCopy',
        userName: '윤창식',
        platform: 'android',
        deviceName: '갤럭시S23',
        modelCode: 'SM-S931N',
        adId: '12345678-1234-1234-1234-123456789ABC',
        limitAdTracking: false,
        authStatus: 'authorized'
      })
    }
  };
  const response = doPost(fakeEvent);
  const responseText = response.getContent();
  Logger.log('doPost 응답: ' + responseText);
  Logger.log('=== 완료 — 카카오워크 + 응답 확인 ===');
}

/**
 * 배치 메시지 양식 4종 단독 테스트
 * 실제 시트 행 없이도 카카오워크에 배치 메시지가 정상 발송되는지 확인
 * 실행 후 카카오워크 채널에서 4개 메시지가 도착하는지 보기
 */
function testKakaoWorkBatch() {
  const fakeItem = {
    deviceName: '테스트S23',
    renterName: '홍길동',
    cell: 'A-1',
    rentDate: '2026-06-07 17:00:00',
    expiryDate: '2026-06-07 17:03:00',
    returnDate: '2026-06-07 17:07:00',
    overdueDay: 1
  };
  Logger.log('--- testKakaoWorkBatch: preExpiry ---');
  sendKakaoWorkBatchNotification('preExpiry', [fakeItem]);
  Logger.log('--- testKakaoWorkBatch: expired ---');
  sendKakaoWorkBatchNotification('expired', [fakeItem]);
  Logger.log('--- testKakaoWorkBatch: overdue ---');
  sendKakaoWorkBatchNotification('overdue', [fakeItem]);
  Logger.log('--- testKakaoWorkBatch: autoReturn ---');
  sendKakaoWorkBatchNotification('autoReturn', [fakeItem]);
  Logger.log('--- testKakaoWorkBatch: 완료 ---');
}

/**
 * 로그인 처리 — 사용자목록 시트에서 아이디 매칭
 *   입력: { action: 'login', userId }
 *   응답: { success, user: { userId, name, role, kakaoworkEmail } } | { success: false, message }
 */
function processLogin(data) {
  const userId = (data && data.userId || '').toString().trim();
  if (!userId) return { success: false, message: '아이디를 입력해주세요.' };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(USER_SHEET_NAME);
  if (!sheet) {
    return { success: false, message: '사용자목록 시트가 없습니다. initialSetup을 먼저 실행하세요.' };
  }
  ensureUserColumns_(sheet);

  const values = sheet.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    const rowId = String(values[r][0] || '').trim();
    if (rowId === userId) {
      const name = String(values[r][1] || '').trim() || userId;
      const email = String(values[r][2] || '').trim();
      const role = (String(values[r][3] || '').trim() || ROLE_USER).toLowerCase();

      // 최근 로그인 갱신
      sheet.getRange(r + 1, 6).setValue(formatTimestamp_(new Date()));

      return {
        success: true,
        user: { userId: rowId, name: name, role: role, kakaoworkEmail: email }
      };
    }
  }

  return { success: false, message: '등록되지 않은 아이디입니다.' };
}

/**
 * 디바이스 바인딩 — 폰 고유ID ↔ 디바이스명 매핑 저장
 *   입력: { action: 'bindDevice', uniqueId, deviceName, platform?, modelCode? }
 *   응답: { success, device } | { success: false, message }
 */
function processBindDevice(data) {
  const uniqueId   = (data && data.uniqueId   || '').toString().trim();
  const deviceName = (data && data.deviceName || '').toString().trim();
  const platform   = (data && data.platform   || '').toString().trim();
  const modelCode  = (data && data.modelCode  || '').toString().trim();

  if (!uniqueId)   return { success: false, message: '고유ID가 필요합니다.' };
  if (!deviceName) return { success: false, message: '디바이스명이 필요합니다.' };

  // 디바이스목록 시트에 해당 디바이스명이 존재하는지 검증
  const info = getDeviceInfo(deviceName);
  if (!info.success) {
    return { success: false, message: '디바이스목록에 등록되지 않은 디바이스명입니다: ' + deviceName };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(BINDING_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(BINDING_SHEET_NAME);
    sheet.getRange(1, 1, 1, 5).setValues([[
      '디바이스고유ID', '디바이스명', '플랫폼', '모델코드', '등록일시'
    ]]);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  ensureBindingColumns_(sheet);

  const values = sheet.getDataRange().getValues();
  const now = formatTimestamp_(new Date());

  // 기존 바인딩 있으면 업데이트
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][0] || '').trim() === uniqueId) {
      sheet.getRange(r + 1, 2).setValue(deviceName);
      sheet.getRange(r + 1, 3).setValue(platform);
      sheet.getRange(r + 1, 4).setValue(modelCode);
      sheet.getRange(r + 1, 5).setValue(now);
      return { success: true, device: { uniqueId, deviceName, category: info.category, platform, modelCode } };
    }
  }

  // 신규 추가
  sheet.appendRow([uniqueId, deviceName, platform, modelCode, now]);
  return { success: true, device: { uniqueId, deviceName, category: info.category, platform, modelCode } };
}

/**
 * 고유ID로 디바이스 정보 조회 (바인딩 + 현재 대여 상태)
 *   입력: { action: 'resolveDevice', uniqueId }
 *   응답: { success, bound: true, device: { uniqueId, deviceName, category, currentRental } }
 *         또는 { success, bound: false } (미바인딩 — 등록 화면으로 유도)
 */
function processResolveDevice(data) {
  const uniqueId = (data && data.uniqueId || '').toString().trim();
  if (!uniqueId) return { success: false, message: '고유ID가 필요합니다.' };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(BINDING_SHEET_NAME);
  if (!sheet) return { success: true, bound: false };

  const values = sheet.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][0] || '').trim() === uniqueId) {
      const deviceName = String(values[r][1] || '').trim();
      const platform   = String(values[r][2] || '').trim();
      const modelCode  = String(values[r][3] || '').trim();
      const info       = getDeviceInfo(deviceName);
      const rental     = findCurrentRental(deviceName);
      return {
        success: true,
        bound: true,
        device: {
          uniqueId: uniqueId,
          deviceName: deviceName,
          category: info.success ? info.category : '',
          platform: platform,
          modelCode: modelCode,
          currentRental: rental.isRented ? rental : null
        }
      };
    }
  }

  return { success: true, bound: false };
}

/**
 * 디바이스 바인딩 목록 조회 — 등록 화면에서 중복 방지용
 *   응답: { success, bindings: [{ uniqueId, deviceName }] }
 */
function processListBindings(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(BINDING_SHEET_NAME);
  if (!sheet) return { success: true, bindings: [] };

  const values = sheet.getDataRange().getValues();
  const bindings = [];
  for (let r = 1; r < values.length; r++) {
    const uniqueId   = String(values[r][0] || '').trim();
    const deviceName = String(values[r][1] || '').trim();
    if (uniqueId && deviceName) bindings.push({ uniqueId, deviceName });
  }
  return { success: true, bindings: bindings };
}

/**
 * 푸시 토큰 등록 — 로그인된 사용자에게 푸시 토큰 매핑
 *   입력: { action: 'registerPushToken', userId, pushToken }
 *   응답: { success } | { success: false, message }
 */
function processRegisterPushToken(data) {
  const userId    = (data && data.userId    || '').toString().trim();
  const pushToken = (data && data.pushToken || '').toString().trim();
  if (!userId)    return { success: false, message: '사용자 아이디가 필요합니다.' };
  if (!pushToken) return { success: false, message: '푸시 토큰이 필요합니다.' };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(USER_SHEET_NAME);
  if (!sheet) return { success: false, message: '사용자목록 시트가 없습니다.' };
  ensureUserColumns_(sheet);

  const values = sheet.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][0] || '').trim() === userId) {
      sheet.getRange(r + 1, 5).setValue(pushToken);
      return { success: true };
    }
  }
  return { success: false, message: '등록되지 않은 사용자입니다.' };
}

/**
 * 푸시 토큰 조회 (단일 사용자)
 */
function getPushTokenByUserId_(userId) {
  if (!userId) return '';
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(USER_SHEET_NAME);
  if (!sheet) return '';
  const values = sheet.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][0] || '').trim() === userId) {
      return String(values[r][4] || '').trim();
    }
  }
  return '';
}

/**
 * 사용자명(이름)으로 사용자 정보 조회 — 알림 멘션용
 *   사용자목록 시트의 '이름' 컬럼과 매칭
 */
function findUserByName_(name) {
  if (!name) return null;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(USER_SHEET_NAME);
  if (!sheet) return null;
  const values = sheet.getDataRange().getValues();
  const target = String(name).trim();
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][1] || '').trim() === target) {
      return {
        userId: String(values[r][0] || '').trim(),
        name: String(values[r][1] || '').trim(),
        email: String(values[r][2] || '').trim(),
        role: (String(values[r][3] || '').trim() || ROLE_USER).toLowerCase(),
        pushToken: String(values[r][4] || '').trim()
      };
    }
  }
  return null;
}

/**
 * 초기 설정 함수 - 처음 한 번만 실행
 */
function initialSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 대여기록 시트 생성
  let rentSheet = ss.getSheetByName(SHEET_NAME);
  if (!rentSheet) {
    rentSheet = ss.insertSheet(SHEET_NAME);
    rentSheet.getRange(1, 1, 1, 10).setValues([[
      '번호', '디바이스ID', '디바이스명', '대여자', '셀', '대여일시', '반납일시',
      '만료일시', '마지막알림', '알림단계'
    ]]);
    rentSheet.getRange(1, 1, 1, 10).setFontWeight('bold');
    rentSheet.setFrozenRows(1);

    // 열 너비 조정
    rentSheet.setColumnWidth(1, 60);
    rentSheet.setColumnWidth(2, 100);
    rentSheet.setColumnWidth(3, 150);
    rentSheet.setColumnWidth(4, 100);
    rentSheet.setColumnWidth(5, 60);
    rentSheet.setColumnWidth(6, 160);
    rentSheet.setColumnWidth(7, 160);
    rentSheet.setColumnWidth(8, 160);
    rentSheet.setColumnWidth(9, 160);
    rentSheet.setColumnWidth(10, 80);
  } else {
    ensureExpiryColumns_(rentSheet);
  }

  // 디바이스목록 시트 생성 (컬럼=카테고리 레이아웃)
  let deviceSheet = ss.getSheetByName(DEVICE_SHEET_NAME);
  if (!deviceSheet) {
    deviceSheet = ss.insertSheet(DEVICE_SHEET_NAME);
    deviceSheet.getRange(1, 1, 1, 4).setValues([['애플', '삼성', '기타', '노트북']]);
    deviceSheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    deviceSheet.setFrozenRows(1);

    // 열 너비 조정
    deviceSheet.setColumnWidth(1, 160);
    deviceSheet.setColumnWidth(2, 160);
    deviceSheet.setColumnWidth(3, 160);
    deviceSheet.setColumnWidth(4, 160);
  }

  // 사용자목록 시트 생성
  let userSheet = ss.getSheetByName(USER_SHEET_NAME);
  if (!userSheet) {
    userSheet = ss.insertSheet(USER_SHEET_NAME);
    userSheet.getRange(1, 1, 1, 6).setValues([[
      '아이디', '이름', '카카오워크이메일', '권한', '푸시토큰', '최근로그인'
    ]]);
    userSheet.getRange(1, 1, 1, 6).setFontWeight('bold');
    userSheet.setFrozenRows(1);
    userSheet.setColumnWidth(1, 120);
    userSheet.setColumnWidth(2, 100);
    userSheet.setColumnWidth(3, 200);
    userSheet.setColumnWidth(4, 80);
    userSheet.setColumnWidth(5, 280);
    userSheet.setColumnWidth(6, 160);

    // 관리자 샘플 행
    userSheet.appendRow(['0000', '관리자', '', ROLE_ADMIN, '', '']);
  } else {
    ensureUserColumns_(userSheet);
  }

  // 디바이스바인딩 시트 생성 (고유ID ↔ 디바이스명)
  let bindingSheet = ss.getSheetByName(BINDING_SHEET_NAME);
  if (!bindingSheet) {
    bindingSheet = ss.insertSheet(BINDING_SHEET_NAME);
    bindingSheet.getRange(1, 1, 1, 5).setValues([[
      '디바이스고유ID', '디바이스명', '플랫폼', '모델코드', '등록일시'
    ]]);
    bindingSheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    bindingSheet.setFrozenRows(1);
    bindingSheet.setColumnWidth(1, 240);
    bindingSheet.setColumnWidth(2, 180);
    bindingSheet.setColumnWidth(3, 80);
    bindingSheet.setColumnWidth(4, 140);
    bindingSheet.setColumnWidth(5, 160);
  } else {
    ensureBindingColumns_(bindingSheet);
  }

  // UI 컨텍스트가 있을 때만 알림창 표시 (편집기에서 직접 실행 시 컨텍스트가 없을 수 있음)
  try {
    SpreadsheetApp.getUi().alert('초기 설정이 완료되었습니다!');
  } catch (e) {
    Logger.log('initialSetup 완료 (UI 컨텍스트 없음 — 정상 종료)');
  }
}

/**
 * 사용자목록 시트 컬럼 보정
 */
function ensureUserColumns_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol >= 6) return;
  const allHeaders = ['아이디', '이름', '카카오워크이메일', '권한', '푸시토큰', '최근로그인'];
  const newHeaders = allHeaders.slice(lastCol);
  sheet.getRange(1, lastCol + 1, 1, newHeaders.length).setValues([newHeaders]);
  sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
}

/**
 * 디바이스바인딩 시트 컬럼 보정
 */
function ensureBindingColumns_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol >= 5) return;
  const allHeaders = ['디바이스고유ID', '디바이스명', '플랫폼', '모델코드', '등록일시'];
  const newHeaders = allHeaders.slice(lastCol);
  sheet.getRange(1, lastCol + 1, 1, newHeaders.length).setValues([newHeaders]);
  sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
}
