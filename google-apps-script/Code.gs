/**
 * 디바이스 대여/반납 관리 시스템 - Google Apps Script
 * 이 코드를 Google Spreadsheet의 Apps Script에 붙여넣으세요.
 */

// 스프레드시트 설정
const SHEET_NAME = '대여기록';
const DEVICE_SHEET_NAME = '디바이스목록';

// 스크립트 속성에서 값을 읽음 (프로젝트 설정 > 스크립트 속성에서 등록)
// - KAKAOWORK_WEBHOOK_URL: 카카오워크 Incoming Webhook URL
// - RENTAL_STATUS_URL: 알림 버튼이 열 대여 현황 페이지 URL (미설정 시 버튼 숨김)
// - RENTAL_DURATION_MIN: 대여 기간(분). 테스트 기본 3, 운영 43200(30일)
// - PRE_ALERT_BEFORE_MIN: 사전 알림 시점(분). 테스트 기본 1, 운영 1440(24h)
// - OVERDUE_INTERVAL_MIN: 연체 알림 간격(분). 테스트 기본 1, 운영 1440(24h)
// - AUTO_RETURN_AFTER_MIN: 만료 후 자동 반납 시점(분). 테스트 기본 4, 운영 4440(3일 2h)
// - ENFORCE_HOUR: '1'이면 10시 알림/12시 자동반납 시각 제약 활성 (운영용)
function getConfig_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

// 대여 기간 관련 상수 도우미 — 테스트 기본값을 갖되 스크립트 속성으로 덮어쓸 수 있음
const DEFAULTS = {
  RENTAL_DURATION_MIN: 3,        // 운영 전환 시 43200(30일)
  PRE_ALERT_BEFORE_MIN: 1,       // 운영 1440(24h)
  OVERDUE_INTERVAL_MIN: 1,       // 운영 1440(24h)
  AUTO_RETURN_AFTER_MIN: 4       // 운영 4440(3일 2h) — 마지막 연체 알림 약 1단위 뒤
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
        rentDate: data[i][5],
        expiryDate: data[i][7] || ''
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
        rentDate: data[i][5]
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
          rentDate: rentData[i][5],
          expiryDate: rentData[i][7] || '',
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
 * 만료/연체 점검 — 1분(테스트)/시간(운영) 단위 시간 트리거로 호출
 * - 사전 알림: 만료까지 PRE_ALERT_BEFORE 이내 진입 시 1회
 * - 연체 알림: 만료 후 OVERDUE_INTERVAL 단위로 최대 3회
 * - 자동 반납: 만료 후 AUTO_RETURN_AFTER 경과 시 즉시 반납 + 알림
 * - ENFORCE_HOUR=1 이면 알림은 10시대, 자동반납은 12시대에만 발화
 */
function checkExpiringRentals() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;

  const now = new Date();
  const tz = Session.getScriptTimeZone();
  const hourNow = parseInt(Utilities.formatDate(now, tz, 'H'), 10);
  const enforceHour = isEnforceHour_();

  const preAlertMs = getPreAlertBeforeMs_();
  const overdueIntervalMs = getOverdueIntervalMs_();
  const autoReturnAfterMs = getAutoReturnAfterMs_();

  for (let i = 1; i < data.length; i++) {
    const row = i + 1;
    const returnDate = data[i][6];
    if (returnDate && String(returnDate).trim() !== '') continue;

    const expiryRaw = data[i][7];
    if (!expiryRaw) continue; // 만료일시 없는 구(舊) 데이터는 skip

    const expiryDate = parseSheetDate_(expiryRaw);
    if (!expiryDate) continue;

    const alertStage = Number(data[i][9]) || 0;
    const deviceId = data[i][1];
    const deviceName = data[i][2];
    const renter = data[i][3];
    const cell = data[i][4];
    const rentDate = data[i][5];

    const msUntilExpiry = expiryDate.getTime() - now.getTime();
    const msAfterExpiry = -msUntilExpiry;

    // 1) 자동 반납 우선 처리 (가장 마지막 상태)
    if (msAfterExpiry >= autoReturnAfterMs) {
      if (enforceHour && hourNow !== 12) continue; // 12시대에만
      const returnStr = formatTimestamp_(now);
      sheet.getRange(row, 7).setValue(returnStr);
      sendKakaoWorkNotification('autoReturn', {
        deviceName: deviceName, renterName: renter, cell: cell,
        rentDate: rentDate, expiryDate: expiryRaw, returnDate: returnStr
      });
      continue;
    }

    // 알림은 ENFORCE_HOUR 모드에서 10시대에만 발화
    if (enforceHour && hourNow !== 10) continue;

    // 2) 사전 알림 (stage 0 → 1)
    if (alertStage === 0 && msUntilExpiry > 0 && msUntilExpiry <= preAlertMs) {
      sendKakaoWorkNotification('preExpiry', {
        deviceName: deviceName, renterName: renter, cell: cell,
        rentDate: rentDate, expiryDate: expiryRaw
      });
      sheet.getRange(row, 9).setValue(formatTimestamp_(now));
      sheet.getRange(row, 10).setValue(1);
      continue;
    }

    // 3) 연체 알림 (만료 후) — stage 1/2/3 → 2/3/4
    if (msAfterExpiry > 0) {
      let nextStage = 0;
      if (alertStage <= 1 && msAfterExpiry >= overdueIntervalMs * 1) nextStage = 2;
      if (alertStage <= 2 && msAfterExpiry >= overdueIntervalMs * 2) nextStage = 3;
      if (alertStage <= 3 && msAfterExpiry >= overdueIntervalMs * 3) nextStage = 4;
      // 현재 단계보다 큰 단계만 진행 (한 번에 한 단계씩)
      if (nextStage > alertStage) {
        const day = nextStage - 1; // 1, 2, 3
        sendKakaoWorkNotification('overdue', {
          deviceName: deviceName, renterName: renter, cell: cell,
          rentDate: rentDate, expiryDate: expiryRaw, overdueDay: day
        });
        sheet.getRange(row, 9).setValue(formatTimestamp_(now));
        sheet.getRange(row, 10).setValue(nextStage);
      }
    }
  }
}

/**
 * 트리거 설치 — GAS 에디터에서 1회 실행
 * 기본 1분 주기. 운영 전환 시 함수 내부의 .everyMinutes(5)나 .everyHours(1)로 조정
 */
function installExpiryTrigger() {
  uninstallExpiryTrigger();
  ScriptApp.newTrigger('checkExpiringRentals')
    .timeBased()
    .everyMinutes(1)
    .create();
  Logger.log('checkExpiringRentals 트리거가 1분 주기로 설치되었습니다.');
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
 * 카카오워크 Incoming Webhook 알림 전송 (Block Kit)
 * action: rent | return | renew | preExpiry | overdue | autoReturn
 */
function sendKakaoWorkNotification(action, info) {
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
    rent:       { header: '디바이스 대여',         style: 'blue',   subjectTerm: '대여자',   tag: '대여' },
    return:     { header: '디바이스 반납',         style: 'yellow', subjectTerm: '반납자',   tag: '반납' },
    renew:      { header: '디바이스 갱신',         style: 'blue',   subjectTerm: '대여자',   tag: '갱신' },
    preExpiry:  { header: '⏰ 곧 만료 갱신 필요', style: 'yellow', subjectTerm: '대여자',   tag: '사전알림' },
    overdue:    { header: `🚨 연체 ${info.overdueDay || ''}일차 갱신/반납 필요`.trim(), style: 'red', subjectTerm: '대여자', tag: '연체' },
    autoReturn: { header: '⚠️ 자동 반납 처리됨',    style: 'red',    subjectTerm: '대여자',   tag: '자동반납' }
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

  SpreadsheetApp.getUi().alert('초기 설정이 완료되었습니다!');
}
