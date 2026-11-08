package com.gultra.app;

import android.graphics.Color;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private static final int MAX_PAGE_RESTARTS = 3;
    private static final long PAGE_RESTART_WINDOW_MS = 60_000L;

    // Static because restarting the page recreates this activity.
    private static int pageRestarts = 0;
    private static long firstPageRestartAt = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        registerPlugin(GUltraPlugin.class);
        super.onCreate(savedInstanceState);

        // The UI runs edge to edge, under transparent system bars.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);

        WebView web = getBridge().getWebView();
        web.setBackgroundColor(Color.parseColor("#0b0c10"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);

        // Android ends the whole app when the page's process dies, unless the app takes over.
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                restartPage();
                return true;
            }
        });

        // The page goes back first: a sheet closes, another screen returns to Home.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                web.evaluateJavascript("window.gultraBack ? window.gultraBack() : false", (handled) -> {
                    if (!"true".equals(handled)) moveTaskToBack(true);
                });
            }
        });
    }

    // A page that keeps dying right after it loads shouldn't reload forever.
    private void restartPage() {
        long now = SystemClock.elapsedRealtime();
        if (now - firstPageRestartAt > PAGE_RESTART_WINDOW_MS) {
            firstPageRestartAt = now;
            pageRestarts = 0;
        }
        if (++pageRestarts > MAX_PAGE_RESTARTS) finish();
        else recreate();
    }
}
