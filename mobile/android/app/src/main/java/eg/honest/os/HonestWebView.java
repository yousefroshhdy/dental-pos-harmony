package eg.honest.os;

import android.content.Context;
import android.util.AttributeSet;
import android.util.Log;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.CapConfig;
import com.getcapacitor.CapacitorWebView;
import com.getcapacitor.MessageHandler;
import java.util.Collections;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Capacitor's WebView with a guarded bridge (audit 4 F1). Used through the app's override of
 * Capacitor's layout (res/layout/capacitor_bridge_layout_main.xml); MainActivity refuses to
 * run with any other WebView.
 *
 * Why: the background-geolocation plugin needs `android.useLegacyBridge` (with the WebMessage
 * bridge, location callbacks stop after about 5 minutes in the background, plugin README and
 * its issue 89). Capacitor's legacy bridge registers its MessageHandler with
 * addJavascriptInterface, which exposes it to EVERY frame of EVERY origin, and its built-in
 * CapacitorCookies / CapacitorHttp plugins add two more such interfaces. Any iframe could then
 * call any plugin (start or stop tracking, plant cookies for the app origin).
 *
 * What: this WebView intercepts those registrations.
 * - The bridge ("androidBridge") is registered instead with addWebMessageListener, which the
 *   WebView exposes only to frames of the configured server origin, and every message is
 *   checked by {@link BridgePolicy}: top frame only, that origin only, the background-
 *   geolocation plugin's three methods only. Allowed messages go to Capacitor's own
 *   MessageHandler unchanged. Replies still use the legacy path (evaluateJavascript on the
 *   page, MessageHandler.legacySendResponseMessage), which is what keeps background location
 *   callbacks flowing.
 * - Every other JavaScript interface (CapacitorCookiesAndroidInterface,
 *   CapacitorHttpAndroidInterface) is refused. Capacitor's page script checks for them before
 *   use; both features are off in this app (their default).
 * - Fails closed: on a WebView too old for addWebMessageListener and document-start scripts
 *   (Android System WebView not updated for years), or without an https server URL, no bridge
 *   is exposed at all: the app is then a plain web client without native features.
 */
public class HonestWebView extends CapacitorWebView {

    static final String BRIDGE_NAME = "androidBridge";
    private static final String TAG = "HonestBridge";

    private boolean bridgeGuarded = false;

    public HonestWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    /** True once the guarded bridge is registered (false: no bridge is exposed at all). */
    public boolean isBridgeGuarded() {
        return bridgeGuarded;
    }

    @Override
    public void addJavascriptInterface(Object object, String name) {
        if (BRIDGE_NAME.equals(name) && object instanceof MessageHandler && !bridgeGuarded) {
            bridgeGuarded = installGuardedBridge((MessageHandler) object);
            return;
        }
        // Never call super: a JavaScript interface is reachable from every frame of every origin.
        Log.w(TAG, "Refused the JavaScript interface " + name);
    }

    private boolean installGuardedBridge(final MessageHandler handler) {
        // DOCUMENT_START_SCRIPT too: without it Capacitor fetches each page itself and drops its
        // security headers (CSP), so native features are not offered on such a WebView.
        if (
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        ) {
            Log.e(TAG, "Android System WebView is too old for the guarded bridge; native features are off. Update it from the Play Store.");
            return false;
        }
        final String allowedOrigin = BridgePolicy.origin(CapConfig.loadDefault(getContext()).getServerUrl());
        if (allowedOrigin == null) {
            Log.e(TAG, "server.url is not an https origin; native features are off.");
            return false;
        }
        try {
            WebViewCompat.addWebMessageListener(
                this,
                BRIDGE_NAME,
                Collections.singleton(allowedOrigin),
                (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                    String data = message.getData();
                    if (data == null) {
                        Log.w(TAG, "Refused a native call: not a text message");
                        return;
                    }
                    JSONObject json;
                    try {
                        json = new JSONObject(data);
                    } catch (JSONException ex) {
                        Log.w(TAG, "Refused a native call: not JSON");
                        return;
                    }
                    String refusal = BridgePolicy.refusal(
                        isMainFrame,
                        sourceOrigin == null ? null : sourceOrigin.toString(),
                        allowedOrigin,
                        field(json, "type"),
                        field(json, "pluginId"),
                        field(json, "methodName")
                    );
                    if (refusal != null) {
                        Log.w(TAG, "Refused a native call: " + refusal);
                        return;
                    }
                    // Exactly what was checked (one parse), not the raw text.
                    handler.postMessage(json.toString());
                }
            );
            return true;
        } catch (RuntimeException ex) {
            Log.e(TAG, "Could not register the guarded bridge; native features are off.", ex);
            return false;
        }
    }

    private static String field(JSONObject json, String name) {
        return json.isNull(name) ? null : json.optString(name);
    }
}
