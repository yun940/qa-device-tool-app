package com.kakaogames.qadevicetool;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.lang.reflect.Method;

/**
 * DeviceName 플러그인 — 시스템 마케팅명 반환
 * Android 12+ 부터 ro.product.marketname 표준 속성. 삼성 One UI에서 잘 채워짐.
 * 다른 제조사는 비어있을 수 있어 빈 문자열 반환 → 클라이언트에서 매핑 테이블 폴백.
 *
 * SystemProperties는 hidden API라 reflection으로 호출.
 * SDK whitelist에 포함되어 있어 Android 9+ 에서도 동작.
 */
@CapacitorPlugin(name = "DeviceName")
public class DeviceNamePlugin extends Plugin {

    private static String getSystemProperty(String key) {
        try {
            Class<?> sysProp = Class.forName("android.os.SystemProperties");
            Method get = sysProp.getMethod("get", String.class, String.class);
            Object result = get.invoke(null, key, "");
            return result != null ? result.toString() : "";
        } catch (Exception e) {
            return "";
        }
    }

    @PluginMethod
    public void getMarketName(PluginCall call) {
        JSObject ret = new JSObject();
        String name = getSystemProperty("ro.product.marketname");
        if (name.isEmpty()) name = getSystemProperty("ro.product.vendor.marketname");
        if (name.isEmpty()) name = getSystemProperty("ro.product.odm.marketname");
        ret.put("marketName", name);
        call.resolve(ret);
    }
}
