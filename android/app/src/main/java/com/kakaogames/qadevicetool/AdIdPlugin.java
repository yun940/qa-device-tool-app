package com.kakaogames.qadevicetool;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.ads.identifier.AdvertisingIdClient;

/**
 * AdId 플러그인 — Google Advertising ID(GAID) 반환
 * Google Play Services에서 비동기로 가져오므로 백그라운드 스레드에서 실행.
 * 사용자가 광고 ID를 재설정/삭제했으면 limitAdTracking=true 반환.
 */
@CapacitorPlugin(name = "AdId")
public class AdIdPlugin extends Plugin {

    @PluginMethod
    public void getAdvertisingId(PluginCall call) {
        new Thread(() -> {
            JSObject ret = new JSObject();
            try {
                AdvertisingIdClient.Info info = AdvertisingIdClient.getAdvertisingIdInfo(getContext());
                String id = info.getId() != null ? info.getId() : "";
                boolean limited = info.isLimitAdTrackingEnabled();
                ret.put("id", id);
                ret.put("limitAdTracking", limited);
                ret.put("authStatus", limited ? "denied" : "authorized");
            } catch (Exception e) {
                ret.put("id", "");
                ret.put("limitAdTracking", true);
                ret.put("authStatus", "error");
                ret.put("error", e.getMessage());
            }
            call.resolve(ret);
        }).start();
    }
}
