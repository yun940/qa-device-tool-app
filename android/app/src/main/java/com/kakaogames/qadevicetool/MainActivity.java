package com.kakaogames.qadevicetool;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AdIdPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
