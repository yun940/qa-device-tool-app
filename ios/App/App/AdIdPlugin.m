#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// AdIdPlugin을 Capacitor 런타임에 등록 — Swift CAPBridgedPlugin 자동 등록이 인라인 플러그인에선 동작 안 해서
// 이 매크로로 명시적 등록 필요
CAP_PLUGIN(AdIdPlugin, "AdId",
    CAP_PLUGIN_METHOD(getAdvertisingId, CAPPluginReturnPromise);
)
