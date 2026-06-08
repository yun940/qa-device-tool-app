import UIKit
import Capacitor

/**
 * CAPBridgeViewController 서브클래스 — 인라인 커스텀 플러그인을 명시적으로 등록
 *
 * Capacitor 6에서 인라인 커스텀 플러그인은 Swift CAPBridgedPlugin 자동 검색이 동작하지 않을 수 있어,
 * 여기서 bridge.registerPluginInstance()로 직접 등록한다.
 */
class CustomBridgeViewController: CAPBridgeViewController {

    override open func capacitorDidLoad() {
        NSLog("[CustomBridgeViewController] capacitorDidLoad — AdIdPlugin 등록 시도")
        if let bridge = self.bridge {
            bridge.registerPluginInstance(AdIdPlugin())
            NSLog("[CustomBridgeViewController] AdIdPlugin 등록 완료 ✅")
        } else {
            NSLog("[CustomBridgeViewController] bridge가 nil ❌")
        }
    }
}
