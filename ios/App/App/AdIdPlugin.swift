import Foundation
import Capacitor
import AdSupport
import AppTrackingTransparency

/**
 * AdId 플러그인 — IDFA(Identifier for Advertisers) 반환
 * iOS 14.5+ 에선 ATT 권한 요청 후, 허용 시에만 실제 IDFA 반환.
 * 거부/제한 시엔 "00000000-0000-0000-0000-000000000000" 반환.
 */
// 등록 방식 이중 적용 — .m의 CAP_PLUGIN 매크로(+load) + Swift CAPBridgedPlugin 둘 다
// Capacitor 6 인라인 플러그인은 하나만 쓰면 등록 실패할 수 있음
@objc(AdIdPlugin)
public class AdIdPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AdIdPlugin"
    public let jsName = "AdId"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getAdvertisingId", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        super.load()
        NSLog("[AdIdPlugin] load() 호출됨 — Capacitor가 플러그인 인스턴스화 완료")
    }

    @objc func getAdvertisingId(_ call: CAPPluginCall) {
        if #available(iOS 14.5, *) {
            ATTrackingManager.requestTrackingAuthorization { status in
                self.resolveWithStatus(call, status: status)
            }
        } else {
            // iOS 14.4 이하 — ASIdentifierManager의 옵션 직접 확인
            let mgr = ASIdentifierManager.shared()
            let idString = mgr.advertisingIdentifier.uuidString
            let limited: Bool
            if #available(iOS 14.0, *) {
                limited = false // 14.0~14.4: 자동 허용
            } else {
                limited = !mgr.isAdvertisingTrackingEnabled
            }
            call.resolve([
                "id": idString,
                "limitAdTracking": limited,
                "authStatus": "legacy"
            ])
        }
    }

    @available(iOS 14.5, *)
    private func resolveWithStatus(_ call: CAPPluginCall, status: ATTrackingManager.AuthorizationStatus) {
        let mgr = ASIdentifierManager.shared()
        let idString = mgr.advertisingIdentifier.uuidString
        let authStatusStr: String
        let limited: Bool
        switch status {
        case .authorized:
            authStatusStr = "authorized"
            limited = false
        case .denied:
            authStatusStr = "denied"
            limited = true
        case .restricted:
            authStatusStr = "restricted"
            limited = true
        case .notDetermined:
            authStatusStr = "notDetermined"
            limited = true
        @unknown default:
            authStatusStr = "unknown"
            limited = true
        }
        call.resolve([
            "id": idString,
            "limitAdTracking": limited,
            "authStatus": authStatusStr
        ])
    }
}
