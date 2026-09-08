package com.gustavomiranda.wispbot;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WispSecureSessionPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
